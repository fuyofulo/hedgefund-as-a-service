use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("DJei27xsWtXh4ahJnYqtpjJ99mHVj9rVpQFNMLVnMHvY");

#[program]
pub mod fund_contract {
    use super::*;

    pub fn initialize_global_config(
        ctx: Context<InitializeGlobalConfig>,
        config_id: u64,
        sol_usd_pyth_feed: Pubkey,
        pyth_program_id: Pubkey,
        deposit_fee_bps: u16,
        withdraw_fee_bps: u16,
        trade_fee_bps: u16,
        min_manager_deposit_lamports: u64,
    ) -> Result<()> {
        instructions::initialize_global_config::initialize_global_config(
            ctx,
            config_id,
            sol_usd_pyth_feed,
            pyth_program_id,
            deposit_fee_bps,
            withdraw_fee_bps,
            trade_fee_bps,
            min_manager_deposit_lamports,
        )
    }

    pub fn update_global_config(
        ctx: Context<UpdateGlobalConfig>,
        config_id: u64,
        sol_usd_pyth_feed: Pubkey,
        pyth_program_id: Pubkey,
        deposit_fee_bps: u16,
        withdraw_fee_bps: u16,
        trade_fee_bps: u16,
        min_manager_deposit_lamports: u64,
    ) -> Result<()> {
        instructions::update_global_config::update_global_config(
            ctx,
            config_id,
            sol_usd_pyth_feed,
            pyth_program_id,
            deposit_fee_bps,
            withdraw_fee_bps,
            trade_fee_bps,
            min_manager_deposit_lamports,
        )
    }

    pub fn initialize_fund(
        ctx: Context<InitializeFund>,
        fund_id: u64,
        min_investor_deposit_lamports: u64,
        withdraw_timelock_secs: i64,
    ) -> Result<()> {
        instructions::initialize_fund::initialize_fund(
            ctx,
            fund_id,
            min_investor_deposit_lamports,
            withdraw_timelock_secs,
        )
    }

    pub fn deposit<'info>(
        ctx: Context<'_, '_, 'info, 'info, Deposit<'info>>,
        amount_lamports: u64,
    ) -> Result<()> {
        instructions::deposit::deposit(ctx, amount_lamports)
    }
    pub fn add_token<'info>(
        ctx: Context<'_, '_, 'info, 'info, AddToken<'info>>,
        scope: u8,
        fund_id: u64,
        pyth_feed: Pubkey,
    ) -> Result<()> {
        instructions::add_token::add_token(ctx, scope, fund_id, pyth_feed)
    }

    pub fn remove_token<'info>(
        ctx: Context<'_, '_, 'info, 'info, RemoveToken<'info>>,
        scope: u8,
        fund_id: u64,
    ) -> Result<()> {
        instructions::remove_token::remove_token(ctx, scope, fund_id)
    }

    pub fn request_withdraw<'info>(
        ctx: Context<'_, '_, 'info, 'info, RequestWithdraw<'info>>,
        shares: u64,
    ) -> Result<()> {
        instructions::request_withdraw::request_withdraw(ctx, shares)
    }

    pub fn execute_withdraw<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteWithdraw<'info>>,
    ) -> Result<()> {
        instructions::execute_withdraw::execute_withdraw(ctx)
    }

    pub fn cancel_withdraw<'info>(
        ctx: Context<'_, '_, 'info, 'info, CancelWithdraw<'info>>,
    ) -> Result<()> {
        instructions::cancel_withdraw::cancel_withdraw(ctx)
    }

    pub fn borrow_for_swap<'info>(
        ctx: Context<'_, '_, 'info, 'info, BorrowForSwap<'info>>,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        instructions::borrow_for_swap::borrow_for_swap(ctx, amount_in, min_amount_out)
    }

    pub fn settle_swap<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleSwap<'info>>,
    ) -> Result<()> {
        instructions::settle_swap::settle_swap(ctx)
    }
}
