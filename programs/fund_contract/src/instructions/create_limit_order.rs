use anchor_lang::prelude::*;
use anchor_spl::associated_token::{create, AssociatedToken};
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use anchor_spl::token::spl_token::native_mint;

use crate::errors::ErrorCode;
use crate::state::fund::{FundState, FundVault, FUND_TYPE_TRADING};
use crate::state::global_config::GlobalConfig;
use crate::state::limit_order::{LimitOrder, ORDER_STATUS_OPEN, SIDE_BUY, SIDE_SELL};
use crate::state::whitelist::FundWhitelist;

pub fn create_limit_order<'info>(
    ctx: Context<'_, '_, 'info, 'info, CreateLimitOrder<'info>>,
    side: u8,
    amount_in: u64,
    min_out: u64,
    limit_price: i64,
    price_expo: i32,
    expiry_ts: i64,
) -> Result<()> {
    require!(amount_in > 0, ErrorCode::MathOverflow);
    require!(min_out > 0, ErrorCode::InvalidMinOut);
    require!(limit_price > 0, ErrorCode::InvalidOracle);
    require!(ctx.accounts.fund_state.manager == ctx.accounts.manager.key(), ErrorCode::Unauthorized);
    require!(
        ctx.accounts.fund_state.fund_type == FUND_TYPE_TRADING,
        ErrorCode::InvalidFundType
    );

    require!(ctx.accounts.whitelist.enabled, ErrorCode::InvalidTokenVault);
    require!(ctx.accounts.whitelist.fund == ctx.accounts.fund_state.key(), ErrorCode::InvalidTokenVault);
    require!(ctx.accounts.whitelist.mint == ctx.accounts.mint.key(), ErrorCode::InvalidTokenVault);

    require!(side == SIDE_BUY || side == SIDE_SELL, ErrorCode::InvalidOrderSide);

    let order_id = ctx.accounts.fund_state.next_order_id;
    ctx.accounts.fund_state.next_order_id = order_id
        .checked_add(1)
        .ok_or(ErrorCode::MathOverflow)?;
    ctx.accounts.fund_state.active_limit_count = ctx
        .accounts
        .fund_state
        .active_limit_count
        .checked_add(1)
        .ok_or(ErrorCode::MathOverflow)?;

    let order = &mut ctx.accounts.order;
    order.fund = ctx.accounts.fund_state.key();
    order.side = side;
    order.mint = ctx.accounts.mint.key();
    order.amount_in = amount_in;
    order.min_out = min_out;
    order.limit_price = limit_price;
    order.price_expo = price_expo;
    order.price_feed = ctx.accounts.whitelist.pyth_feed;
    order.pyth_program_id = ctx.accounts.config.pyth_program_id;
    order.created_ts = Clock::get()?.unix_timestamp;
    order.expiry_ts = expiry_ts;
    order.status = ORDER_STATUS_OPEN;
    order.bump = ctx.bumps.order;

    let expected_fund_token_vault = anchor_spl::associated_token::get_associated_token_address(
        &ctx.accounts.fund_state.key(),
        &ctx.accounts.mint.key(),
    );
    require!(
        expected_fund_token_vault == ctx.accounts.fund_token_vault.key(),
        ErrorCode::InvalidTokenVault
    );
    require!(
        ctx.accounts.fund_token_vault.mint == ctx.accounts.mint.key(),
        ErrorCode::InvalidTokenVault
    );

    match side {
        SIDE_BUY => {
            let (vault_auth, _auth_bump) = Pubkey::find_program_address(
                &[b"limit_order_vault_auth", order.key().as_ref()],
                ctx.program_id,
            );
            require!(vault_auth == ctx.accounts.order_vault_auth.key(), ErrorCode::InvalidOrderVault);

            let (expected_sol_vault, sol_vault_bump) = Pubkey::find_program_address(
                &[b"limit_order_sol_vault", order.key().as_ref()],
                ctx.program_id,
            );
            require!(
                expected_sol_vault == ctx.accounts.order_sol_vault.key(),
                ErrorCode::InvalidOrderVault
            );
            if ctx.accounts.order_sol_vault.lamports() == 0 {
                let rent = Rent::get()?;
                let lamports = rent.minimum_balance(0);
                let order_key = order.key();
                let signer_seeds: &[&[u8]] = &[
                    b"limit_order_sol_vault",
                    order_key.as_ref(),
                    &[sol_vault_bump],
                ];
                let signer_seeds_set = [signer_seeds];
                let create_ctx = CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::CreateAccount {
                        from: ctx.accounts.manager.to_account_info(),
                        to: ctx.accounts.order_sol_vault.to_account_info(),
                    },
                    &signer_seeds_set,
                );
                anchor_lang::system_program::create_account(
                    create_ctx,
                    lamports,
                    0,
                    &anchor_lang::solana_program::system_program::ID,
                )?;
            }
            require!(
                ctx.accounts.order_sol_vault.owner == &anchor_lang::solana_program::system_program::ID,
                ErrorCode::InvalidOrderVault
            );

            let expected_wsol_vault = anchor_spl::associated_token::get_associated_token_address(
                &vault_auth,
                &native_mint::ID,
            );
            require!(expected_wsol_vault == ctx.accounts.order_token_vault.key(), ErrorCode::InvalidOrderVault);

            let order_token_vault_empty = ctx.accounts.order_token_vault.data_is_empty();
            if order_token_vault_empty {
                let cpi_ctx = CpiContext::new(
                    ctx.accounts.associated_token_program.to_account_info(),
                    anchor_spl::associated_token::Create {
                        payer: ctx.accounts.manager.to_account_info(),
                        associated_token: ctx.accounts.order_token_vault.to_account_info(),
                        authority: ctx.accounts.order_vault_auth.to_account_info(),
                        mint: ctx.accounts.wsol_mint.to_account_info(),
                        system_program: ctx.accounts.system_program.to_account_info(),
                        token_program: ctx.accounts.token_program.to_account_info(),
                    },
                );
                create(cpi_ctx)?;
            }

            {
                require!(
                    ctx.accounts.order_token_vault.owner == &anchor_spl::token::ID,
                    ErrorCode::InvalidOrderVault
                );
                let data = ctx.accounts.order_token_vault.data.borrow();
                let mut data_slice: &[u8] = &data;
                let order_vault = TokenAccount::try_deserialize(&mut data_slice)
                    .map_err(|_| ErrorCode::InvalidOrderVault)?;
                require!(order_vault.mint == native_mint::ID, ErrorCode::InvalidOrderVault);
                require!(order_vault.amount == 0, ErrorCode::InvalidOrderVault);
            }

            let fund_vault_balance = ctx.accounts.fund_vault.to_account_info().lamports();
            require!(fund_vault_balance >= amount_in, ErrorCode::InsufficientLiquidity);

            {
                let fund_vault_info = ctx.accounts.fund_vault.to_account_info();
                let order_sol_info = ctx.accounts.order_sol_vault.to_account_info();
                let mut fund_lamports = fund_vault_info.try_borrow_mut_lamports()?;
                let mut order_lamports = order_sol_info.try_borrow_mut_lamports()?;
                **fund_lamports = (**fund_lamports)
                    .checked_sub(amount_in)
                    .ok_or(ErrorCode::InsufficientLiquidity)?;
                **order_lamports = (**order_lamports)
                    .checked_add(amount_in)
                    .ok_or(ErrorCode::MathOverflow)?;
            }
        }
        SIDE_SELL => {
            let (vault_auth, auth_bump) = Pubkey::find_program_address(
                &[b"limit_order_vault_auth", order.key().as_ref()],
                ctx.program_id,
            );
            require!(vault_auth == ctx.accounts.order_vault_auth.key(), ErrorCode::InvalidOrderVault);

            let expected_vault = anchor_spl::associated_token::get_associated_token_address(
                &vault_auth,
                &ctx.accounts.mint.key(),
            );
            require!(expected_vault == ctx.accounts.order_token_vault.key(), ErrorCode::InvalidOrderVault);

            let order_token_vault_empty = ctx.accounts.order_token_vault.data_is_empty();
            if order_token_vault_empty {
                let cpi_ctx = CpiContext::new(
                    ctx.accounts.associated_token_program.to_account_info(),
                    anchor_spl::associated_token::Create {
                        payer: ctx.accounts.manager.to_account_info(),
                        associated_token: ctx.accounts.order_token_vault.to_account_info(),
                        authority: ctx.accounts.order_vault_auth.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        system_program: ctx.accounts.system_program.to_account_info(),
                        token_program: ctx.accounts.token_program.to_account_info(),
                    },
                );
                create(cpi_ctx)?;
            }

            {
                require!(
                    ctx.accounts.order_token_vault.owner == &anchor_spl::token::ID,
                    ErrorCode::InvalidOrderVault
                );
                let data = ctx.accounts.order_token_vault.data.borrow();
                let mut data_slice: &[u8] = &data;
                let order_vault = TokenAccount::try_deserialize(&mut data_slice)
                    .map_err(|_| ErrorCode::InvalidOrderVault)?;
                require!(order_vault.mint == ctx.accounts.mint.key(), ErrorCode::InvalidOrderVault);
                require!(order_vault.owner == ctx.accounts.order_vault_auth.key(), ErrorCode::InvalidOrderVault);
                require!(order_vault.amount == 0, ErrorCode::InvalidOrderVault);
            }

            require!(ctx.accounts.fund_token_vault.owner == ctx.accounts.fund_state.key(), ErrorCode::InvalidTokenVault);
            require!(ctx.accounts.fund_token_vault.mint == ctx.accounts.mint.key(), ErrorCode::InvalidTokenVault);

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

            let transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.fund_token_vault.to_account_info(),
                    to: ctx.accounts.order_token_vault.to_account_info(),
                    authority: ctx.accounts.fund_state.to_account_info(),
                },
                &signer_seeds_set,
            );
            token::transfer(transfer_ctx, amount_in)?;

            let _ = auth_bump;
        }
        _ => return err!(ErrorCode::InvalidOrderSide),
    }

    Ok(())
}

#[derive(Accounts)]
#[instruction(side: u8, amount_in: u64, min_out: u64, limit_price: i64, price_expo: i32, expiry_ts: i64)]
pub struct CreateLimitOrder<'info> {
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
    pub mint: Account<'info, Mint>,
    pub whitelist: Account<'info, FundWhitelist>,
    #[account(
        init,
        payer = manager,
        space = 8 + LimitOrder::LEN,
        seeds = [b"limit_order", fund_state.key().as_ref(), fund_state.next_order_id.to_le_bytes().as_ref()],
        bump
    )]
    pub order: Account<'info, LimitOrder>,
    /// CHECK: created in handler as PDA system account
    #[account(mut)]
    pub order_sol_vault: UncheckedAccount<'info>,
    /// CHECK: PDA authority for sell token vault
    pub order_vault_auth: UncheckedAccount<'info>,
    /// CHECK: created in handler when side == SELL
    #[account(mut)]
    pub order_token_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub fund_token_vault: Account<'info, TokenAccount>,
    #[account(address = native_mint::ID)]
    pub wsol_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}
