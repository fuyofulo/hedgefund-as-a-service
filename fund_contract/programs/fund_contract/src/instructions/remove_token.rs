use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

use crate::errors::ErrorCode;
use crate::state::fund::FundState;
use crate::state::global_config::GlobalConfig;
use crate::state::whitelist::GlobalWhitelist;

const SCOPE_GLOBAL: u8 = 0;
const SCOPE_FUND: u8 = 1;

pub fn remove_token<'info>(
    ctx: Context<'_, '_, 'info, 'info, RemoveToken<'info>>,
    scope: u8,
    fund_id: u64,
) -> Result<()> {
    match scope {
        SCOPE_GLOBAL => remove_global(ctx),
        SCOPE_FUND => remove_fund(ctx, fund_id),
        _ => err!(ErrorCode::InvalidScope),
    }
}

fn remove_global<'info>(ctx: Context<'_, '_, 'info, 'info, RemoveToken<'info>>) -> Result<()> {
    require!(
        ctx.accounts.config.admin == ctx.accounts.authority.key(),
        ErrorCode::Unauthorized
    );
    let (expected, _bump) = Pubkey::find_program_address(
        &[
            b"global_whitelist",
            ctx.accounts.config.key().as_ref(),
            ctx.accounts.mint.key().as_ref(),
        ],
        ctx.program_id,
    );
    require!(
        expected == ctx.accounts.global_whitelist.key(),
        ErrorCode::InvalidTokenVault
    );
    ctx.accounts
        .global_whitelist
        .close(ctx.accounts.authority.to_account_info())?;
    Ok(())
}

fn remove_fund<'info>(
    ctx: Context<'_, '_, 'info, 'info, RemoveToken<'info>>,
    fund_id: u64,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    require!(remaining.len() >= 3, ErrorCode::InvalidRemainingAccounts);

    let fund_state_info = &remaining[0];
    let fund_whitelist_info = &remaining[1];
    let fund_token_vault_info = &remaining[2];
    require!(fund_state_info.is_writable, ErrorCode::InvalidRemainingAccounts);

    let mut fund_state = load_fund_state(fund_state_info, ctx.program_id)?;
    let (expected_fund, _) = Pubkey::find_program_address(
        &[
            b"fund",
            ctx.accounts.config.key().as_ref(),
            fund_state.manager.as_ref(),
            fund_state.fund_id.to_le_bytes().as_ref(),
        ],
        ctx.program_id,
    );
    require!(
        expected_fund == *fund_state_info.key,
        ErrorCode::InvalidTokenVault
    );
    require!(
        fund_state.manager == ctx.accounts.authority.key(),
        ErrorCode::Unauthorized
    );
    require!(fund_state.fund_id == fund_id, ErrorCode::InvalidTokenVault);

    let (expected_whitelist, _bump) = Pubkey::find_program_address(
        &[
            b"whitelist",
            fund_state_info.key.as_ref(),
            ctx.accounts.mint.key().as_ref(),
        ],
        ctx.program_id,
    );
    require!(
        expected_whitelist == *fund_whitelist_info.key,
        ErrorCode::InvalidTokenVault
    );
    let expected_vault = anchor_spl::associated_token::get_associated_token_address(
        fund_state_info.key,
        &ctx.accounts.mint.key(),
    );
    require!(
        expected_vault == *fund_token_vault_info.key,
        ErrorCode::InvalidTokenVault
    );
    let vault: Account<TokenAccount> = Account::try_from(fund_token_vault_info)?;
    require!(vault.mint == ctx.accounts.mint.key(), ErrorCode::InvalidTokenVault);
    require!(vault.amount == 0, ErrorCode::TokenVaultNotEmpty);
    close_program_account(
        fund_whitelist_info,
        &ctx.accounts.authority.to_account_info(),
    )?;

    fund_state.enabled_token_count = fund_state
        .enabled_token_count
        .checked_sub(1)
        .ok_or(ErrorCode::MathOverflow)?;
    let mut data = fund_state_info.try_borrow_mut_data()?;
    let mut writer: &mut [u8] = &mut data;
    fund_state.try_serialize(&mut writer)?;

    Ok(())
}

fn close_program_account(account: &AccountInfo, destination: &AccountInfo) -> Result<()> {
    let lamports = account.lamports();
    **account.try_borrow_mut_lamports()? = 0;
    let mut dest_lamports = destination.try_borrow_mut_lamports()?;
    let new_balance = (*dest_lamports)
        .checked_add(lamports)
        .ok_or(ErrorCode::MathOverflow)?;
    **dest_lamports = new_balance;
    account.assign(&System::id());
    account.resize(0)?;
    Ok(())
}

fn load_fund_state<'info>(info: &AccountInfo<'info>, program_id: &Pubkey) -> Result<FundState> {
    require!(info.owner == program_id, ErrorCode::InvalidTokenVault);
    let mut data: &[u8] = &info.data.borrow();
    FundState::try_deserialize(&mut data).map_err(|_| ErrorCode::InvalidTokenVault.into())
}

#[derive(Accounts)]
pub struct RemoveToken<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"config", config.config_id.to_le_bytes().as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, GlobalConfig>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub global_whitelist: Account<'info, GlobalWhitelist>,
    pub system_program: Program<'info, System>,
}
