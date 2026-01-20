use anchor_lang::prelude::*;

pub const DCA_STATUS_OPEN: u8 = 0;
pub const DCA_STATUS_EXECUTED: u8 = 1;
pub const DCA_STATUS_CANCELLED: u8 = 2;

pub const DCA_SIDE_BUY: u8 = 0;
pub const DCA_SIDE_SELL: u8 = 1;

#[account]
pub struct DcaOrder {
    pub fund: Pubkey,
    pub side: u8,
    pub mint: Pubkey,
    pub total_amount: u64,
    pub slice_amount: u64,
    pub remaining_amount: u64,
    pub interval_secs: i64,
    pub next_exec_ts: i64,
    pub min_out: u64,
    pub price_feed: Pubkey,
    pub pyth_program_id: Pubkey,
    pub expiry_ts: i64,
    pub status: u8,
    pub bump: u8,
}

impl DcaOrder {
    pub const LEN: usize = 187;
}
