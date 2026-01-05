use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

use crate::errors::ErrorCode;
use crate::state::fund::{FundState, FundVault, FUND_TYPE_TRADING};
use crate::state::global_config::GlobalConfig;
use crate::state::trading::Trading;
use crate::state::whitelist::FundWhitelist;

pub fn settle_swap<'info>(
    ctx: Context<'_, '_, 'info, 'info, SettleSwap<'info>>,
) -> Result<()> {
    require!(ctx.accounts.trading.is_locked, ErrorCode::FundNotLocked);
    require!(
        ctx.accounts.fund_state.fund_type == FUND_TYPE_TRADING,
        ErrorCode::InvalidFundType
    );
    require!(
        ctx.accounts.fund_state.manager == ctx.accounts.manager.key(),
        ErrorCode::Unauthorized
    );
    require!(
        ctx.accounts.trading.output_mint == ctx.accounts.output_whitelist.mint,
        ErrorCode::InvalidTokenVault
    );
    require!(ctx.accounts.output_whitelist.enabled, ErrorCode::InvalidTokenVault);
    let (expected_whitelist, _) = Pubkey::find_program_address(
        &[
            b"whitelist",
            ctx.accounts.fund_state.key().as_ref(),
            ctx.accounts.output_whitelist.mint.as_ref(),
        ],
        ctx.program_id,
    );
    require!(
        expected_whitelist == ctx.accounts.output_whitelist.key(),
        ErrorCode::InvalidTokenVault
    );

    let expected_vault = anchor_spl::associated_token::get_associated_token_address(
        &ctx.accounts.fund_state.key(),
        &ctx.accounts.output_whitelist.mint,
    );
    require!(
        expected_vault == ctx.accounts.output_token_vault.key(),
        ErrorCode::InvalidTokenVault
    );
    require!(
        ctx.accounts.output_token_vault.mint == ctx.accounts.output_whitelist.mint,
        ErrorCode::InvalidTokenVault
    );

    let vault_balance = ctx.accounts.fund_vault.to_account_info().lamports();
    let expected_sol = ctx
        .accounts
        .trading
        .snapshot_sol
        .checked_sub(ctx.accounts.trading.borrow_amount)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(vault_balance == expected_sol, ErrorCode::InvalidTokenVault);

    let output_after = ctx.accounts.output_token_vault.amount;
    let output_delta = output_after
        .checked_sub(ctx.accounts.trading.snapshot_output)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        output_delta >= ctx.accounts.trading.expected_min_out,
        ErrorCode::InvalidTokenVault
    );

    ctx.accounts.trading.is_locked = false;
    ctx.accounts.trading.borrow_amount = 0;
    ctx.accounts.trading.expected_min_out = 0;
    ctx.accounts.trading.snapshot_sol = 0;
    ctx.accounts.trading.snapshot_output = 0;
    ctx.accounts.trading.output_mint = Pubkey::default();

    Ok(())
}

#[derive(Accounts)]
pub struct SettleSwap<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,
    #[account(
        seeds = [b"config", config.config_id.to_le_bytes().as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [b"fund", config.key().as_ref(), fund_state.manager.as_ref(), fund_state.fund_id.to_le_bytes().as_ref()],
        bump = fund_state.bump,
        has_one = config
    )]
    pub fund_state: Account<'info, FundState>,
    #[account(
        mut,
        seeds = [b"trading", fund_state.key().as_ref()],
        bump = trading.bump,
        constraint = trading.fund == fund_state.key()
    )]
    pub trading: Account<'info, Trading>,
    #[account(
        mut,
        seeds = [b"vault", fund_state.key().as_ref()],
        bump = fund_state.vault_bump
    )]
    pub fund_vault: Account<'info, FundVault>,
    pub output_whitelist: Account<'info, FundWhitelist>,
    #[account(mut)]
    pub output_token_vault: Account<'info, TokenAccount>,
}
