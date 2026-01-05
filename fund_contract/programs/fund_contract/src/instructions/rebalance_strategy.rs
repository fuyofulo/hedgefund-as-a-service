use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::{create, AssociatedToken};
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use anchor_spl::token::spl_token::native_mint;
use pyth_sdk_solana::state::SolanaPriceAccount;

use crate::errors::ErrorCode;
use crate::state::fund::{FundState, FundVault, FUND_TYPE_STRATEGY};
use crate::state::global_config::GlobalConfig;
use crate::state::strategy::{Strategy, StrategyAllocation};
use crate::state::whitelist::FundWhitelist;

const ORACLE_MAX_AGE_SECS: u64 = 60;
const MAX_CONF_BPS: u64 = 200;
const JUPITER_PROGRAM_ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const LAMPORTS_PER_SOL_U64: u64 = 1_000_000_000;
const SELL_DUST_TOLERANCE: u64 = 2;

pub fn rebalance_strategy<'info>(
    ctx: Context<'_, '_, 'info, 'info, RebalanceStrategy<'info>>,
    target_mint: Pubkey,
    min_out: u64,
    swap_data: Vec<u8>,
) -> Result<()> {
    require!(
        ctx.accounts.executor.key() == ctx.accounts.config.keeper,
        ErrorCode::Unauthorized
    );
    require!(min_out > 0, ErrorCode::InvalidMinOut);
    require!(
        ctx.accounts.fund_state.fund_type == FUND_TYPE_STRATEGY,
        ErrorCode::InvalidFundType
    );

    let strategy = &mut ctx.accounts.strategy;
    require!(strategy.fund == ctx.accounts.fund_state.key(), ErrorCode::InvalidStrategy);
    require!(strategy.allocation_count > 0, ErrorCode::InvalidStrategy);
    require!(
        ctx.accounts.fund_state.enabled_token_count as u8 == strategy.allocation_count,
        ErrorCode::InvalidStrategy
    );
    require!(strategy.rebalance_cooldown_secs > 0, ErrorCode::InvalidStrategy);

    let fund_key = ctx.accounts.fund_state.key();
    let expected_wsol_vault =
        anchor_spl::associated_token::get_associated_token_address(
            &fund_key,
            &native_mint::ID,
        );
    require!(
        expected_wsol_vault == ctx.accounts.fund_wsol_vault.key(),
        ErrorCode::InvalidOrderVault
    );
    let wsol_amount = if ctx
        .accounts
        .fund_wsol_vault
        .to_account_info()
        .data_is_empty()
    {
        0
    } else {
        read_token_amount(&ctx.accounts.fund_wsol_vault.to_account_info())?
    };
    require!(wsol_amount == 0, ErrorCode::WsolNotCleared);

    let now = Clock::get()?.unix_timestamp;
    let next_allowed = strategy
        .last_rebalance_ts
        .checked_add(strategy.rebalance_cooldown_secs)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(now >= next_allowed, ErrorCode::RebalanceNotNeeded);

    require!(!swap_data.is_empty(), ErrorCode::InvalidSwapProgram);
    require!(!ctx.remaining_accounts.is_empty(), ErrorCode::InvalidSwapProgram);
    require!(
        ctx.accounts.swap_program.key() == JUPITER_PROGRAM_ID,
        ErrorCode::InvalidSwapProgram
    );

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

    let alloc_count = strategy.allocation_count as usize;
    let expected_remaining = 3 * alloc_count;
    require!(
        ctx.remaining_accounts.len() >= expected_remaining,
        ErrorCode::InvalidRemainingAccounts
    );
    let (validation_accounts, cpi_account_infos) =
        ctx.remaining_accounts.split_at(expected_remaining);
    require!(!cpi_account_infos.is_empty(), ErrorCode::InvalidSwapProgram);

    let fund_vault_lamports = ctx.accounts.fund_vault.to_account_info().lamports();
    let nav_base_lamports = fund_vault_lamports;

    let mut nav_lamports: i128 = nav_base_lamports as i128;
    let mut target_weight: Option<u16> = None;
    let target_value_lamports: i128;
    let mut target_actual_value: i128 = 0;
    let mut target_token_amount: u64 = 0;
    let mut target_decimals: u8 = 0;
    let mut target_price: Option<PythPrice> = None;

    for idx in 0..alloc_count {
        let alloc: StrategyAllocation = strategy.allocations[idx];
        let wl_info = &validation_accounts[idx * 3];
        let vault_info = &validation_accounts[idx * 3 + 1];
        let price_info = &validation_accounts[idx * 3 + 2];

        let whitelist: Account<FundWhitelist> =
            Account::try_from(wl_info).map_err(|_| ErrorCode::InvalidTokenVault)?;
        require!(whitelist.enabled, ErrorCode::InvalidTokenVault);
        require!(whitelist.fund == fund_key, ErrorCode::InvalidTokenVault);
        require!(whitelist.mint == alloc.mint, ErrorCode::InvalidTokenVault);
        require!(whitelist.pyth_feed == *price_info.key, ErrorCode::InvalidOracle);
        require!(price_info.owner == &ctx.accounts.config.pyth_program_id, ErrorCode::InvalidOracle);

        let expected_vault = anchor_spl::associated_token::get_associated_token_address(
            &fund_key,
            &alloc.mint,
        );
        require!(*vault_info.key == expected_vault, ErrorCode::InvalidTokenVault);
        let token_vault: Account<TokenAccount> =
            Account::try_from(vault_info).map_err(|_| ErrorCode::InvalidTokenVault)?;
        require!(token_vault.mint == alloc.mint, ErrorCode::InvalidTokenVault);

        let token_price = load_pyth_price(price_info)?;
        let token_value = expected_sol_out_from_token(
            token_vault.amount,
            whitelist.decimals,
            token_price.price,
            token_price.expo,
            sol_price.price,
            sol_price.expo,
        )? as i128;
        nav_lamports = nav_lamports
            .checked_add(token_value)
            .ok_or(ErrorCode::MathOverflow)?;

        if alloc.mint == target_mint {
            target_weight = Some(alloc.weight_bps);
            target_actual_value = token_value;
            target_token_amount = token_vault.amount;
            target_decimals = whitelist.decimals;
            target_price = Some(token_price);

            require!(
                token_vault.key() == ctx.accounts.fund_token_vault.key(),
                ErrorCode::InvalidTokenVault
            );
        }
    }

    require!(nav_lamports > 0, ErrorCode::InvalidNav);
    let weight_bps = target_weight.ok_or(ErrorCode::InvalidStrategy)? as i128;
    target_value_lamports = nav_lamports
        .checked_mul(weight_bps)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(10_000)
        .ok_or(ErrorCode::MathOverflow)?;

    let deviation = target_actual_value
        .checked_sub(target_value_lamports)
        .ok_or(ErrorCode::MathOverflow)?;
    let abs_deviation = abs_i128(deviation)?;
    let threshold = nav_lamports
        .checked_mul(strategy.rebalance_threshold_bps as i128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(10_000)
        .ok_or(ErrorCode::MathOverflow)?;
    if abs_deviation <= threshold {
        return err!(ErrorCode::RebalanceNotNeeded);
    }

    let mut has_fund_token_vault = false;
    let mut has_fund_wsol = false;
    let mut has_fund_state = false;
    let mut has_fund_vault = false;
    for acc in cpi_account_infos.iter() {
        if *acc.key == ctx.accounts.fund_token_vault.key() && acc.is_writable {
            has_fund_token_vault = true;
        }
        if *acc.key == ctx.accounts.fund_wsol_vault.key() && acc.is_writable {
            has_fund_wsol = true;
        }
        if *acc.key == ctx.accounts.fund_state.key() {
            has_fund_state = true;
        }
        if *acc.key == ctx.accounts.fund_vault.key() && acc.is_writable {
            has_fund_vault = true;
        }
    }
    require!(has_fund_token_vault, ErrorCode::InvalidTokenVault);
    require!(has_fund_state, ErrorCode::InvalidSwapProgram);

    let config_key = ctx.accounts.config.key();
    let fund_id_bytes = ctx.accounts.fund_state.fund_id.to_le_bytes();
    let signer_seeds: &[&[u8]] = &[
        b"fund",
        config_key.as_ref(),
        ctx.accounts.fund_state.manager.as_ref(),
        fund_id_bytes.as_ref(),
        &[ctx.accounts.fund_state.bump],
    ];
    let signer_seeds_set = [signer_seeds];

    let cpi_metas: Vec<AccountMeta> = cpi_account_infos
        .iter()
        .map(|acc| AccountMeta {
            pubkey: *acc.key,
            is_signer: acc.is_signer || *acc.key == ctx.accounts.fund_state.key(),
            is_writable: acc.is_writable,
        })
        .collect();

    let mut infos: Vec<AccountInfo> = Vec::with_capacity(cpi_account_infos.len());
    for acc in cpi_account_infos.iter() {
        infos.push(acc.clone());
    }

    let target_price = target_price.ok_or(ErrorCode::InvalidStrategy)?;

    if deviation < 0 {
        require!(has_fund_vault, ErrorCode::InvalidTokenVault);
        require!(has_fund_wsol, ErrorCode::InvalidOrderVault);

        let spend_lamports = abs_deviation as u64;
        require!(fund_vault_lamports >= spend_lamports, ErrorCode::InsufficientLiquidity);

        if ctx.accounts.fund_wsol_vault.to_account_info().data_is_empty() {
            let cpi_ctx = CpiContext::new(
                ctx.accounts.associated_token_program.to_account_info(),
                anchor_spl::associated_token::Create {
                    payer: ctx.accounts.executor.to_account_info(),
                    associated_token: ctx.accounts.fund_wsol_vault.to_account_info(),
                    authority: ctx.accounts.fund_state.to_account_info(),
                    mint: ctx.accounts.wsol_mint.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
            );
            create(cpi_ctx)?;
        }

        {
            let fund_vault_info = ctx.accounts.fund_vault.to_account_info();
            let wsol_info = ctx.accounts.fund_wsol_vault.to_account_info();
            let mut fund_lamports = fund_vault_info.try_borrow_mut_lamports()?;
            let mut wsol_lamports = wsol_info.try_borrow_mut_lamports()?;
            **fund_lamports = (**fund_lamports)
                .checked_sub(spend_lamports)
                .ok_or(ErrorCode::InsufficientLiquidity)?;
            **wsol_lamports = (**wsol_lamports)
                .checked_add(spend_lamports)
                .ok_or(ErrorCode::MathOverflow)?;
        }

        let sync_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::SyncNative {
                account: ctx.accounts.fund_wsol_vault.to_account_info(),
            },
        );
        token::sync_native(sync_ctx)?;

        ctx.accounts.fund_token_vault.reload()?;
        let token_before = ctx.accounts.fund_token_vault.amount;

        invoke_signed(
            &Instruction {
                program_id: ctx.accounts.swap_program.key(),
                accounts: cpi_metas,
                data: swap_data,
            },
            &infos,
            &signer_seeds_set,
        )?;

        ctx.accounts.fund_token_vault.reload()?;

        let token_delta = ctx.accounts.fund_token_vault.amount
            .checked_sub(token_before)
            .ok_or(ErrorCode::MathOverflow)?;

        let expected_out = expected_token_out_from_sol(
            spend_lamports,
            target_decimals,
            target_price.price,
            target_price.expo,
            sol_price.price,
            sol_price.expo,
        )?;
        let min_expected = apply_max_slippage(
            expected_out,
            ctx.accounts.config.max_slippage_bps,
        )?;
        require!(token_delta >= min_expected, ErrorCode::InvalidTokenVault);
        require!(token_delta >= min_out, ErrorCode::InvalidTokenVault);
    } else {
        require!(has_fund_vault, ErrorCode::InvalidTokenVault);

        let desired_sol = abs_deviation as u64;
        let sell_amount = expected_token_out_from_sol(
            desired_sol,
            target_decimals,
            target_price.price,
            target_price.expo,
            sol_price.price,
            sol_price.expo,
        )?;
        let sell_amount = std::cmp::min(sell_amount, target_token_amount);
        require!(sell_amount > 0, ErrorCode::InvalidStrategy);

        ctx.accounts.fund_token_vault.reload()?;
        let token_before = ctx.accounts.fund_token_vault.amount;
        let sol_before = ctx.accounts.fund_vault.to_account_info().lamports();

        invoke_signed(
            &Instruction {
                program_id: ctx.accounts.swap_program.key(),
                accounts: cpi_metas,
                data: swap_data,
            },
            &infos,
            &signer_seeds_set,
        )?;

        ctx.accounts.fund_token_vault.reload()?;
        let token_after = ctx.accounts.fund_token_vault.amount;
        let sol_after = ctx.accounts.fund_vault.to_account_info().lamports();

        require!(token_after <= token_before, ErrorCode::InvalidTokenVault);
        let actual_sold = token_before
            .checked_sub(token_after)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(actual_sold > 0, ErrorCode::InvalidTokenVault);
        let sell_max = sell_amount
            .checked_add(SELL_DUST_TOLERANCE)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(actual_sold <= sell_max, ErrorCode::InvalidTokenVault);

        let sol_delta = sol_after
            .checked_sub(sol_before)
            .ok_or(ErrorCode::MathOverflow)?;
        let expected_out = expected_sol_out_from_token(
            actual_sold,
            target_decimals,
            target_price.price,
            target_price.expo,
            sol_price.price,
            sol_price.expo,
        )?;
        let min_expected = apply_max_slippage(
            expected_out,
            ctx.accounts.config.max_slippage_bps,
        )?;
        require!(sol_delta >= min_expected, ErrorCode::InvalidTokenVault);
        require!(sol_delta >= min_out, ErrorCode::InvalidTokenVault);
    }

    strategy.last_rebalance_ts = now;
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

fn abs_i128(value: i128) -> Result<i128> {
    if value >= 0 {
        Ok(value)
    } else {
        value
            .checked_abs()
            .ok_or(ErrorCode::MathOverflow.into())
    }
}

fn read_token_amount(info: &AccountInfo) -> Result<u64> {
    let data = info.data.borrow();
    let mut data_slice: &[u8] = &data;
    let account = TokenAccount::try_deserialize(&mut data_slice)
        .map_err(|_| ErrorCode::InvalidTokenVault)?;
    Ok(account.amount)
}

#[derive(Accounts)]
pub struct RebalanceStrategy<'info> {
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
    #[account(
        mut,
        seeds = [b"strategy", fund_state.key().as_ref()],
        bump = strategy.bump
    )]
    pub strategy: Account<'info, Strategy>,
    #[account(mut)]
    pub fund_token_vault: Account<'info, TokenAccount>,
    /// CHECK: created as ATA for fund_state + WSOL when needed
    #[account(mut)]
    pub fund_wsol_vault: UncheckedAccount<'info>,
    #[account(address = native_mint::ID)]
    pub wsol_mint: Account<'info, Mint>,
    /// CHECK: Pyth price feed for SOL/USD
    pub sol_price_feed: AccountInfo<'info>,
    /// CHECK: Jupiter program id
    pub swap_program: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
