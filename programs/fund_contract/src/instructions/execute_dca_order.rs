use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount};
use anchor_spl::token::spl_token::native_mint;
use pyth_sdk_solana::state::SolanaPriceAccount;

use crate::errors::ErrorCode;
use crate::state::dca_order::{DcaOrder, DCA_SIDE_BUY, DCA_SIDE_SELL, DCA_STATUS_EXECUTED, DCA_STATUS_OPEN};
use crate::state::fund::{FundState, FundVault, FUND_TYPE_TRADING};
use crate::state::global_config::GlobalConfig;
use crate::state::whitelist::FundWhitelist;

const ORACLE_MAX_AGE_SECS: u64 = 60;
const MAX_CONF_BPS: u64 = 200;
const JUPITER_PROGRAM_ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const LAMPORTS_PER_SOL_U64: u64 = 1_000_000_000;

pub fn execute_dca_order<'info>(
    ctx: Context<'_, '_, 'info, 'info, ExecuteDcaOrder<'info>>,
    swap_data: Vec<u8>,
) -> Result<()> {
    require!(
        ctx.accounts.executor.key() == ctx.accounts.config.keeper,
        ErrorCode::Unauthorized
    );
    require!(
        ctx.accounts.fund_state.fund_type == FUND_TYPE_TRADING,
        ErrorCode::InvalidFundType
    );

    let order = &mut ctx.accounts.order;
    require!(order.status == DCA_STATUS_OPEN, ErrorCode::OrderNotOpen);
    require!(order.fund == ctx.accounts.fund_state.key(), ErrorCode::InvalidTokenVault);
    if order.expiry_ts != 0 {
        require!(Clock::get()?.unix_timestamp <= order.expiry_ts, ErrorCode::OrderExpired);
    }
    require!(Clock::get()?.unix_timestamp >= order.next_exec_ts, ErrorCode::DcaNotReady);

    require!(order.side == DCA_SIDE_BUY || order.side == DCA_SIDE_SELL, ErrorCode::InvalidOrderSide);
    require!(ctx.accounts.whitelist.enabled, ErrorCode::InvalidTokenVault);
    require!(ctx.accounts.whitelist.fund == ctx.accounts.fund_state.key(), ErrorCode::InvalidTokenVault);
    require!(ctx.accounts.whitelist.mint == order.mint, ErrorCode::InvalidTokenVault);
    require!(ctx.accounts.whitelist.pyth_feed == order.price_feed, ErrorCode::InvalidOracle);

    let price_info = &ctx.accounts.price_feed;
    require!(price_info.key == &order.price_feed, ErrorCode::InvalidOracle);
    require!(price_info.owner == &order.pyth_program_id, ErrorCode::InvalidOracle);
    let price = load_pyth_price(price_info)?;

    let sol_price_info = &ctx.accounts.sol_price_feed;
    require!(
        sol_price_info.key == &ctx.accounts.config.sol_usd_pyth_feed,
        ErrorCode::InvalidOracle
    );
    require!(
        sol_price_info.owner == &ctx.accounts.config.pyth_program_id,
        ErrorCode::InvalidOracle
    );
    let sol_price = load_pyth_price(sol_price_info)?;

    require!(!swap_data.is_empty(), ErrorCode::InvalidSwapProgram);
    require!(!ctx.remaining_accounts.is_empty(), ErrorCode::InvalidSwapProgram);
    require!(
        ctx.accounts.swap_program.key() == JUPITER_PROGRAM_ID,
        ErrorCode::InvalidSwapProgram
    );

    let fund_key = ctx.accounts.fund_state.key();
    let expected_fund_token_vault = anchor_spl::associated_token::get_associated_token_address(
        &fund_key,
        &order.mint,
    );
    require!(expected_fund_token_vault == ctx.accounts.fund_token_vault.key(), ErrorCode::InvalidTokenVault);
    require!(ctx.accounts.fund_token_vault.mint == order.mint, ErrorCode::InvalidTokenVault);

    let (vault_auth, vault_auth_bump) = Pubkey::find_program_address(
        &[b"dca_order_vault_auth", order.key().as_ref()],
        ctx.program_id,
    );
    require!(
        vault_auth == ctx.accounts.order_vault_auth.key(),
        ErrorCode::InvalidOrderVault
    );

    match order.side {
        DCA_SIDE_BUY => {
            let (sol_vault, _bump) = Pubkey::find_program_address(
                &[b"dca_order_sol_vault", order.key().as_ref()],
                ctx.program_id,
            );
            require!(sol_vault == ctx.accounts.order_sol_vault.key(), ErrorCode::InvalidOrderVault);
            require!(
                ctx.accounts.order_sol_vault.owner == &anchor_lang::solana_program::system_program::ID,
                ErrorCode::InvalidOrderVault
            );
            let expected_wsol_vault =
                anchor_spl::associated_token::get_associated_token_address(
                    &vault_auth,
                    &native_mint::ID,
                );
            require!(
                expected_wsol_vault == ctx.accounts.order_token_vault.key(),
                ErrorCode::InvalidOrderVault
            );
            require!(
                ctx.accounts.order_token_vault.mint == native_mint::ID,
                ErrorCode::InvalidOrderVault
            );
            require!(
                ctx.accounts.order_token_vault.owner == ctx.accounts.order_vault_auth.key(),
                ErrorCode::InvalidOrderVault
            );
        }
        DCA_SIDE_SELL => {
            let expected_order_vault =
                anchor_spl::associated_token::get_associated_token_address(
                    &vault_auth,
                    &order.mint,
                );
            require!(
                expected_order_vault == ctx.accounts.order_token_vault.key(),
                ErrorCode::InvalidOrderVault
            );
            require!(
                ctx.accounts.order_token_vault.mint == order.mint,
                ErrorCode::InvalidOrderVault
            );
            require!(
                ctx.accounts.order_token_vault.owner == ctx.accounts.order_vault_auth.key(),
                ErrorCode::InvalidOrderVault
            );
        }
        _ => return err!(ErrorCode::InvalidOrderSide),
    }

    let mut has_order_token_vault = false;
    let mut has_output_account = false;
    let mut has_vault_auth = false;
    for acc in ctx.remaining_accounts.iter() {
        if *acc.key == ctx.accounts.order_token_vault.key() && acc.is_writable {
            has_order_token_vault = true;
        }
        if *acc.key == ctx.accounts.order_vault_auth.key() {
            has_vault_auth = true;
        }
        if order.side == DCA_SIDE_BUY
            && *acc.key == ctx.accounts.fund_token_vault.key()
            && acc.is_writable
        {
            has_output_account = true;
        }
        if order.side == DCA_SIDE_SELL
            && *acc.key == ctx.accounts.fund_vault.key()
            && acc.is_writable
        {
            has_output_account = true;
        }
    }
    require!(has_order_token_vault, ErrorCode::InvalidOrderVault);
    require!(has_output_account, ErrorCode::InvalidTokenVault);
    require!(has_vault_auth, ErrorCode::InvalidOrderVault);

    let cpi_accounts: Vec<AccountMeta> = ctx
        .remaining_accounts
        .iter()
        .map(|acc| AccountMeta {
            pubkey: *acc.key,
            is_signer: *acc.key == ctx.accounts.order_vault_auth.key(),
            is_writable: acc.is_writable,
        })
        .collect();

    let mut infos: Vec<AccountInfo> = Vec::with_capacity(ctx.remaining_accounts.len());
    for acc in ctx.remaining_accounts.iter() {
        infos.push(acc.clone());
    }

    let order_key = order.key();
    let signer_seeds: &[&[u8]] = &[
        b"dca_order_vault_auth",
        order_key.as_ref(),
        &[vault_auth_bump],
    ];
    let signer_seeds_set = [signer_seeds];

    let slice_amount = if order.remaining_amount >= order.slice_amount {
        order.slice_amount
    } else {
        order.remaining_amount
    };
    require!(slice_amount > 0, ErrorCode::DcaCompleted);

    let mut fund_token_before = ctx.accounts.fund_token_vault.amount;
    let mut order_token_before = ctx.accounts.order_token_vault.amount;
    let mut fund_sol_before = ctx.accounts.fund_vault.to_account_info().lamports();

    if order.side == DCA_SIDE_BUY {
        let (sol_vault, sol_vault_bump) = Pubkey::find_program_address(
            &[b"dca_order_sol_vault", order_key.as_ref()],
            ctx.program_id,
        );
        require!(sol_vault == ctx.accounts.order_sol_vault.key(), ErrorCode::InvalidOrderVault);
        let sol_balance = ctx.accounts.order_sol_vault.to_account_info().lamports();
        require!(sol_balance >= slice_amount, ErrorCode::InsufficientLiquidity);

        let sol_vault_seeds: &[&[u8]] = &[
            b"dca_order_sol_vault",
            order_key.as_ref(),
            &[sol_vault_bump],
        ];
        let sol_vault_signer = [sol_vault_seeds];
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.order_sol_vault.to_account_info(),
                to: ctx.accounts.order_token_vault.to_account_info(),
            },
            &sol_vault_signer,
        );
        anchor_lang::system_program::transfer(transfer_ctx, slice_amount)?;

        let sync_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::SyncNative {
                account: ctx.accounts.order_token_vault.to_account_info(),
            },
        );
        token::sync_native(sync_ctx)?;

        ctx.accounts.order_token_vault.reload()?;
        order_token_before = ctx.accounts.order_token_vault.amount;
        fund_token_before = ctx.accounts.fund_token_vault.amount;
        fund_sol_before = ctx.accounts.fund_vault.to_account_info().lamports();
    } else {
        require!(order_token_before >= slice_amount, ErrorCode::InsufficientLiquidity);
    }

    invoke_signed(
        &Instruction {
            program_id: ctx.accounts.swap_program.key(),
            accounts: cpi_accounts,
            data: swap_data,
        },
        &infos,
        &signer_seeds_set,
    )?;

    ctx.accounts.fund_token_vault.reload()?;
    ctx.accounts.order_token_vault.reload()?;
    let fund_token_after = ctx.accounts.fund_token_vault.amount;
    let order_token_after = ctx.accounts.order_token_vault.amount;
    let fund_sol_after = ctx.accounts.fund_vault.to_account_info().lamports();

    match order.side {
        DCA_SIDE_BUY => {
            let token_delta = fund_token_after
                .checked_sub(fund_token_before)
                .ok_or(ErrorCode::MathOverflow)?;
            let expected_out = expected_token_out_from_sol(
                slice_amount,
                ctx.accounts.whitelist.decimals,
                price.price,
                price.expo,
                sol_price.price,
                sol_price.expo,
            )?;
            let min_expected = apply_max_slippage(
                expected_out,
                ctx.accounts.config.max_slippage_bps,
            )?;
            require!(token_delta >= min_expected, ErrorCode::InvalidTokenVault);
            require!(token_delta >= order.min_out, ErrorCode::InvalidTokenVault);
            require!(order_token_before == slice_amount, ErrorCode::InvalidOrderVault);
            require!(order_token_after == 0, ErrorCode::InvalidOrderVault);
        }
        DCA_SIDE_SELL => {
            let sol_delta = fund_sol_after
                .checked_sub(fund_sol_before)
                .ok_or(ErrorCode::MathOverflow)?;
            let expected_out = expected_sol_out_from_token(
                slice_amount,
                ctx.accounts.whitelist.decimals,
                price.price,
                price.expo,
                sol_price.price,
                sol_price.expo,
            )?;
            let min_expected = apply_max_slippage(
                expected_out,
                ctx.accounts.config.max_slippage_bps,
            )?;
            require!(sol_delta >= min_expected, ErrorCode::InvalidTokenVault);
            require!(sol_delta >= order.min_out, ErrorCode::InvalidTokenVault);
            let expected_after = order_token_before
                .checked_sub(slice_amount)
                .ok_or(ErrorCode::MathOverflow)?;
            require!(order_token_after == expected_after, ErrorCode::InvalidOrderVault);
        }
        _ => return err!(ErrorCode::InvalidOrderSide),
    }

    order.remaining_amount = order
        .remaining_amount
        .checked_sub(slice_amount)
        .ok_or(ErrorCode::MathOverflow)?;
    order.next_exec_ts = order
        .next_exec_ts
        .checked_add(order.interval_secs)
        .ok_or(ErrorCode::MathOverflow)?;

    if order.remaining_amount == 0 {
        order.status = DCA_STATUS_EXECUTED;
        ctx.accounts.fund_state.active_dca_count = ctx
            .accounts
            .fund_state
            .active_dca_count
            .checked_sub(1)
            .ok_or(ErrorCode::MathOverflow)?;

        if order.side == DCA_SIDE_SELL || order.side == DCA_SIDE_BUY {
            if ctx.accounts.order_token_vault.amount == 0 {
                let close_ctx = CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    CloseAccount {
                        account: ctx.accounts.order_token_vault.to_account_info(),
                        destination: ctx.accounts.fund_vault.to_account_info(),
                        authority: ctx.accounts.order_vault_auth.to_account_info(),
                    },
                    &signer_seeds_set,
                );
                token::close_account(close_ctx)?;
            }
        }
        let sol_balance = ctx.accounts.order_sol_vault.to_account_info().lamports();
        if sol_balance > 0 {
            let (sol_vault, sol_vault_bump) = Pubkey::find_program_address(
                &[b"dca_order_sol_vault", order_key.as_ref()],
                ctx.program_id,
            );
            require!(sol_vault == ctx.accounts.order_sol_vault.key(), ErrorCode::InvalidOrderVault);
            let sol_vault_seeds: &[&[u8]] = &[
                b"dca_order_sol_vault",
                order_key.as_ref(),
                &[sol_vault_bump],
            ];
            let sol_vault_signer = [sol_vault_seeds];
            let transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.order_sol_vault.to_account_info(),
                    to: ctx.accounts.fund_vault.to_account_info(),
                },
                &sol_vault_signer,
            );
            anchor_lang::system_program::transfer(transfer_ctx, sol_balance)?;
        }
    }

    Ok(())
}

