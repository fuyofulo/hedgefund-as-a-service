use anchor_lang::prelude::*;

#[account]
pub struct GlobalConfig {
    pub config_id: u64,
    pub admin: Pubkey,
    pub fee_treasury: Pubkey,
    pub sol_usd_pyth_feed: Pubkey,
    pub pyth_program_id: Pubkey,
    pub deposit_fee_bps: u16,
    pub withdraw_fee_bps: u16,
    pub trade_fee_bps: u16,
    pub min_manager_deposit_lamports: u64,
    pub bump: u8,
}

impl GlobalConfig {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 2 + 2 + 2 + 8 + 1;
}
