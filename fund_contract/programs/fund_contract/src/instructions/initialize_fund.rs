use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{mint_to, Mint, MintTo, Token, TokenAccount};

use crate::errors::ErrorCode;
use crate::state::fund::{FundState, FundVault};
use crate::state::global_config::GlobalConfig;

pub fn initialize_fund(
    ctx: Context<InitializeFund>,
    fund_id: u64,
    min_investor_deposit_lamports: u64,
    withdraw_timelock_secs: i64,
) -> Result<()> {
    require!(withdraw_timelock_secs >= 0, ErrorCode::InvalidTimelock);

    let config = &ctx.accounts.config;
    let fund = &mut ctx.accounts.fund_state;
    let deposit_lamports = config.min_manager_deposit_lamports;

    fund.config = config.key();
    fund.manager = ctx.accounts.manager.key();
    fund.fund_id = fund_id;
    fund.share_mint = ctx.accounts.share_mint.key();
    fund.vault = ctx.accounts.fund_vault.key();
    fund.total_shares = deposit_lamports;
    fund.min_investor_deposit_lamports = min_investor_deposit_lamports;
    fund.withdraw_timelock_secs = withdraw_timelock_secs;
    fund.enabled_token_count = 0;
    fund.is_locked = false;
    fund.borrow_amount = 0;
    fund.expected_min_out = 0;
    fund.snapshot_sol = 0;
    fund.snapshot_output = 0;
    fund.output_mint = Pubkey::default();
    fund.bump = ctx.bumps.fund_state;
    fund.share_mint_bump = ctx.bumps.share_mint;
    fund.vault_bump = ctx.bumps.fund_vault;

    let transfer_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        anchor_lang::system_program::Transfer {
            from: ctx.accounts.manager.to_account_info(),
            to: ctx.accounts.fund_vault.to_account_info(),
        },
    );
    anchor_lang::system_program::transfer(transfer_ctx, deposit_lamports)?;

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
    mint_to(mint_ctx, deposit_lamports)?;

    Ok(())
}

#[derive(Accounts)]
#[instruction(fund_id: u64)]
pub struct InitializeFund<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,
    pub config: Account<'info, GlobalConfig>,
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
