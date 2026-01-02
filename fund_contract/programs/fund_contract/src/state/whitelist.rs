use anchor_lang::prelude::*;

#[account]
pub struct FundWhitelist {
    pub fund: Pubkey,
    pub mint: Pubkey,
    pub decimals: u8,
    pub pyth_feed: Pubkey,
    pub enabled: bool,
    pub bump: u8,
}

impl FundWhitelist {
    pub const LEN: usize = 32 + 32 + 1 + 32 + 1 + 1;
}

#[account]
pub struct GlobalWhitelist {
    pub config: Pubkey,
    pub mint: Pubkey,
    pub decimals: u8,
    pub pyth_feed: Pubkey,
    pub enabled: bool,
    pub bump: u8,
}

impl GlobalWhitelist {
    pub const LEN: usize = 32 + 32 + 1 + 32 + 1 + 1;
}