struct PythPrice {
    price: i64,
    expo: i32,
}

fn load_pyth_price(price_info: &AccountInfo) -> Result<PythPrice> {
    let feed = SolanaPriceAccount::account_info_to_feed(price_info)
        .map_err(|_| ErrorCode::InvalidOracle)?;
    let price = feed
        .get_price_no_older_than(Clock::get()?.unix_timestamp, ORACLE_MAX_AGE_SECS)
        .ok_or(ErrorCode::StaleOracle)?;
    require!(price.price > 0, ErrorCode::InvalidOracle);
    let price_u128 = price.price as u128;
    let max_conf = price_u128
        .checked_mul(MAX_CONF_BPS as u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(10_000)
        .ok_or(ErrorCode::MathOverflow)? as u64;
    require!(price.conf <= max_conf, ErrorCode::InvalidOracleConfidence);
    Ok(PythPrice {
        price: price.price,
        expo: price.expo,
    })
}

fn apply_max_slippage(expected_out: u64, max_slippage_bps: u16) -> Result<u64> {
    require!(max_slippage_bps <= 10_000, ErrorCode::InvalidFeeBps);
    let expected = expected_out as u128;
    let factor = 10_000u128
        .checked_sub(max_slippage_bps as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    let min_expected = expected
        .checked_mul(factor)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(10_000u128)
        .ok_or(ErrorCode::MathOverflow)?;
    Ok(min_expected as u64)
}

fn pow10_i128(exp: u32) -> Result<i128> {
    let mut value: i128 = 1;
    for _ in 0..exp {
        value = value.checked_mul(10).ok_or(ErrorCode::MathOverflow)?;
    }
    Ok(value)
}

fn expected_sol_out_from_token(
    amount: u64,
    decimals: u8,
    token_price: i64,
    token_expo: i32,
    sol_price: i64,
    sol_expo: i32,
) -> Result<u64> {
    require!(token_price > 0, ErrorCode::InvalidOracle);
    require!(sol_price > 0, ErrorCode::InvalidOracle);
    let mut numerator = (amount as i128)
        .checked_mul(token_price as i128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_mul(LAMPORTS_PER_SOL_U64 as i128)
        .ok_or(ErrorCode::MathOverflow)?;
    let mut denominator = sol_price as i128;

    let exp = token_expo
        .checked_sub(decimals as i32)
        .and_then(|v| v.checked_sub(sol_expo))
        .ok_or(ErrorCode::MathOverflow)?;

    if exp >= 0 {
        let scale = pow10_i128(exp as u32)?;
        numerator = numerator
            .checked_mul(scale)
            .ok_or(ErrorCode::MathOverflow)?;
    } else {
        let scale = pow10_i128((-exp) as u32)?;
        denominator = denominator
            .checked_mul(scale)
            .ok_or(ErrorCode::MathOverflow)?;
    }
    require!(denominator > 0, ErrorCode::MathOverflow);
    Ok((numerator / denominator) as u64)
}

fn expected_token_out_from_sol(
    sol_lamports: u64,
    decimals: u8,
    token_price: i64,
    token_expo: i32,
    sol_price: i64,
    sol_expo: i32,
) -> Result<u64> {
    require!(token_price > 0, ErrorCode::InvalidOracle);
    require!(sol_price > 0, ErrorCode::InvalidOracle);
    let mut numerator = (sol_lamports as i128)
        .checked_mul(sol_price as i128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_mul(pow10_i128(decimals as u32)?)
        .ok_or(ErrorCode::MathOverflow)?;
    let mut denominator = (token_price as i128)
        .checked_mul(LAMPORTS_PER_SOL_U64 as i128)
        .ok_or(ErrorCode::MathOverflow)?;

    let exp = sol_expo
        .checked_sub(token_expo)
        .ok_or(ErrorCode::MathOverflow)?;
    if exp >= 0 {
        let scale = pow10_i128(exp as u32)?;
        numerator = numerator
            .checked_mul(scale)
            .ok_or(ErrorCode::MathOverflow)?;
    } else {
        let scale = pow10_i128((-exp) as u32)?;
        denominator = denominator
            .checked_mul(scale)
            .ok_or(ErrorCode::MathOverflow)?;
    }
    require!(denominator > 0, ErrorCode::MathOverflow);
    Ok((numerator / denominator) as u64)
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct ExecuteDcaOrder<'info> {
    pub executor: Signer<'info>,
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
        seeds = [b"vault", fund_state.key().as_ref()],
        bump = fund_state.vault_bump
    )]
    pub fund_vault: Account<'info, FundVault>,
    pub whitelist: Account<'info, FundWhitelist>,
    #[account(mut)]
    pub fund_token_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"dca_order", fund_state.key().as_ref(), order_id.to_le_bytes().as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, DcaOrder>,
    /// CHECK: validated against derived PDA in handler
    #[account(mut)]
    pub order_sol_vault: UncheckedAccount<'info>,
    /// CHECK: PDA authority for DCA order vault
    pub order_vault_auth: UncheckedAccount<'info>,
    #[account(mut)]
    pub order_token_vault: Account<'info, TokenAccount>,
    /// CHECK: Pyth price feed
    pub price_feed: AccountInfo<'info>,
    /// CHECK: Pyth SOL/USD price feed
    pub sol_price_feed: AccountInfo<'info>,
    /// CHECK: swap program id
    pub swap_program: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
