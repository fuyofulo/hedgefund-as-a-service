# Fund Contract (Solana / Anchor)

This program implements a hedge-fund-style pool on Solana. Managers create funds, investors deposit SOL to receive shares based on NAV, and managers trade whitelisted tokens using an atomic borrow/settle pattern.

## Architecture Diagram

```
                           +-----------------------------+
                           |          Platform           |
                           |  GlobalConfig (PDA)         |
                           |  - admin                    |
                           |  - fee treasury             |
                           |  - Pyth program + SOL feed  |
                           +--------------+--------------+
                                          |
                                          | approves mints
                                          v
                           +-----------------------------+
                           |   GlobalWhitelist (PDA)     |
                           |  ["global_whitelist",       |
                           |   config, mint]             |
                           +--------------+--------------+
                                          |
                                          | manager opts-in
                                          v
+---------------------------- Fund (PDA) ---------------------------------+
| FundState ["fund", config, manager, fund_id]                             |
| - share_mint                                                             |
| - vault (SOL PDA)                                                        |
| - enabled_token_count                                                    |
| - trade lock state                                                       |
+--------------------+-----------------------------+-----------------------+
                     |                             |
                share mint                    SOL vault (PDA)
                     |                             |
                     v                             v
                SPL shares                   lamports balance
                     |
            investors hold shares
                     |
+--------------------+-----------------------------+
|             FundWhitelist (PDA)                  |
|   ["whitelist", fund, mint]                      |
|   - mint + decimals + pyth_feed + enabled        |
+--------------------+-----------------------------+
                     |
                     v
            Token vault ATA
       (owner = fund PDA)
```

## Core Concepts

### Global Configuration
The platform admin initializes a `GlobalConfig` PDA that pins:
- The Pyth program id and SOL/USD feed.
- Fee bps for deposit/withdraw/trade.
- A fee treasury address.
- Minimum manager deposit for fund creation.

### Whitelists
There are two levels of whitelists:
1) `GlobalWhitelist` PDAs: platform-approved mints + their Pyth feeds.
2) `FundWhitelist` PDAs: per-fund allowlist, limited to globally approved mints.

### Fund State
- Each fund has its own `FundState` PDA with a share mint and a program-owned SOL vault.
- Funds track `enabled_token_count` which is used to enforce complete NAV calculation.

### Shares
- Shares are SPL tokens minted by the fund PDA.
- Shares are minted during fund creation (manager seed deposit) and on each deposit.
- Shares are burned during withdrawals.

## Accounts / PDAs
- GlobalConfig: `["config", config_id]`
- GlobalWhitelist: `["global_whitelist", config, mint]`
- FundState: `["fund", config, manager, fund_id]`
- FundWhitelist: `["whitelist", fund, mint]`
- Share mint: `["shares", fund]`
- Fund vault: `["vault", fund]` (program-owned SOL account)
- Withdraw request: `["withdraw", fund, investor]`

Token vaults are ATAs for `(fund PDA, mint)`.

## Instruction Flows

Each instruction implements the flows described in `SPEC.md`. This section explains the high-level steps and validations so you can understand the contract without reading the code.

1. **initialize_global_config** (admin)
   - Creates the `GlobalConfig` PDA (seeded by `config_id`).
   - Stores admin, fee treasury, pinned Pyth program id, pinned SOL/USD feed, fee bps, and minimum manager deposit.

2. **update_global_config** (admin)
   - Updates the fee parameters, treasury address, and pinned oracle info for an existing `GlobalConfig`.

3. **initialize_fund** (manager)
   - Creates `FundState`, the share mint, and the fund SOL vault.
   - Transfers the minimum manager deposit into the fund vault.
   - Mints initial shares to the manager equal to the initial deposit amount.

4. **add_token (global scope)** (admin)
   - Creates a `GlobalWhitelist` PDA for a mint and stores mint decimals and the token/USD Pyth feed.

5. **add_token (fund scope)** (manager)
   - Requires a matching, enabled `GlobalWhitelist`.
   - Creates a `FundWhitelist` PDA for `(fund, mint)`.
   - Ensures the fund token vault ATA `(fund, mint)` exists (creates if missing).
   - Increments `enabled_token_count`.

6. **remove_token (global scope)** (admin)
   - Closes the `GlobalWhitelist` PDA for the mint.

7. **remove_token (fund scope)** (manager)
   - Requires the fund token vault ATA `(fund, mint)` balance is `0`.
   - Closes the `FundWhitelist` PDA.
   - Decrements `enabled_token_count`.

8. **deposit** (investor)
   - Transfers deposit fee lamports to `fee_treasury` and the remaining lamports to the fund vault.
   - Computes NAV using SOL + enabled token vault balances and pinned Pyth feeds.
   - Mints shares proportional to `net_lamports / NAV` (rejects if this would mint 0 shares).
   - Increments `total_shares`.

9. **request_withdraw** (investor)
   - Creates/updates the withdraw request PDA for `(fund, investor)`.
   - Records requested shares and the request timestamp.

10. **cancel_withdraw** (investor)
    - Closes the withdraw request PDA and refunds its rent to the investor.

11. **execute_withdraw** (investor)
    - Requires the timelock has elapsed.
    - Recomputes NAV and computes the pro-rata SOL payout.
    - Burns shares.
    - Transfers SOL from the fund vault to the investor and fee treasury.
    - Closes the withdraw request PDA.

12. **borrow_for_swap** (manager)
    - Requires fund is unlocked and `min_out > 0`.
    - Requires a valid `settle_swap` instruction later in the same transaction (validated via the instructions sysvar + account metas).
    - Locks the fund and records snapshots (`snapshot_sol`, `snapshot_output`) plus trade parameters (`borrow_amount`, `expected_min_out`, `output_mint`).
    - Moves SOL from the fund vault to the manager via manual lamport manipulation.

