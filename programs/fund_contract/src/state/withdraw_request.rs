use anchor_lang::prelude::*;

#[account]
pub struct WithdrawRequest {
    pub fund: Pubkey,
    pub investor: Pubkey,
    pub shares: u64,
    pub request_ts: i64,
    pub bump: u8,
}

impl WithdrawRequest {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 1;
}
