use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

use crate::errors::ErrorCode;
use crate::state::fund::FundState;
use crate::state::global_config::GlobalConfig;
use crate::state::withdraw_request::WithdrawRequest;

pub fn request_withdraw<'info>(
    ctx: Context<'_, '_, 'info, 'info, RequestWithdraw<'info>>,
    shares: u64,
) -> Result<()> {
    require!(shares > 0, ErrorCode::InvalidWithdrawal);

    require!(
        ctx.accounts.investor_share_account.amount >= shares,
        ErrorCode::InsufficientShares
    );

    let request = &mut ctx.accounts.withdraw_request;
    request.fund = ctx.accounts.fund_state.key();
    request.investor = ctx.accounts.investor.key();
    request.shares = shares;
    request.request_ts = Clock::get()?.unix_timestamp;
    request.bump = ctx.bumps.withdraw_request;

    Ok(())
}

#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,
    #[account(
        seeds = [b"config", config.config_id.to_le_bytes().as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        seeds = [b"fund", config.key().as_ref(), fund_state.manager.as_ref(), fund_state.fund_id.to_le_bytes().as_ref()],
        bump = fund_state.bump,
        has_one = config
    )]
    pub fund_state: Account<'info, FundState>,
    #[account(
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
        init_if_needed,
        payer = investor,
        space = 8 + WithdrawRequest::LEN,
        seeds = [b"withdraw", fund_state.key().as_ref(), investor.key().as_ref()],
        bump
    )]
    pub withdraw_request: Account<'info, WithdrawRequest>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
