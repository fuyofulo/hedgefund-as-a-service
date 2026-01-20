use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use anchor_spl::associated_token::{create, AssociatedToken};
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::ErrorCode;
use crate::state::fund::FundState;
use crate::state::global_config::GlobalConfig;
use crate::state::whitelist::{FundWhitelist, GlobalWhitelist};

const SCOPE_GLOBAL: u8 = 0;
const SCOPE_FUND: u8 = 1;

pub fn add_token<'info>(
    ctx: Context<'_, '_, 'info, 'info, AddToken<'info>>,
    scope: u8,
    fund_id: u64,
    pyth_feed: Pubkey,
) -> Result<()> {
    match scope {
        SCOPE_GLOBAL => add_global(ctx, pyth_feed),
        SCOPE_FUND => add_fund(ctx, fund_id, pyth_feed),
        _ => err!(ErrorCode::InvalidScope),
    }
}

fn add_global<'info>(
    ctx: Context<'_, '_, 'info, 'info, AddToken<'info>>,
    pyth_feed: Pubkey,
) -> Result<()> {
    require!(
        ctx.accounts.config.admin == ctx.accounts.authority.key(),
        ErrorCode::Unauthorized
    );
    require!(pyth_feed != Pubkey::default(), ErrorCode::InvalidOracle);

    let mint_key = ctx.accounts.mint.key();
    let config_key = ctx.accounts.config.key();
    let (expected, bump) = Pubkey::find_program_address(
        &[b"global_whitelist", config_key.as_ref(), mint_key.as_ref()],
        ctx.program_id,
    );
    require!(
        expected == ctx.accounts.global_whitelist.key(),
        ErrorCode::InvalidTokenVault
    );
    let global_info = ctx.accounts.global_whitelist.to_account_info();
    require!(global_info.data_is_empty(), ErrorCode::AlreadyInitialized);

    let rent = Rent::get()?;
    let space = 8 + GlobalWhitelist::LEN;
    let lamports = rent.minimum_balance(space);

    invoke_signed(
        &system_instruction::create_account(
            ctx.accounts.authority.key,
            ctx.accounts.global_whitelist.key,
            lamports,
            space as u64,
            ctx.program_id,
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.global_whitelist.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[&[
            b"global_whitelist",
            config_key.as_ref(),
            mint_key.as_ref(),
            &[bump],
        ]],
    )?;

    let mut data = global_info.data.borrow_mut();
    let mut writer: &mut [u8] = &mut data;
    let record = GlobalWhitelist {
        config: config_key,
        mint: mint_key,
        decimals: ctx.accounts.mint.decimals,
        pyth_feed,
        enabled: true,
        bump,
    };
    record.try_serialize(&mut writer)?;

    Ok(())
}

fn add_fund<'info>(
    ctx: Context<'_, '_, 'info, 'info, AddToken<'info>>,
    fund_id: u64,
    pyth_feed: Pubkey,
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
        fund_state.config == ctx.accounts.config.key(),
        ErrorCode::InvalidTokenVault
    );
    require!(
        fund_state.manager == ctx.accounts.authority.key(),
        ErrorCode::Unauthorized
    );
    require!(fund_state.fund_id == fund_id, ErrorCode::InvalidTokenVault);

    let global_whitelist =
        load_global_whitelist(&ctx.accounts.global_whitelist, ctx.program_id)?;
    require!(
        global_whitelist.config == ctx.accounts.config.key(),
        ErrorCode::InvalidTokenVault
    );
    require!(
        global_whitelist.mint == ctx.accounts.mint.key(),
        ErrorCode::InvalidTokenVault
    );
    require!(global_whitelist.enabled, ErrorCode::InvalidTokenVault);
    require!(
        global_whitelist.pyth_feed == pyth_feed,
        ErrorCode::InvalidOracle
    );

    let (fund_whitelist_key, fund_whitelist_bump) = Pubkey::find_program_address(
        &[
            b"whitelist",
            fund_state_info.key.as_ref(),
            ctx.accounts.mint.key().as_ref(),
        ],
        ctx.program_id,
    );
    require!(
        fund_whitelist_key == *fund_whitelist_info.key,
        ErrorCode::InvalidTokenVault
    );
    require!(
        fund_whitelist_info.data_is_empty(),
        ErrorCode::AlreadyInitialized
    );

    let rent = Rent::get()?;
    let space = 8 + FundWhitelist::LEN;
    let lamports = rent.minimum_balance(space);
    invoke_signed(
        &system_instruction::create_account(
            ctx.accounts.authority.key,
            fund_whitelist_info.key,
            lamports,
            space as u64,
            ctx.program_id,
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            fund_whitelist_info.clone(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[&[
            b"whitelist",
            fund_state_info.key.as_ref(),
            ctx.accounts.mint.key().as_ref(),
            &[fund_whitelist_bump],
        ]],
    )?;

    let mut whitelist_data = fund_whitelist_info.data.borrow_mut();
    let mut writer: &mut [u8] = &mut whitelist_data;
    let whitelist = FundWhitelist {
        fund: *fund_state_info.key,
        mint: ctx.accounts.mint.key(),
        decimals: global_whitelist.decimals,
        pyth_feed: global_whitelist.pyth_feed,
        enabled: true,
        bump: fund_whitelist_bump,
    };
    whitelist.try_serialize(&mut writer)?;

    let expected_vault = anchor_spl::associated_token::get_associated_token_address(
        fund_state_info.key,
        &ctx.accounts.mint.key(),
    );
    require!(
        expected_vault == *fund_token_vault_info.key,
        ErrorCode::InvalidTokenVault
    );

    if fund_token_vault_info.data_is_empty() {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            anchor_spl::associated_token::Create {
                payer: ctx.accounts.authority.to_account_info(),
                associated_token: fund_token_vault_info.clone(),
                authority: fund_state_info.clone(),
                mint: ctx.accounts.mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        );
        create(cpi_ctx)?;
    } else {
        let vault: Account<TokenAccount> = Account::try_from(fund_token_vault_info)?;
        require!(vault.owner == *fund_state_info.key, ErrorCode::InvalidTokenVault);
        require!(vault.mint == ctx.accounts.mint.key(), ErrorCode::InvalidTokenVault);
    }

    fund_state.enabled_token_count = fund_state
        .enabled_token_count
        .checked_add(1)
        .ok_or(ErrorCode::MathOverflow)?;
    let mut data = fund_state_info.try_borrow_mut_data()?;
    let mut writer: &mut [u8] = &mut data;
    fund_state.try_serialize(&mut writer)?;

    Ok(())
}

fn load_global_whitelist<'info>(
    info: &UncheckedAccount<'info>,
    program_id: &Pubkey,
) -> Result<GlobalWhitelist> {
    require!(info.owner == program_id, ErrorCode::InvalidTokenVault);
    let mut data: &[u8] = &info.data.borrow();
    GlobalWhitelist::try_deserialize(&mut data).map_err(|_| ErrorCode::InvalidTokenVault.into())
}

fn load_fund_state<'info>(info: &AccountInfo<'info>, program_id: &Pubkey) -> Result<FundState> {
    require!(info.owner == program_id, ErrorCode::InvalidTokenVault);
    let mut data: &[u8] = &info.data.borrow();
    FundState::try_deserialize(&mut data).map_err(|_| ErrorCode::InvalidTokenVault.into())
}

#[derive(Accounts)]
pub struct AddToken<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"config", config.config_id.to_le_bytes().as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, GlobalConfig>,
    pub mint: Account<'info, Mint>,
    /// CHECK: created or validated in handler.
    #[account(mut)]
    pub global_whitelist: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}
