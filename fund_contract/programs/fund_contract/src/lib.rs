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
        keeper: Pubkey,
        sol_usd_pyth_feed: Pubkey,
        pyth_program_id: Pubkey,
        deposit_fee_bps: u16,
        withdraw_fee_bps: u16,
        trade_fee_bps: u16,
        max_slippage_bps: u16,
        min_manager_deposit_lamports: u64,
    ) -> Result<()> {
        instructions::initialize_global_config::initialize_global_config(
            ctx,
            config_id,
            keeper,
            sol_usd_pyth_feed,
            pyth_program_id,
            deposit_fee_bps,
            withdraw_fee_bps,
            trade_fee_bps,
            max_slippage_bps,
            min_manager_deposit_lamports,
        )
    }

    pub fn update_global_config(
        ctx: Context<UpdateGlobalConfig>,
        config_id: u64,
        keeper: Pubkey,
        sol_usd_pyth_feed: Pubkey,
        pyth_program_id: Pubkey,
        deposit_fee_bps: u16,
        withdraw_fee_bps: u16,
        trade_fee_bps: u16,
        max_slippage_bps: u16,
        min_manager_deposit_lamports: u64,
    ) -> Result<()> {
        instructions::update_global_config::update_global_config(
            ctx,
            config_id,
            keeper,
            sol_usd_pyth_feed,
            pyth_program_id,
            deposit_fee_bps,
            withdraw_fee_bps,
            trade_fee_bps,
            max_slippage_bps,
            min_manager_deposit_lamports,
        )
    }

    pub fn set_keeper(
        ctx: Context<SetKeeper>,
        config_id: u64,
        new_keeper: Pubkey,
    ) -> Result<()> {
        let _ = config_id;
        instructions::set_keeper::set_keeper(ctx, new_keeper)
    }

    pub fn revoke_keeper(
        ctx: Context<RevokeKeeper>,
        config_id: u64,
    ) -> Result<()> {
        let _ = config_id;
        instructions::revoke_keeper::revoke_keeper(ctx)
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

    pub fn initialize_strategy_fund(
        ctx: Context<InitializeStrategyFund>,
        fund_id: u64,
        min_investor_deposit_lamports: u64,
        withdraw_timelock_secs: i64,
    ) -> Result<()> {
        instructions::initialize_strategy_fund::initialize_strategy_fund(
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

    pub fn set_strategy<'info>(
        ctx: Context<'_, '_, 'info, 'info, SetStrategy<'info>>,
        allocations: Vec<StrategyAllocationInput>,
        rebalance_threshold_bps: u16,
        rebalance_cooldown_secs: i64,
    ) -> Result<()> {
        instructions::set_strategy::set_strategy(
            ctx,
            allocations,
            rebalance_threshold_bps,
            rebalance_cooldown_secs,
        )
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

    pub fn create_limit_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, CreateLimitOrder<'info>>,
        side: u8,
        amount_in: u64,
        min_out: u64,
        limit_price: i64,
        price_expo: i32,
        expiry_ts: i64,
    ) -> Result<()> {
        instructions::create_limit_order::create_limit_order(
            ctx,
            side,
            amount_in,
            min_out,
            limit_price,
            price_expo,
            expiry_ts,
        )
    }

    pub fn create_dca_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, CreateDcaOrder<'info>>,
        side: u8,
        total_amount: u64,
        slice_amount: u64,
        interval_secs: i64,
        min_out: u64,
        expiry_ts: i64,
    ) -> Result<()> {
        instructions::create_dca_order::create_dca_order(
            ctx,
            side,
            total_amount,
            slice_amount,
            interval_secs,
            min_out,
            expiry_ts,
        )
    }

    pub fn execute_limit_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteLimitOrder<'info>>,
        order_id: u64,
        swap_data: Vec<u8>,
    ) -> Result<()> {
        let _ = order_id;
        instructions::execute_limit_order::execute_limit_order(ctx, swap_data)
    }

    pub fn execute_dca_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteDcaOrder<'info>>,
        order_id: u64,
        swap_data: Vec<u8>,
    ) -> Result<()> {
        let _ = order_id;
        instructions::execute_dca_order::execute_dca_order(ctx, swap_data)
    }

    pub fn cancel_limit_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, CancelLimitOrder<'info>>,
        order_id: u64,
    ) -> Result<()> {
        let _ = order_id;
        instructions::cancel_limit_order::cancel_limit_order(ctx)
    }

    pub fn cancel_dca_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, CancelDcaOrder<'info>>,
        order_id: u64,
    ) -> Result<()> {
        let _ = order_id;
        instructions::cancel_dca_order::cancel_dca_order(ctx)
    }

    pub fn rebalance_strategy<'info>(
        ctx: Context<'_, '_, 'info, 'info, RebalanceStrategy<'info>>,
        target_mint: Pubkey,
        min_out: u64,
        swap_data: Vec<u8>,
    ) -> Result<()> {
        instructions::rebalance_strategy::rebalance_strategy(
            ctx,
            target_mint,
            min_out,
            swap_data,
        )
    }

    pub fn sweep_wsol<'info>(
        ctx: Context<'_, '_, 'info, 'info, SweepWsol<'info>>,
    ) -> Result<()> {
        instructions::sweep_wsol::sweep_wsol(ctx)
    }
}
