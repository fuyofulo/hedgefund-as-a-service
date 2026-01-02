use anchor_lang::prelude::*;
use anchor_spl::token::{burn, Burn, Mint, Token, TokenAccount};

use crate::errors::ErrorCode;
use crate::instructions::deposit::compute_nav_lamports;
use crate::state::fund::{FundState, FundVault};
use crate::state::global_config::GlobalConfig;
use crate::state::withdraw_request::WithdrawRequest;

pub fn execute_withdraw<'info>(
    ctx: Context<'_, '_, 'info, 'info, ExecuteWithdraw<'info>>,
) -> Result<()> {
    let request = &ctx.accounts.withdraw_request;
    require!(
        request.fund == ctx.accounts.fund_state.key(),
        ErrorCode::InvalidWithdrawal
    );
    require!(
        request.investor == ctx.accounts.investor.key(),
        ErrorCode::Unauthorized
    );
    require!(request.shares > 0, ErrorCode::InvalidWithdrawal);

    let clock = Clock::get()?;
    let unlock_time = request
        .request_ts
        .checked_add(ctx.accounts.fund_state.withdraw_timelock_secs)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        clock.unix_timestamp >= unlock_time,
        ErrorCode::WithdrawTimelock
    );

    let total_shares = ctx.accounts.fund_state.total_shares;
    require!(total_shares > 0, ErrorCode::MathOverflow);
    require!(total_shares >= request.shares, ErrorCode::MathOverflow);
    require!(
        ctx.accounts.investor_share_account.amount >= request.shares,
        ErrorCode::InsufficientShares
    );

    let vault_balance = ctx.accounts.fund_vault.to_account_info().lamports();
    let nav_lamports = compute_nav_lamports(
        ctx.program_id,
        ctx.accounts.fund_state.key(),
        vault_balance,
        ctx.accounts.config.sol_usd_pyth_feed,
        ctx.accounts.config.pyth_program_id,
        ctx.accounts.fund_state.enabled_token_count,
        ctx.remaining_accounts,
    )?;
    require!(nav_lamports > 0, ErrorCode::MathOverflow);

    let gross_lamports = (request.shares as u128)
        .checked_mul(nav_lamports as u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(total_shares as u128)
        .ok_or(ErrorCode::MathOverflow)? as u64;

    let fee_bps = ctx.accounts.config.withdraw_fee_bps as u128;
    let fee_lamports = (gross_lamports as u128)
        .checked_mul(fee_bps)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(10_000)
        .ok_or(ErrorCode::MathOverflow)? as u64;
    let net_lamports = gross_lamports
        .checked_sub(fee_lamports)
        .ok_or(ErrorCode::MathOverflow)?;

    require!(
        vault_balance >= gross_lamports,
        ErrorCode::InsufficientLiquidity
    );

    let burn_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Burn {
            mint: ctx.accounts.share_mint.to_account_info(),
            from: ctx.accounts.investor_share_account.to_account_info(),
            authority: ctx.accounts.investor.to_account_info(),
        },
    );
    burn(burn_ctx, request.shares)?;

    ctx.accounts.fund_state.total_shares = ctx
        .accounts
        .fund_state
        .total_shares
        .checked_sub(request.shares)
        .ok_or(ErrorCode::MathOverflow)?;

    {
        let fund_vault_info = ctx.accounts.fund_vault.to_account_info();
        let investor_info = ctx.accounts.investor.to_account_info();
        let fee_treasury_info = ctx.accounts.fee_treasury.to_account_info();

        let mut vault_lamports = fund_vault_info.try_borrow_mut_lamports()?;
        let mut investor_lamports = investor_info.try_borrow_mut_lamports()?;
        let mut fee_lamports_dest = fee_treasury_info.try_borrow_mut_lamports()?;

        **vault_lamports = (**vault_lamports)
            .checked_sub(gross_lamports)
            .ok_or(ErrorCode::MathOverflow)?;
        **investor_lamports = (**investor_lamports)
            .checked_add(net_lamports)
            .ok_or(ErrorCode::MathOverflow)?;
        if fee_lamports > 0 {
            **fee_lamports_dest = (**fee_lamports_dest)
                .checked_add(fee_lamports)
                .ok_or(ErrorCode::MathOverflow)?;
        }
    }

    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteWithdraw<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,
    #[account(
        seeds = [b"config", config.config_id.to_le_bytes().as_ref()],
        bump = config.bump,
        has_one = fee_treasury
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
        seeds = [b"vault", fund_state.key().as_ref()],
        bump = fund_state.vault_bump
    )]
    pub fund_vault: Account<'info, FundVault>,
    #[account(
        mut,
        seeds = [b"shares", fund_state.key().as_ref()],
        bump = fund_state.share_mint_bump
    )]
    pub share_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = share_mint,
        associated_token::authority = investor
    )]
    pub investor_share_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        close = investor,
        seeds = [b"withdraw", fund_state.key().as_ref(), investor.key().as_ref()],
        bump = withdraw_request.bump
    )]
    pub withdraw_request: Account<'info, WithdrawRequest>,
    #[account(mut)]
    pub fee_treasury: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
}
