use anchor_lang::prelude::*;

use crate::state::global_config::GlobalConfig;

pub fn revoke_keeper(ctx: Context<RevokeKeeper>) -> Result<()> {
    ctx.accounts.config.keeper = Pubkey::default();
    Ok(())
}

#[derive(Accounts)]
#[instruction(config_id: u64)]
pub struct RevokeKeeper<'info> {
    #[account(
        mut,
        seeds = [b"config", config_id.to_le_bytes().as_ref()],
        bump = config.bump,
        has_one = admin
    )]
    pub config: Account<'info, GlobalConfig>,
    pub admin: Signer<'info>,
}
