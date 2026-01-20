use anchor_lang::prelude::*;
use anchor_spl::associated_token::{create, AssociatedToken};
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use anchor_spl::token::spl_token::native_mint;

use crate::errors::ErrorCode;
use crate::state::dca_order::{DcaOrder, DCA_SIDE_BUY, DCA_SIDE_SELL, DCA_STATUS_OPEN};
use crate::state::fund::{FundState, FundVault, FUND_TYPE_TRADING};
use crate::state::global_config::GlobalConfig;
use crate::state::whitelist::FundWhitelist;

const MAX_ACTIVE_DCA: u16 = 20;

pub fn create_dca_order<'info>(
    ctx: Context<'_, '_, 'info, 'info, CreateDcaOrder<'info>>,
    side: u8,
    total_amount: u64,
    slice_amount: u64,
    interval_secs: i64,
    min_out: u64,
    expiry_ts: i64,
) -> Result<()> {
    require!(side == DCA_SIDE_BUY || side == DCA_SIDE_SELL, ErrorCode::InvalidOrderSide);
    require!(total_amount > 0, ErrorCode::MathOverflow);
    require!(slice_amount > 0, ErrorCode::InvalidDcaSlice);
    require!(slice_amount <= total_amount, ErrorCode::InvalidDcaSlice);
    require!(interval_secs > 0, ErrorCode::InvalidDcaInterval);
    require!(min_out > 0, ErrorCode::InvalidMinOut);
    require!(ctx.accounts.fund_state.manager == ctx.accounts.manager.key(), ErrorCode::Unauthorized);
    require!(
        ctx.accounts.fund_state.fund_type == FUND_TYPE_TRADING,
        ErrorCode::InvalidFundType
    );

    require!(
        ctx.accounts.fund_state.active_dca_count < MAX_ACTIVE_DCA,
        ErrorCode::MaxActiveDca
    );

    require!(ctx.accounts.whitelist.enabled, ErrorCode::InvalidTokenVault);
    require!(ctx.accounts.whitelist.fund == ctx.accounts.fund_state.key(), ErrorCode::InvalidTokenVault);
    require!(ctx.accounts.whitelist.mint == ctx.accounts.mint.key(), ErrorCode::InvalidTokenVault);

    let order_id = ctx.accounts.fund_state.next_order_id;
    ctx.accounts.fund_state.next_order_id = order_id
        .checked_add(1)
        .ok_or(ErrorCode::MathOverflow)?;
    ctx.accounts.fund_state.active_dca_count = ctx.accounts.fund_state.active_dca_count
        .checked_add(1)
        .ok_or(ErrorCode::MathOverflow)?;

    let now = Clock::get()?.unix_timestamp;
    let order = &mut ctx.accounts.order;
    order.fund = ctx.accounts.fund_state.key();
    order.side = side;
    order.mint = ctx.accounts.mint.key();
    order.total_amount = total_amount;
    order.slice_amount = slice_amount;
    order.remaining_amount = total_amount;
    order.interval_secs = interval_secs;
    order.next_exec_ts = now
        .checked_add(interval_secs)
        .ok_or(ErrorCode::MathOverflow)?;
    order.min_out = min_out;
    order.price_feed = ctx.accounts.whitelist.pyth_feed;
    order.pyth_program_id = ctx.accounts.config.pyth_program_id;
    order.expiry_ts = expiry_ts;
    order.status = DCA_STATUS_OPEN;
    order.bump = ctx.bumps.order;

    let (expected_sol_vault, sol_vault_bump) = Pubkey::find_program_address(
        &[b"dca_order_sol_vault", order.key().as_ref()],
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
            b"dca_order_sol_vault",
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

    let (vault_auth, _auth_bump) = Pubkey::find_program_address(
        &[b"dca_order_vault_auth", order.key().as_ref()],
        ctx.program_id,
    );
    require!(vault_auth == ctx.accounts.order_vault_auth.key(), ErrorCode::InvalidOrderVault);

    match side {
        DCA_SIDE_BUY => {
            let expected_wsol_vault = anchor_spl::associated_token::get_associated_token_address(
                &vault_auth,
                &native_mint::ID,
            );
            require!(
                expected_wsol_vault == ctx.accounts.order_token_vault.key(),
                ErrorCode::InvalidOrderVault
            );

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
            require!(fund_vault_balance >= total_amount, ErrorCode::InsufficientLiquidity);

            {
                let fund_vault_info = ctx.accounts.fund_vault.to_account_info();
                let order_sol_info = ctx.accounts.order_sol_vault.to_account_info();
                let mut fund_lamports = fund_vault_info.try_borrow_mut_lamports()?;
                let mut order_lamports = order_sol_info.try_borrow_mut_lamports()?;
                **fund_lamports = (**fund_lamports)
                    .checked_sub(total_amount)
                    .ok_or(ErrorCode::InsufficientLiquidity)?;
                **order_lamports = (**order_lamports)
                    .checked_add(total_amount)
                    .ok_or(ErrorCode::MathOverflow)?;
            }
        }
        DCA_SIDE_SELL => {
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
            token::transfer(transfer_ctx, total_amount)?;
        }
        _ => return err!(ErrorCode::InvalidOrderSide),
    }

    Ok(())
}

#[derive(Accounts)]
#[instruction(side: u8, total_amount: u64, slice_amount: u64, interval_secs: i64, min_out: u64, expiry_ts: i64)]
pub struct CreateDcaOrder<'info> {
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
        space = 8 + DcaOrder::LEN,
        seeds = [b"dca_order", fund_state.key().as_ref(), fund_state.next_order_id.to_le_bytes().as_ref()],
        bump
    )]
    pub order: Account<'info, DcaOrder>,
    /// CHECK: created in handler as PDA system account
    #[account(mut)]
    pub order_sol_vault: UncheckedAccount<'info>,
    /// CHECK: PDA authority for DCA order vault
    pub order_vault_auth: UncheckedAccount<'info>,
    /// CHECK: created in handler as ATA
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
