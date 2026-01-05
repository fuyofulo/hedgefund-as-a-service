use anchor_lang::prelude::*;

pub const MAX_STRATEGY_TOKENS: usize = 8;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct StrategyAllocation {
    pub mint: Pubkey,
    pub weight_bps: u16,
}

#[account]
pub struct Strategy {
    pub fund: Pubkey,
    pub allocation_count: u8,
    pub allocations: [StrategyAllocation; MAX_STRATEGY_TOKENS],
    pub rebalance_threshold_bps: u16,
    pub rebalance_cooldown_secs: i64,
    pub last_rebalance_ts: i64,
    pub bump: u8,
}

impl Strategy {
    pub const LEN: usize = 32 + 1 + (32 + 2) * MAX_STRATEGY_TOKENS + 2 + 8 + 8 + 1;
}
