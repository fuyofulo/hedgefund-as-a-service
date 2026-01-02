use anchor_lang::prelude::*;
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token::{mint_to, Mint, MintTo, Token, TokenAccount};
use pyth_sdk_solana::state::SolanaPriceAccount;

use crate::errors::ErrorCode;
use crate::state::fund::{FundState, FundVault};
use crate::state::global_config::GlobalConfig;
use crate::state::whitelist::FundWhitelist;

const ORACLE_MAX_AGE_SECS: u64 = 60;
const LAMPORTS_PER_SOL_U64: u64 = 1_000_000_000;
const MAX_CONF_BPS: u64 = 200;

pub fn deposit<'info>(
    ctx: Context<'_, '_, 'info, 'info, Deposit<'info>>,
    amount_lamports: u64,
) -> Result<()> {
    require!(
        amount_lamports >= ctx.accounts.fund_state.min_investor_deposit_lamports,
        ErrorCode::DepositTooSmall
    );

    let fee_bps = ctx.accounts.config.deposit_fee_bps as u128;
    let amount_u128 = amount_lamports as u128;
    let fee_lamports = amount_u128
        .checked_mul(fee_bps)
        .ok_or(ErrorCode::MathOverflow)?
        / 10_000;
    let net_lamports = amount_u128
        .checked_sub(fee_lamports)
        .ok_or(ErrorCode::MathOverflow)? as u64;

    let fund_vault_balance = ctx.accounts.fund_vault.to_account_info().lamports();
    let nav_lamports = compute_nav_lamports(
        ctx.program_id,
        ctx.accounts.fund_state.key(),
        fund_vault_balance,
        ctx.accounts.config.sol_usd_pyth_feed,
        ctx.accounts.config.pyth_program_id,
        ctx.accounts.fund_state.enabled_token_count,
        ctx.remaining_accounts,
    )?;

    let total_shares = ctx.accounts.fund_state.total_shares as u128;
    require!(nav_lamports > 0, ErrorCode::MathOverflow);
    require!(total_shares > 0, ErrorCode::MathOverflow);

    let shares_to_mint = (net_lamports as u128)
        .checked_mul(total_shares)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(nav_lamports as u128)
        .ok_or(ErrorCode::MathOverflow)? as u64;
    require!(shares_to_mint > 0, ErrorCode::ZeroShares);

    let fee_treasury = &ctx.accounts.fee_treasury;
    let fund_vault = &ctx.accounts.fund_vault;

    let fee_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        anchor_lang::system_program::Transfer {
            from: ctx.accounts.investor.to_account_info(),
            to: fee_treasury.to_account_info(),
        },
    );
    if fee_lamports > 0 {
        anchor_lang::system_program::transfer(fee_ctx, fee_lamports as u64)?;
    }

    let vault_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        anchor_lang::system_program::Transfer {
            from: ctx.accounts.investor.to_account_info(),
            to: fund_vault.to_account_info(),
        },
    );
    if net_lamports > 0 {
        anchor_lang::system_program::transfer(vault_ctx, net_lamports)?;
    }

    let config_key = ctx.accounts.config.key();
    let manager_key = ctx.accounts.fund_state.manager;
    let fund_id_bytes = ctx.accounts.fund_state.fund_id.to_le_bytes();
    let signer_seeds: &[&[u8]] = &[
        b"fund",
        config_key.as_ref(),
        manager_key.as_ref(),
        fund_id_bytes.as_ref(),
        &[ctx.accounts.fund_state.bump],
    ];
    let signer_seeds_set = [signer_seeds];

    let mint_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        MintTo {
            mint: ctx.accounts.share_mint.to_account_info(),
            to: ctx.accounts.investor_share_account.to_account_info(),
            authority: ctx.accounts.fund_state.to_account_info(),
        },
        &signer_seeds_set,
    );
    mint_to(mint_ctx, shares_to_mint)?;

    let fund_state = &mut ctx.accounts.fund_state;
    fund_state.total_shares = fund_state
        .total_shares
        .checked_add(shares_to_mint)
        .ok_or(ErrorCode::MathOverflow)?;

    Ok(())
}

#[derive(Accounts)]
pub struct Deposit<'info> {
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
        init_if_needed,
        payer = investor,
        associated_token::mint = share_mint,
        associated_token::authority = investor
    )]
    pub investor_share_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub fee_treasury: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