13. **settle_swap** (manager)
    - Requires the fund is locked.
    - Validates the output whitelist PDA and output token vault ATA.
    - Requires the SOL vault balance equals `snapshot_sol - borrow_amount`.
    - Requires output token increase is at least `expected_min_out`.
    - Unlocks the fund and clears trade state.

## NAV Calculation

```
NAV = SOL vault lamports
    + sum(token_amount * token/USD price / SOL/USD price)
```

Requirements:
- `remaining_accounts` layout is strict:
  - If `enabled_token_count == 0`, remaining accounts must be empty.
  - Otherwise: `1 + 3 * enabled_token_count`.
  - Order is by mint pubkey ascending.
  - Layout per token: `[whitelist_pda, token_vault_ata, pyth_price_account]`.
- Pyth feed accounts are pinned in config/whitelist and verified by pubkey and owner.
- Confidence bounds and staleness checks are enforced.

## Borrow / Settle Flow
- `borrow_for_swap`:
  - manager-only, fund must be unlocked.
  - enforces a valid settle instruction later in the same transaction
    (checks discriminator and account metas).
  - locks fund and snapshots SOL + output token balances.
  - moves SOL from fund vault to manager (manager_receive must be manager).
- `settle_swap`:
  - manager-only, fund must be locked.
  - verifies output vault ATA and whitelist PDA.
  - requires output increase >= `min_out` and SOL vault decrease matches borrow.
  - clears lock state.

## Security Invariants
- Only admin can update global config or global whitelist.
- Only manager can add/remove fund tokens or trade.
- Fund token removal requires empty vault balance.
- NAV completeness enforced via `enabled_token_count` + ordered account list.
- Oracle feeds pinned by pubkey and owner.
- `borrow_for_swap` and `settle_swap` must be in the same transaction.
- Borrow/settle instruction metas must match the fund accounts.

## Hard Problems We Solved (and How)

### 1) Preventing “partial NAV” attacks
Problem: callers can omit token accounts and understate NAV to mint cheap shares.
Solution: `enabled_token_count` + strict `remaining_accounts` layout + mint-ordered triplets.

Relevant code:
- `programs/fund_contract/src/instructions/deposit.rs`

```rust
require!(remaining.len() == 1 + 3 * (enabled_token_count as usize), ErrorCode::InvalidRemainingAccounts);
require!(prev.to_bytes() < whitelist.mint.to_bytes(), ErrorCode::InvalidWhitelistOrder);
```

### 2) Pinning oracle feeds (no caller-controlled pricing)
Problem: callers can pass arbitrary Pyth feeds.
Solution: store SOL/USD feed and token feeds in config/whitelist and verify pubkeys and owners.

Relevant code:
- `programs/fund_contract/src/instructions/deposit.rs`

```rust
require!(sol_price_info.key == &sol_usd_pyth_feed, ErrorCode::InvalidOracle);
require!(token_price_info.key == &whitelist.pyth_feed, ErrorCode::InvalidOracle);
require!(token_price_info.owner == &pyth_program_id, ErrorCode::InvalidOracle);
```

### 3) Atomic trading (borrow and settle must be in same tx)
Problem: manager borrows SOL and never returns.
Solution: require a valid `settle_swap` later in the same transaction and validate its metas.

Relevant code:
- `programs/fund_contract/src/instructions/borrow_for_swap.rs`

```rust
let current_idx = load_current_index_checked(ix_sysvar)? as usize;
while let Ok(ix) = load_instruction_at_checked(scan_idx, ix_sysvar) {
  if ix.program_id == crate::ID && ix.data.starts_with(&settle_discriminator) {
    // compare account metas to expected
  }
}
```

### 4) Avoiding “remove token while still holding balance”
Problem: manager removes whitelist entry while vault still holds the token, breaking NAV.
Solution: require the fund token ATA to be empty before removing the whitelist.

Relevant code:
- `programs/fund_contract/src/instructions/remove_token.rs`

```rust
require!(vault.amount == 0, ErrorCode::TokenVaultNotEmpty);
```

### 5) Zero-share mint protection
Problem: deposits that mint 0 shares silently lose funds to fees.
Solution: reject deposits that would mint 0 shares.

Relevant code:
- `programs/fund_contract/src/instructions/deposit.rs`

```rust
require!(shares_to_mint > 0, ErrorCode::ZeroShares);
```

### 6) Manual lamport manipulation for SOL transfers
Problem: Anchor's `system_program::transfer` couldn't run when funds needed to move lamports between program-owned PDAs (fund vault) and other accounts inside borrow/settle or withdraw execution.
Solution: borrow/settle and withdrawal perform low-level `try_borrow_mut_lamports`, adjusting lamports manually and relying on rent-exemption semantics so that transfers always balance without extra CPIs.

Relevant code:
- `programs/fund_contract/src/instructions/borrow_for_swap.rs` (fund vault -> manager)
- `programs/fund_contract/src/instructions/execute_withdraw.rs` (vault -> investor/fee treasury)

```rust
let mut vault_lamports = fund_vault_info.try_borrow_mut_lamports()?;
**vault_lamports = (**vault_lamports).checked_sub(amount)?;
```

## Build & Test
From `fund_contract/`:

```
anchor build
anchor test
```

If a local validator is already running, use:

```
anchor test --skip-local-validator
```

## Notes
- Fees are collected in lamports (not shares).
- Trade fees are configured but not applied in the current implementation.
- Token vault lifecycle (sweeping/burning for full liquidation) is not implemented.
