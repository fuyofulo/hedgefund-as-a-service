use anchor_lang::prelude::*;

pub const ORDER_STATUS_OPEN: u8 = 0;
pub const ORDER_STATUS_EXECUTED: u8 = 1;
pub const ORDER_STATUS_CANCELLED: u8 = 2;

pub const SIDE_BUY: u8 = 0;
pub const SIDE_SELL: u8 = 1;

#[account]
pub struct LimitOrder {
    pub fund: Pubkey,
    pub side: u8,
    pub mint: Pubkey,
    pub amount_in: u64,
    pub min_out: u64,
    pub limit_price: i64,
    pub price_expo: i32,
    pub price_feed: Pubkey,
    pub pyth_program_id: Pubkey,
    pub created_ts: i64,
    pub expiry_ts: i64,
    pub status: u8,
    pub bump: u8,
}

impl LimitOrder {
    pub const LEN: usize = 32 + 1 + 32 + 8 + 8 + 8 + 4 + 32 + 32 + 8 + 8 + 1 + 1;
}