pub(crate) fn compute_nav_lamports<'info>(
    program_id: &Pubkey,
    fund_key: Pubkey,
    sol_lamports: u64,
    sol_usd_pyth_feed: Pubkey,
    pyth_program_id: Pubkey,
    enabled_token_count: u16,
    remaining: &'info [AccountInfo<'info>],
) -> Result<u64> {
    let mut nav = sol_lamports as i128;

    if enabled_token_count == 0 {
        require!(
            remaining.is_empty(),
            ErrorCode::InvalidRemainingAccounts
        );
        return Ok(nav as u64);
    }

    require!(
        remaining.len() == 1 + 3 * (enabled_token_count as usize),
        ErrorCode::InvalidRemainingAccounts
    );

    let mut idx = 1;
    let mut prev_mint: Option<Pubkey> = None;
    while idx < remaining.len() {
        let whitelist_info = &remaining[idx];
        let whitelist: Account<FundWhitelist> = Account::try_from(whitelist_info)?;
        let (expected_whitelist, _) = Pubkey::find_program_address(
            &[b"whitelist", fund_key.as_ref(), whitelist.mint.as_ref()],
            program_id,
        );
        require!(
            expected_whitelist == *whitelist_info.key,
            ErrorCode::InvalidTokenVault
        );
        require!(whitelist.enabled, ErrorCode::InvalidTokenVault);
        require!(
            whitelist.fund == fund_key,
            ErrorCode::InvalidTokenVault
        );
        if let Some(prev) = prev_mint {
            require!(
                prev.to_bytes() < whitelist.mint.to_bytes(),
                ErrorCode::InvalidWhitelistOrder
            );
        }
        prev_mint = Some(whitelist.mint);
        idx += 3;
    }

    let clock = Clock::get()?;
    let sol_price_info = &remaining[0];
    require!(
        sol_price_info.key == &sol_usd_pyth_feed,
        ErrorCode::InvalidOracle
    );
    require!(
        sol_price_info.owner == &pyth_program_id,
        ErrorCode::InvalidOracle
    );
    let sol_price = load_pyth_price(sol_price_info, &clock)?;

    let mut idx = 1;
    while idx < remaining.len() {
        let whitelist_info = &remaining[idx];
        let token_vault_info = &remaining[idx + 1];
        let token_price_info = &remaining[idx + 2];
        idx += 3;

        let whitelist: Account<FundWhitelist> = Account::try_from(whitelist_info)?;

        let token_vault: Account<TokenAccount> = Account::try_from(token_vault_info)?;
        let expected_vault = get_associated_token_address(&fund_key, &whitelist.mint);
        require!(
            expected_vault == *token_vault_info.key,
            ErrorCode::InvalidTokenVault
        );
        require!(token_vault.owner == fund_key, ErrorCode::InvalidTokenVault);
        require!(
            token_vault.mint == whitelist.mint,
            ErrorCode::InvalidTokenVault
        );

        require!(
            token_price_info.key == &whitelist.pyth_feed,
            ErrorCode::InvalidOracle
        );
        require!(
            token_price_info.owner == &pyth_program_id,
            ErrorCode::InvalidOracle
        );
        let token_price = load_pyth_price(token_price_info, &clock)?;
        let value = token_value_in_lamports(
            token_vault.amount,
            whitelist.decimals,
            token_price.price,
            token_price.expo,
            sol_price.price,
            sol_price.expo,
        )?;
        nav = nav
            .checked_add(value as i128)
            .ok_or(ErrorCode::MathOverflow)?;
    }

    require!(nav > 0, ErrorCode::InvalidNav);
    Ok(nav as u64)
}

fn token_value_in_lamports(
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

fn pow10_i128(exp: u32) -> Result<i128> {
    let mut value: i128 = 1;
    for _ in 0..exp {
        value = value.checked_mul(10).ok_or(ErrorCode::MathOverflow)?;
    }
    Ok(value)
}

struct PythPrice {
    price: i64,
    expo: i32,
}

fn load_pyth_price(price_info: &AccountInfo, clock: &Clock) -> Result<PythPrice> {
    let feed = SolanaPriceAccount::account_info_to_feed(price_info)
        .map_err(|_| ErrorCode::InvalidOracle)?;
    let price = feed
        .get_price_no_older_than(clock.unix_timestamp, ORACLE_MAX_AGE_SECS)
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
