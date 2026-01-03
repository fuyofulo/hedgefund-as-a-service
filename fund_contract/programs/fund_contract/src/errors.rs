use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Fee bps must be <= 10000.")]
    InvalidFeeBps,
    #[msg("Withdraw timelock must be >= 0.")]
    InvalidTimelock,
    #[msg("Invalid remaining accounts layout.")]
    InvalidRemainingAccounts,
    #[msg("Invalid whitelist ordering.")]
    InvalidWhitelistOrder,
    #[msg("Oracle price is stale or unavailable.")]
    StaleOracle,
    #[msg("Oracle price is invalid.")]
    InvalidOracle,
    #[msg("Oracle confidence too wide.")]
    InvalidOracleConfidence,
    #[msg("Invalid NAV.")]
    InvalidNav,
    #[msg("Math overflow.")]
    MathOverflow,
    #[msg("Invalid token vault.")]
    InvalidTokenVault,
    #[msg("Deposit below minimum.")]
    DepositTooSmall,
    #[msg("Invalid withdrawal request.")]
    InvalidWithdrawal,
    #[msg("Insufficient shares.")]
    InsufficientShares,
    #[msg("Withdrawal timelock not elapsed.")]
    WithdrawTimelock,
    #[msg("Insufficient fund liquidity.")]
    InsufficientLiquidity,
    #[msg("Unauthorized.")]
    Unauthorized,
    #[msg("Invalid scope.")]
    InvalidScope,
    #[msg("Already initialized.")]
    AlreadyInitialized,
    #[msg("Fund is already locked.")]
    FundLocked,
    #[msg("Fund is not locked.")]
    FundNotLocked,
    #[msg("Missing settle instruction.")]
    MissingSettleInstruction,
    #[msg("Invalid settle instruction.")]
    InvalidSettleInstruction,
    #[msg("Invalid receiver.")]
    InvalidReceiver,
    #[msg("min_out must be greater than zero.")]
    InvalidMinOut,
    #[msg("Deposit results in zero shares.")]
    ZeroShares,
    #[msg("Token vault must be empty before removal.")]
    TokenVaultNotEmpty,
    #[msg("Order is not open.")]
    OrderNotOpen,
    #[msg("Order has expired.")]
    OrderExpired,
    #[msg("Order trigger condition not met.")]
    OrderNotTriggered,
    #[msg("Invalid order vault.")]
    InvalidOrderVault,
    #[msg("Invalid order side.")]
    InvalidOrderSide,
    #[msg("Invalid swap program.")]
    InvalidSwapProgram,
    #[msg("Invalid DCA interval.")]
    InvalidDcaInterval,
    #[msg("Invalid DCA slice amount.")]
    InvalidDcaSlice,
    #[msg("DCA not ready to execute.")]
    DcaNotReady,
    #[msg("DCA is completed.")]
    DcaCompleted,
    #[msg("Maximum active DCA orders reached.")]
    MaxActiveDca,
    #[msg("Invalid keeper key.")]
    InvalidKeeper,
    #[msg("Invalid fund type for this instruction.")]
    InvalidFundType,
    #[msg("Invalid strategy configuration.")]
    InvalidStrategyConfig,
    #[msg("Rebalance not needed.")]
    RebalanceNotNeeded,
    #[msg("WSOL must be swept before rebalance.")]
    WsolNotCleared,
}
