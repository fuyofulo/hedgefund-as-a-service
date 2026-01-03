use anchor_lang::prelude::*;

#[account]
pub struct FundState {
    pub config: Pubkey,
    pub manager: Pubkey,
    pub fund_id: u64,
    pub fund_type: u8,
    pub share_mint: Pubkey,
    pub vault: Pubkey,
    pub total_shares: u64,
    pub min_investor_deposit_lamports: u64,
    pub withdraw_timelock_secs: i64,
    pub enabled_token_count: u16,
    pub active_limit_count: u16,
    pub active_dca_count: u16,
    pub next_order_id: u64,
    pub is_locked: bool,
    pub borrow_amount: u64,
    pub expected_min_out: u64,
    pub snapshot_sol: u64,
    pub snapshot_output: u64,
    pub output_mint: Pubkey,
    pub bump: u8,
    pub share_mint_bump: u8,
    pub vault_bump: u8,
}

impl FundState {
    pub const LEN: usize =
        32 + 32 + 8 + 1 + 32 + 32 + 8 + 8 + 8 + 2 + 2 + 2 + 8 + 1 + 8 + 8 + 8 + 8 + 32 + 1 + 1 + 1;
}

#[account]
pub struct FundVault {}

pub const FUND_TYPE_TRADING: u8 = 0;
pub const FUND_TYPE_STRATEGY: u8 = 1;
