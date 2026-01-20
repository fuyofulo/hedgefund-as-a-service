use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{mint_to, Mint, MintTo, Token, TokenAccount};

use crate::errors::ErrorCode;
use crate::state::fund::{FundState, FundVault, FUND_TYPE_TRADING};
use crate::state::global_config::GlobalConfig;
use crate::state::trading::Trading;

pub fn initialize_fund(
    ctx: Context<InitializeFund>,
    fund_id: u64,
    initial_deposit_lamports: u64,
    manager_fee_bps: u16,
    min_investor_deposit_lamports: u64,
    withdraw_timelock_secs: i64,
) -> Result<()> {
    require!(
        withdraw_timelock_secs >= ctx.accounts.config.min_withdraw_timelock_secs,
        ErrorCode::InvalidTimelock
    );
    require!(
        withdraw_timelock_secs <= ctx.accounts.config.max_withdraw_timelock_secs,
        ErrorCode::InvalidTimelock
    );
    require!(
        manager_fee_bps <= ctx.accounts.config.max_manager_fee_bps,
        ErrorCode::InvalidFeeBps
    );
    require!(
        initial_deposit_lamports >= ctx.accounts.config.min_manager_deposit_lamports,
        ErrorCode::DepositTooSmall
    );

    let config = &ctx.accounts.config;
    let fund = &mut ctx.accounts.fund_state;
    let fee_bps = config.deposit_fee_bps as u128;
    let fee_lamports = (initial_deposit_lamports as u128)
        .checked_mul(fee_bps)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(10_000)
        .ok_or(ErrorCode::MathOverflow)? as u64;
    let net_lamports = initial_deposit_lamports
        .checked_sub(fee_lamports)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(net_lamports > 0, ErrorCode::ZeroShares);

    fund.config = config.key();
    fund.manager = ctx.accounts.manager.key();
    fund.fund_id = fund_id;
    fund.fund_type = FUND_TYPE_TRADING;
    fund.share_mint = ctx.accounts.share_mint.key();
    fund.vault = ctx.accounts.fund_vault.key();
    fund.total_shares = net_lamports;
    fund.manager_fee_bps = manager_fee_bps;
    fund.min_investor_deposit_lamports = min_investor_deposit_lamports;
    fund.withdraw_timelock_secs = withdraw_timelock_secs;
    fund.enabled_token_count = 0;
    fund.active_limit_count = 0;
    fund.active_dca_count = 0;
    fund.next_order_id = 0;
    fund.bump = ctx.bumps.fund_state;
    fund.share_mint_bump = ctx.bumps.share_mint;
    fund.vault_bump = ctx.bumps.fund_vault;

    let fund_key = fund.key();
    let trading = &mut ctx.accounts.trading;
    trading.fund = fund_key;
    trading.is_locked = false;
    trading.borrow_amount = 0;
    trading.expected_min_out = 0;
    trading.snapshot_sol = 0;
    trading.snapshot_output = 0;
    trading.output_mint = Pubkey::default();
    trading.bump = ctx.bumps.trading;

    let transfer_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        anchor_lang::system_program::Transfer {
            from: ctx.accounts.manager.to_account_info(),
            to: ctx.accounts.fee_treasury.to_account_info(),
        },
    );
    if fee_lamports > 0 {
        anchor_lang::system_program::transfer(transfer_ctx, fee_lamports)?;
    }

    let vault_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        anchor_lang::system_program::Transfer {
            from: ctx.accounts.manager.to_account_info(),
            to: ctx.accounts.fund_vault.to_account_info(),
        },
    );
    anchor_lang::system_program::transfer(vault_ctx, net_lamports)?;

    let config_key = config.key();
    let manager_key = ctx.accounts.manager.key();
    let fund_id_bytes = fund_id.to_le_bytes();
    let signer_seeds: &[&[u8]] = &[
        b"fund",
        config_key.as_ref(),
        manager_key.as_ref(),
        fund_id_bytes.as_ref(),
        &[fund.bump],
    ];

    let signer_seeds_set = [signer_seeds];
    let mint_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        MintTo {
            mint: ctx.accounts.share_mint.to_account_info(),
            to: ctx.accounts.manager_share_account.to_account_info(),
            authority: ctx.accounts.fund_state.to_account_info(),
        },
        &signer_seeds_set,
    );
    mint_to(mint_ctx, net_lamports)?;

    Ok(())
}

#[derive(Accounts)]
#[instruction(fund_id: u64)]
pub struct InitializeFund<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,
    #[account(
        has_one = fee_treasury
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub fee_treasury: SystemAccount<'info>,
    #[account(
        init,
        payer = manager,
        space = 8 + FundState::LEN,
        seeds = [b"fund", config.key().as_ref(), manager.key().as_ref(), fund_id.to_le_bytes().as_ref()],
        bump
    )]
    pub fund_state: Account<'info, FundState>,
    #[account(
        init,
        payer = manager,
        space = 8 + Trading::LEN,
        seeds = [b"trading", fund_state.key().as_ref()],
        bump
    )]
    pub trading: Account<'info, Trading>,
    #[account(
        init,
        payer = manager,
        mint::decimals = 9,
        mint::authority = fund_state,
        seeds = [b"shares", fund_state.key().as_ref()],
        bump
    )]
    pub share_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = manager,
        associated_token::mint = share_mint,
        associated_token::authority = manager
    )]
    pub manager_share_account: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = manager,
        space = 8,
        seeds = [b"vault", fund_state.key().as_ref()],
        bump
    )]
    pub fund_vault: Account<'info, FundVault>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}
