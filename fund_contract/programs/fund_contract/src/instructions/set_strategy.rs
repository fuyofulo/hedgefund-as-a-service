use anchor_lang::prelude::*;

use crate::errors::ErrorCode;
use crate::state::fund::{FundState, FUND_TYPE_STRATEGY};
use crate::state::strategy::{StrategyAllocation, Strategy, MAX_STRATEGY_TOKENS};
use crate::state::whitelist::FundWhitelist;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StrategyAllocationInput {
    pub mint: Pubkey,
    pub weight_bps: u16,
}

pub fn set_strategy<'info>(
    ctx: Context<'_, '_, 'info, 'info, SetStrategy<'info>>,
    allocations: Vec<StrategyAllocationInput>,
    rebalance_threshold_bps: u16,
    rebalance_cooldown_secs: i64,
) -> Result<()> {
    require!(
        ctx.accounts.fund_state.manager == ctx.accounts.manager.key(),
        ErrorCode::Unauthorized
    );
    require!(
        ctx.accounts.fund_state.fund_type == FUND_TYPE_STRATEGY,
        ErrorCode::InvalidFundType
    );
    require!(!allocations.is_empty(), ErrorCode::InvalidStrategy);
    require!(allocations.len() <= MAX_STRATEGY_TOKENS, ErrorCode::InvalidStrategy);
    require!(rebalance_threshold_bps <= 10_000, ErrorCode::InvalidFeeBps);
    require!(rebalance_cooldown_secs > 0, ErrorCode::InvalidStrategy);
    require!(
        ctx.accounts.fund_state.enabled_token_count as usize == allocations.len(),
        ErrorCode::InvalidStrategy
    );

    let mut sum: u32 = 0;
    let mut seen: Vec<Pubkey> = Vec::with_capacity(allocations.len());
    for alloc in allocations.iter() {
        require!(alloc.weight_bps > 0, ErrorCode::InvalidStrategy);
        sum = sum
            .checked_add(alloc.weight_bps as u32)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(!seen.contains(&alloc.mint), ErrorCode::InvalidStrategy);
        seen.push(alloc.mint);
    }
    require!(sum == 10_000, ErrorCode::InvalidStrategy);

    require!(
        ctx.remaining_accounts.len() == allocations.len(),
        ErrorCode::InvalidRemainingAccounts
    );

    for (idx, alloc) in allocations.iter().enumerate() {
        let whitelist_info = &ctx.remaining_accounts[idx];
        let whitelist: Account<FundWhitelist> =
            Account::try_from(whitelist_info).map_err(|_| ErrorCode::InvalidTokenVault)?;
        require!(whitelist.enabled, ErrorCode::InvalidTokenVault);
        require!(whitelist.fund == ctx.accounts.fund_state.key(), ErrorCode::InvalidTokenVault);
        require!(whitelist.mint == alloc.mint, ErrorCode::InvalidTokenVault);
    }

    let config = &mut ctx.accounts.strategy;
    config.fund = ctx.accounts.fund_state.key();
    config.allocation_count = allocations.len() as u8;
    config.allocations = [StrategyAllocation::default(); MAX_STRATEGY_TOKENS];
    for (idx, alloc) in allocations.iter().enumerate() {
        config.allocations[idx] = StrategyAllocation {
            mint: alloc.mint,
            weight_bps: alloc.weight_bps,
        };
    }
    config.rebalance_threshold_bps = rebalance_threshold_bps;
    config.rebalance_cooldown_secs = rebalance_cooldown_secs;
    config.last_rebalance_ts = Clock::get()?.unix_timestamp;
    config.bump = ctx.bumps.strategy;

    Ok(())
}

#[derive(Accounts)]
pub struct SetStrategy<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,
    #[account(
        mut,
        seeds = [b"fund", fund_state.config.as_ref(), fund_state.manager.as_ref(), fund_state.fund_id.to_le_bytes().as_ref()],
        bump = fund_state.bump,
    )]
    pub fund_state: Account<'info, FundState>,
    #[account(
        init,
        payer = manager,
        space = 8 + Strategy::LEN,
        seeds = [b"strategy", fund_state.key().as_ref()],
        bump
    )]
    pub strategy: Account<'info, Strategy>,
    pub system_program: Program<'info, System>,
}
