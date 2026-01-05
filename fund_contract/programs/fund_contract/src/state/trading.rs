use anchor_lang::prelude::*;

#[account]
pub struct Trading {
    pub fund: Pubkey,
    pub is_locked: bool,
    pub borrow_amount: u64,
    pub expected_min_out: u64,
    pub snapshot_sol: u64,
    pub snapshot_output: u64,
    pub output_mint: Pubkey,
    pub bump: u8,
}

impl Trading {
    pub const LEN: usize = 32 + 1 + 8 + 8 + 8 + 8 + 32 + 1;
}
