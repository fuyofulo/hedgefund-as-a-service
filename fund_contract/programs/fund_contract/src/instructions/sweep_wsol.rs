use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount};
use anchor_spl::token::spl_token::native_mint;

use crate::errors::ErrorCode;
use crate::state::fund::{FundState, FundVault};
use crate::state::global_config::GlobalConfig;

pub fn sweep_wsol<'info>(
    ctx: Context<'_, '_, 'info, 'info, SweepWsol<'info>>,
) -> Result<()> {
    require!(
        ctx.accounts.executor.key() == ctx.accounts.config.keeper,
        ErrorCode::Unauthorized
    );

    let fund_key = ctx.accounts.fund_state.key();
    let expected_wsol = anchor_spl::associated_token::get_associated_token_address(
        &fund_key,
        &native_mint::ID,
    );
    require!(
        expected_wsol == ctx.accounts.fund_wsol_vault.key(),
        ErrorCode::InvalidOrderVault
    );

    if ctx
        .accounts
        .fund_wsol_vault
        .to_account_info()
        .data_is_empty()
    {
        return Ok(());
    }

    {
        let wsol_info = ctx.accounts.fund_wsol_vault.to_account_info();
        let data = wsol_info.data.borrow();
        let mut data_slice: &[u8] = &data;
        let wsol_vault = TokenAccount::try_deserialize(&mut data_slice)
            .map_err(|_| ErrorCode::InvalidTokenVault)?;
        require!(wsol_vault.mint == native_mint::ID, ErrorCode::InvalidTokenVault);
        require!(
            wsol_vault.owner == ctx.accounts.fund_state.key(),
            ErrorCode::InvalidTokenVault
        );
    }

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

    let sync_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        token::SyncNative {
            account: ctx.accounts.fund_wsol_vault.to_account_info(),
        },
    );
    token::sync_native(sync_ctx)?;

    let close_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.fund_wsol_vault.to_account_info(),
            destination: ctx.accounts.fund_vault.to_account_info(),
            authority: ctx.accounts.fund_state.to_account_info(),
        },
        &signer_seeds_set,
    );
    token::close_account(close_ctx)?;

    Ok(())
}

#[derive(Accounts)]
pub struct SweepWsol<'info> {
    pub executor: Signer<'info>,
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
        seeds = [b"vault", fund_state.key().as_ref()],
        bump = fund_state.vault_bump
    )]
    pub fund_vault: Account<'info, FundVault>,
    /// CHECK: validated as ATA for fund_state + WSOL
    #[account(mut)]
    pub fund_wsol_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
