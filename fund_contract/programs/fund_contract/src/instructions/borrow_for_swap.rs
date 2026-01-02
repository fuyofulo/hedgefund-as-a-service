use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_lang::solana_program::sysvar::instructions::ID as IX_SYSVAR_ID;
use anchor_spl::token::TokenAccount;

use crate::errors::ErrorCode;
use crate::state::fund::{FundState, FundVault};
use crate::state::global_config::GlobalConfig;
use crate::state::whitelist::FundWhitelist;

pub fn borrow_for_swap<'info>(
    ctx: Context<'_, '_, 'info, 'info, BorrowForSwap<'info>>,
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    require!(!ctx.accounts.fund_state.is_locked, ErrorCode::FundLocked);
    require!(amount_in > 0, ErrorCode::MathOverflow);
    require!(min_amount_out > 0, ErrorCode::InvalidMinOut);

    require!(
        ctx.accounts.fund_state.manager == ctx.accounts.manager.key(),
        ErrorCode::Unauthorized
    );
    require!(
        ctx.accounts.manager_receive.key() == ctx.accounts.manager.key(),
        ErrorCode::InvalidReceiver
    );
    require!(ctx.accounts.output_whitelist.enabled, ErrorCode::InvalidTokenVault);
    require!(
        ctx.accounts.output_whitelist.fund == ctx.accounts.fund_state.key(),
        ErrorCode::InvalidTokenVault
    );
    let (expected_whitelist, _) = Pubkey::find_program_address(
        &[
            b"whitelist",
            ctx.accounts.fund_state.key().as_ref(),
            ctx.accounts.output_whitelist.mint.as_ref(),
        ],
        ctx.program_id,
    );
    require!(
        expected_whitelist == ctx.accounts.output_whitelist.key(),
        ErrorCode::InvalidTokenVault
    );

    let expected_vault = anchor_spl::associated_token::get_associated_token_address(
        &ctx.accounts.fund_state.key(),
        &ctx.accounts.output_whitelist.mint,
    );
    require!(
        expected_vault == ctx.accounts.output_token_vault.key(),
        ErrorCode::InvalidTokenVault
    );
    require!(
        ctx.accounts.output_token_vault.mint == ctx.accounts.output_whitelist.mint,
        ErrorCode::InvalidTokenVault
    );

    let vault_balance = ctx.accounts.fund_vault.to_account_info().lamports();
    require!(vault_balance >= amount_in, ErrorCode::InsufficientLiquidity);

    let ix_sysvar = &ctx.accounts.instructions_sysvar;
    require!(ix_sysvar.key() == IX_SYSVAR_ID, ErrorCode::InvalidSettleInstruction);
    let current_idx = load_current_index_checked(ix_sysvar)? as usize;
    let settle_discriminator = SETTLE_SWAP_DISCRIMINATOR;
    let expected_settle_accounts = [
        ctx.accounts.manager.key(),
        ctx.accounts.config.key(),
        ctx.accounts.fund_state.key(),
        ctx.accounts.fund_vault.key(),
        ctx.accounts.output_whitelist.key(),
        ctx.accounts.output_token_vault.key(),
    ];
    let mut found = false;
    let mut scan_idx = current_idx + 1;
    while let Ok(ix) = load_instruction_at_checked(scan_idx, ix_sysvar) {
        if ix.program_id == crate::ID && ix.data.starts_with(&settle_discriminator) {
            if ix.accounts.len() >= expected_settle_accounts.len()
                && expected_settle_accounts
                    .iter()
                    .enumerate()
                    .all(|(idx, key)| ix.accounts[idx].pubkey == *key)
            {
                found = true;
            } else {
                return err!(ErrorCode::InvalidSettleInstruction);
            }
            break;
        }
        scan_idx += 1;
    }
    require!(found, ErrorCode::MissingSettleInstruction);

    ctx.accounts.fund_state.is_locked = true;
    ctx.accounts.fund_state.borrow_amount = amount_in;
    ctx.accounts.fund_state.expected_min_out = min_amount_out;
    ctx.accounts.fund_state.snapshot_sol = vault_balance;
    ctx.accounts.fund_state.snapshot_output = ctx.accounts.output_token_vault.amount;
    ctx.accounts.fund_state.output_mint = ctx.accounts.output_whitelist.mint;

    {
        let fund_vault_info = ctx.accounts.fund_vault.to_account_info();
        let manager_info = ctx.accounts.manager_receive.to_account_info();
        let mut vault_lamports = fund_vault_info.try_borrow_mut_lamports()?;
        let mut manager_lamports = manager_info.try_borrow_mut_lamports()?;

        **vault_lamports = (**vault_lamports)
            .checked_sub(amount_in)
            .ok_or(ErrorCode::InsufficientLiquidity)?;
        **manager_lamports = (**manager_lamports)
            .checked_add(amount_in)
            .ok_or(ErrorCode::MathOverflow)?;
    }

    Ok(())
}

const SETTLE_SWAP_DISCRIMINATOR: [u8; 8] = [3, 130, 133, 180, 251, 87, 242, 250];

#[derive(Accounts)]
pub struct BorrowForSwap<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,
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
    #[account(mut)]
    pub manager_receive: SystemAccount<'info>,
    pub output_whitelist: Account<'info, FundWhitelist>,
    #[account(mut)]
    pub output_token_vault: Account<'info, TokenAccount>,
    /// CHECK: instruction sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}
