use anchor_lang::prelude::*;

use crate::errors::ErrorCode;
use crate::state::fund::FundState;
use crate::state::global_config::GlobalConfig;
use crate::state::withdraw_request::WithdrawRequest;

pub fn cancel_withdraw<'info>(
    ctx: Context<'_, '_, 'info, 'info, CancelWithdraw<'info>>,
) -> Result<()> {
    require!(
        ctx.accounts.withdraw_request.fund == ctx.accounts.fund_state.key(),
        ErrorCode::InvalidWithdrawal
    );
    require!(
        ctx.accounts.withdraw_request.investor == ctx.accounts.investor.key(),
        ErrorCode::Unauthorized
    );
    Ok(())
}

#[derive(Accounts)]
pub struct CancelWithdraw<'info> {
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
        mut,
        close = investor,
        seeds = [b"withdraw", fund_state.key().as_ref(), investor.key().as_ref()],
        bump = withdraw_request.bump
    )]
    pub withdraw_request: Account<'info, WithdrawRequest>,
}
