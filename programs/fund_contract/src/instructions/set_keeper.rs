use anchor_lang::prelude::*;

use crate::errors::ErrorCode;
use crate::state::global_config::GlobalConfig;

pub fn set_keeper(ctx: Context<SetKeeper>, new_keeper: Pubkey) -> Result<()> {
    require!(new_keeper != Pubkey::default(), ErrorCode::InvalidKeeper);
    ctx.accounts.config.keeper = new_keeper;
    Ok(())
}

#[derive(Accounts)]
#[instruction(config_id: u64)]
pub struct SetKeeper<'info> {
    #[account(
        mut,
        seeds = [b"config", config_id.to_le_bytes().as_ref()],
        bump = config.bump,
        has_one = admin
    )]
    pub config: Account<'info, GlobalConfig>,
    pub admin: Signer<'info>,
}
