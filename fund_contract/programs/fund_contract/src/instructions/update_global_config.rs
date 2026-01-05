use anchor_lang::prelude::*;

use crate::errors::ErrorCode;
use crate::state::global_config::GlobalConfig;

pub fn update_global_config(
    ctx: Context<UpdateGlobalConfig>,
    _config_id: u64,
    sol_usd_pyth_feed: Pubkey,
    pyth_program_id: Pubkey,
    deposit_fee_bps: u16,
    withdraw_fee_bps: u16,
    trade_fee_bps: u16,
    max_manager_fee_bps: u16,
    max_slippage_bps: u16,
    min_manager_deposit_lamports: u64,
    min_withdraw_timelock_secs: i64,
    max_withdraw_timelock_secs: i64,
) -> Result<()> {
    require!(deposit_fee_bps <= 10_000, ErrorCode::InvalidFeeBps);
    require!(withdraw_fee_bps <= 10_000, ErrorCode::InvalidFeeBps);
    require!(trade_fee_bps <= 10_000, ErrorCode::InvalidFeeBps);
    require!(max_manager_fee_bps <= 10_000, ErrorCode::InvalidFeeBps);
    require!(max_slippage_bps <= 10_000, ErrorCode::InvalidFeeBps);
    require!(min_withdraw_timelock_secs >= 0, ErrorCode::InvalidTimelock);
    require!(
        max_withdraw_timelock_secs >= min_withdraw_timelock_secs,
        ErrorCode::InvalidTimelock
    );

    let config = &mut ctx.accounts.config;
    config.fee_treasury = ctx.accounts.fee_treasury.key();
    config.sol_usd_pyth_feed = sol_usd_pyth_feed;
    config.pyth_program_id = pyth_program_id;
    config.deposit_fee_bps = deposit_fee_bps;
    config.withdraw_fee_bps = withdraw_fee_bps;
    config.trade_fee_bps = trade_fee_bps;
    config.max_manager_fee_bps = max_manager_fee_bps;
    config.max_slippage_bps = max_slippage_bps;
    config.min_manager_deposit_lamports = min_manager_deposit_lamports;
    config.min_withdraw_timelock_secs = min_withdraw_timelock_secs;
    config.max_withdraw_timelock_secs = max_withdraw_timelock_secs;

    Ok(())
}

#[derive(Accounts)]
#[instruction(config_id: u64)]
pub struct UpdateGlobalConfig<'info> {
    #[account(
        mut,
        seeds = [b"config", config_id.to_le_bytes().as_ref()],
        bump = config.bump,
        has_one = admin
    )]
    pub config: Account<'info, GlobalConfig>,
    pub admin: Signer<'info>,
    pub fee_treasury: SystemAccount<'info>,
}
