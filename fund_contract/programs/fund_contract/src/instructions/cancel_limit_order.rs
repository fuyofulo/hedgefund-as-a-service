use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount};
use anchor_spl::token::spl_token::native_mint;

use crate::errors::ErrorCode;
use crate::state::fund::{FundState, FundVault, FUND_TYPE_TRADING};
use crate::state::global_config::GlobalConfig;
use crate::state::limit_order::{LimitOrder, ORDER_STATUS_CANCELLED, ORDER_STATUS_OPEN, SIDE_BUY, SIDE_SELL};
use crate::state::whitelist::FundWhitelist;

pub fn cancel_limit_order<'info>(
    ctx: Context<'_, '_, 'info, 'info, CancelLimitOrder<'info>>,
) -> Result<()> {
    let order = &mut ctx.accounts.order;
    require!(order.status == ORDER_STATUS_OPEN, ErrorCode::OrderNotOpen);
    require!(ctx.accounts.fund_state.manager == ctx.accounts.manager.key(), ErrorCode::Unauthorized);
    require!(
        ctx.accounts.fund_state.fund_type == FUND_TYPE_TRADING,
        ErrorCode::InvalidFundType
    );
    require!(order.fund == ctx.accounts.fund_state.key(), ErrorCode::InvalidTokenVault);

    match order.side {
        SIDE_BUY => {
            let (vault_auth, vault_auth_bump) = Pubkey::find_program_address(
                &[b"limit_order_vault_auth", order.key().as_ref()],
                ctx.program_id,
            );
            require!(vault_auth == ctx.accounts.order_vault_auth.key(), ErrorCode::InvalidOrderVault);
            require!(ctx.accounts.order_token_vault.mint == native_mint::ID, ErrorCode::InvalidOrderVault);
            require!(
                ctx.accounts.order_token_vault.owner == ctx.accounts.order_vault_auth.key(),
                ErrorCode::InvalidOrderVault
            );

            let order_key = order.key();

            let (expected_sol_vault, sol_vault_bump) = Pubkey::find_program_address(
                &[b"limit_order_sol_vault", order_key.as_ref()],
                ctx.program_id,
            );
            require!(expected_sol_vault == ctx.accounts.order_sol_vault.key(), ErrorCode::InvalidOrderVault);
            require!(
                ctx.accounts.order_sol_vault.owner == &anchor_lang::solana_program::system_program::ID,
                ErrorCode::InvalidOrderVault
            );

            let sol_vault_seeds: &[&[u8]] = &[
                b"limit_order_sol_vault",
                order_key.as_ref(),
                &[sol_vault_bump],
            ];
            let sol_vault_signer = [sol_vault_seeds];
            let sol_balance = ctx.accounts.order_sol_vault.to_account_info().lamports();
            if sol_balance > 0 {
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

            let signer_seeds: &[&[u8]] = &[
                b"limit_order_vault_auth",
                order_key.as_ref(),
                &[vault_auth_bump],
            ];
            let signer_seeds_set = [signer_seeds];
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
            } else {
                return err!(ErrorCode::InvalidOrderVault);
            }
        }
        SIDE_SELL => {
            let (vault_auth, vault_auth_bump) = Pubkey::find_program_address(
                &[b"limit_order_vault_auth", order.key().as_ref()],
                ctx.program_id,
            );
            require!(vault_auth == ctx.accounts.order_vault_auth.key(), ErrorCode::InvalidOrderVault);
            let order_key = order.key();

            let expected_order_vault = anchor_spl::associated_token::get_associated_token_address(
                &vault_auth,
                &order.mint,
            );
            require!(expected_order_vault == ctx.accounts.order_token_vault.key(), ErrorCode::InvalidOrderVault);
            require!(
                ctx.accounts.order_token_vault.mint == order.mint,
                ErrorCode::InvalidOrderVault
            );

            require!(ctx.accounts.fund_token_vault.owner == ctx.accounts.fund_state.key(), ErrorCode::InvalidTokenVault);
            require!(ctx.accounts.fund_token_vault.mint == order.mint, ErrorCode::InvalidTokenVault);

            let signer_seeds: &[&[u8]] = &[
                b"limit_order_vault_auth",
                order_key.as_ref(),
                &[vault_auth_bump],
            ];
            let signer_seeds_set = [signer_seeds];

            let transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.order_token_vault.to_account_info(),
                    to: ctx.accounts.fund_token_vault.to_account_info(),
                    authority: ctx.accounts.order_vault_auth.to_account_info(),
                },
                &signer_seeds_set,
            );
            let amount = ctx.accounts.order_token_vault.amount;
            if amount > 0 {
                token::transfer(transfer_ctx, amount)?;
            }

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
        _ => return err!(ErrorCode::InvalidOrderSide),
    }

    order.status = ORDER_STATUS_CANCELLED;
    ctx.accounts.fund_state.active_limit_count = ctx
        .accounts
        .fund_state
        .active_limit_count
        .checked_sub(1)
        .ok_or(ErrorCode::MathOverflow)?;

    Ok(())
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct CancelLimitOrder<'info> {
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
    pub whitelist: Account<'info, FundWhitelist>,
    #[account(mut)]
    pub fund_token_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"limit_order", fund_state.key().as_ref(), order_id.to_le_bytes().as_ref()],
        bump = order.bump,
        close = fund_vault
    )]
    pub order: Account<'info, LimitOrder>,
    /// CHECK: validated against derived PDA in handler
    #[account(mut)]
    pub order_sol_vault: UncheckedAccount<'info>,
    /// CHECK: PDA authority for sell token vault
    pub order_vault_auth: UncheckedAccount<'info>,
    #[account(mut)]
    pub order_token_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
