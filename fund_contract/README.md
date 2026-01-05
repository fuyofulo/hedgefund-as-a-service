# Fund Contract (Solana / Anchor)

This program implements a hedge-fund-style pool on Solana. Managers create funds, investors deposit SOL to receive shares based on NAV, and managers trade whitelisted tokens using an atomic borrow/settle pattern. The platform controls a global whitelist and executes limit/DCA orders and strategy rebalances via a trusted keeper.

## Architecture Diagram

```
                           +-----------------------------+
                           |          Platform           |
                           |  GlobalConfig (PDA)         |
                           |  - admin                    |
                           |  - fee treasury             |
                           |  - keeper                   |
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
| - active_limit_count / active_dca_count                                  |
| - manager_fee_bps                                                        |
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
|            Trading (PDA)                  |
|   ["trading", fund]                      |
|   - is_locked / borrow_amount / snapshots       |
+--------------------+-----------------------------+
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
- Max manager fee bps and min/max withdraw timelock bounds.
- A fee treasury address.
- Minimum manager deposit for fund creation.
- Keeper address for limit/DCA execution and rebalancing.
- Max slippage bps used as an oracle-based guardrail for orders.

### Whitelists
There are two levels of whitelists:
1) `GlobalWhitelist` PDAs: platform-approved mints + their Pyth feeds.
2) `FundWhitelist` PDAs: per-fund allowlist, limited to globally approved mints.

### Fund State
- Each fund has its own `FundState` PDA with a share mint and a program-owned SOL vault.
- `manager_fee_bps`, `min_investor_deposit_lamports`, and `withdraw_timelock_secs` define per-fund parameters.
- `enabled_token_count` enforces complete NAV calculation.
- `active_limit_count` and `active_dca_count` track open orders and are required for NAV completeness.
- `fund_type` determines Trading vs Strategy behavior and is immutable.
- Trading funds also have a separate `Trading` PDA for lock and snapshot fields.

### Shares
- Shares are SPL tokens minted by the fund PDA.
- Shares are minted during fund creation (manager seed deposit) and on each deposit.
- Shares are burned during withdrawals.

## Accounts / PDAs
- GlobalConfig: `["config", config_id]`
- GlobalWhitelist: `["global_whitelist", config, mint]`
- FundState: `["fund", config, manager, fund_id]`
- Trading (trading funds): `["trading", fund]`
- FundWhitelist: `["whitelist", fund, mint]`
- Share mint: `["shares", fund]`
- Fund vault: `["vault", fund]` (program-owned SOL account)
- Withdraw request: `["withdraw", fund, investor]`
- Limit order: `["limit_order", fund, order_id]`
- DCA order: `["dca_order", fund, order_id]`
- Order vault auth: `["limit_order_vault_auth", order]` / `["dca_order_vault_auth", order]`
- Order SOL vault: `["limit_order_sol_vault", order]` / `["dca_order_sol_vault", order]`
- Strategy: `["strategy", fund]`

Token vaults are ATAs for `(fund PDA, mint)`.

## Instruction Flows

Each instruction implements the flows described in `../SPEC.md`. This section explains the high-level steps and validations so you can understand the contract without reading the code.

1. **initialize_global_config** (admin)
   - Creates the `GlobalConfig` PDA (seeded by `config_id`).
   - Stores admin, fee treasury, keeper, pinned Pyth program id, pinned SOL/USD feed, fee bps, max_manager_fee_bps, min/max withdraw timelock bounds, and minimum manager deposit.

2. **update_global_config** (admin)
   - Updates the fee parameters, treasury address, pinned oracle info, max_manager_fee_bps, and withdraw timelock bounds.
   - Keeper is rotated only via `set_keeper` / `revoke_keeper`.

3. **set_keeper** (admin)
   - Rotates the keeper key used for limit/DCA order execution and strategy rebalancing.

4. **revoke_keeper** (admin)
   - Revokes keeper access by setting the keeper to the default pubkey.

5. **initialize_fund** (manager)
   - Creates `FundState`, the share mint, and the fund SOL vault.
   - Creates the `Trading` PDA (trading funds only).
   - Manager supplies `initial_deposit_lamports` (must be >= min).
   - Requires `withdraw_timelock_secs` within global config bounds.
   - Deposit fee is sent to `fee_treasury`; net lamports are deposited into the fund vault.
   - Mints initial shares to the manager equal to the net deposit amount.
   - Stores `manager_fee_bps`, `min_investor_deposit_lamports`, and `withdraw_timelock_secs`.

6. **add_token (global scope)** (admin)
   - Creates a `GlobalWhitelist` PDA for a mint and stores mint decimals and the token/USD Pyth feed.

7. **add_token (fund scope)** (manager)
   - Requires a matching, enabled `GlobalWhitelist`.
   - Creates a `FundWhitelist` PDA for `(fund, mint)`.
   - Ensures the fund token vault ATA `(fund, mint)` exists (creates if missing).
   - Increments `enabled_token_count`.

8. **remove_token (global scope)** (admin)
   - Closes the `GlobalWhitelist` PDA for the mint.

9. **remove_token (fund scope)** (manager)
   - Requires the fund token vault ATA `(fund, mint)` balance is `0`.
   - Closes the `FundWhitelist` PDA.
   - Decrements `enabled_token_count`.

10. **deposit** (investor)
   - Requires `amount_lamports >= min_investor_deposit_lamports`.
   - Transfers deposit fee lamports to `fee_treasury` and the remaining lamports to the fund vault.
   - Computes NAV using SOL + enabled token vault balances + open order escrows.
   - Mints shares proportional to `net_lamports / NAV` (rejects if this would mint 0 shares).
   - Increments `total_shares`.

11. **request_withdraw** (investor)
   - Creates/updates the withdraw request PDA for `(fund, investor)`.
   - Records requested shares and the request timestamp.

12. **cancel_withdraw** (investor)
   - Closes the withdraw request PDA and refunds its rent to the investor.

13. **execute_withdraw** (investor)
   - Requires the timelock has elapsed.
   - Recomputes NAV and computes the pro-rata SOL payout.
   - Burns shares.
   - Transfers SOL from the fund vault to the investor and fee treasury.
   - Closes the withdraw request PDA.

14. **borrow_for_swap** (manager)
   - Requires fund is unlocked and `min_out > 0`.
   - Requires a valid `settle_swap` instruction later in the same transaction (validated via the instructions sysvar + account metas).
   - Locks `Trading` and records snapshots (`snapshot_sol`, `snapshot_output`) plus trade parameters (`borrow_amount`, `expected_min_out`, `output_mint`).
   - Moves SOL from the fund vault to the manager via manual lamport manipulation.

15. **settle_swap** (manager)
   - Requires the fund is locked.
   - Validates the output whitelist PDA and output token vault ATA.
   - Requires the SOL vault balance equals `snapshot_sol - borrow_amount`.
   - Requires output token increase is at least `expected_min_out`.
   - Unlocks the fund and clears trade state.

16. **create_limit_order** (manager)
   - Creates a per-order PDA and escrows the spending asset.
   - BUY: moves SOL from fund vault to order SOL vault; creates WSOL ATA for order vault auth.
   - SELL: moves tokens from fund token vault to order token vault ATA.
   - Increments `active_limit_count`.

17. **execute_limit_order** (keeper)
   - Validates order status and price trigger.
   - Verifies oracle feed key/owner, staleness, confidence.
   - Executes Jupiter CPI from escrow vault to fund vaults (validation accounts are separate from CPI accounts).
   - Enforces `min_out` and oracle-based slippage guard.
   - Marks order executed, closes escrow, decrements `active_limit_count`.

18. **cancel_limit_order** (manager)
   - Refunds escrow back to fund vaults.
   - Closes order vaults and order PDA.
   - Decrements `active_limit_count`.

19. **create_dca_order** (manager)
   - Creates a per-order PDA and escrows the spending asset.
   - BUY: moves SOL into DCA SOL vault; creates WSOL ATA for order vault auth.
   - SELL: moves tokens into DCA token vault ATA.
   - Stores total amount, slice amount, interval, and next_exec_ts.
   - Increments `active_dca_count`.

20. **execute_dca_order** (keeper)
   - Requires `now >= next_exec_ts` and order not expired.
   - Executes one slice via Jupiter CPI.
   - Enforces `min_out` and oracle-based slippage guard.
   - Updates `remaining_amount` and schedules next execution.
   - Closes vaults and updates counters when complete.

21. **cancel_dca_order** (manager)
   - Refunds escrow back to fund vaults.
   - Closes DCA token vault and updates active DCA count.

22. **initialize_strategy_fund** (manager)
   - Creates a Strategy fund (immutable fund type).
   - Same setup as initialize_fund, but with `fund_type = Strategy`.
   - Manager supplies `initial_deposit_lamports` and pays the deposit fee.
   - Requires `withdraw_timelock_secs` within global config bounds.

23. **set_strategy** (manager, one-time)
   - Creates the Strategy PDA.
   - Stores target allocations (max 8 tokens).
   - Requires allocations sum to 10,000 bps and match enabled fund whitelist.
   - Stores rebalance threshold and cooldown; sets `last_rebalance_ts` to now.

24. **rebalance_strategy** (keeper)
   - Rebalances one token per call based on NAV and target weights.
   - Uses Jupiter CPI to buy/sell via fund vaults.
   - Enforces cooldown, threshold, `min_out`, and oracle-based slippage guard.
   - Requires WSOL vault to be swept before rebalance.

25. **sweep_wsol** (keeper)
   - Closes the fund WSOL ATA to the fund vault.
   - Used to keep SOL liquidity in the fund vault and WSOL at zero before rebalances.

## NAV Calculation

```
NAV = SOL vault lamports
    + sum(token_amount * token/USD price / SOL/USD price)
    + open order escrows (limit + DCA)
```

Requirements:
- `remaining_accounts` layout is strict.
  - Base: `[sol_feed] + 3 * enabled_token_count`.
  - Then `3 * active_limit_count` (limit order triplets).
  - Then `3 * active_dca_count` (dca order triplets).
- Base token triplets are ordered by mint pubkey ascending.
- Limit/DCA triplets are ordered by order PDA pubkey ascending.
- Pyth feeds are pinned in config/whitelist and verified by pubkey and owner.
- Confidence bounds and staleness checks are enforced.

## Security Invariants
- Only admin can update global config or global whitelist.
- Only admin can set/revoke the keeper key.
- Only manager can add/remove fund tokens or trade.
- Deposit/withdraw enforce min deposit and timelock.
- Trading only allowed for whitelisted tokens.
- Borrow/Settle must be in same transaction (instruction sysvar checks).
- Borrow/Settle instruction metas must match the fund accounts.
- Fund token removal requires empty vault balance.
- Fund whitelists and fund state PDAs must be canonical for their seeds.
- Oracle data must be recent and from a trusted feed.
- Limit/DCA orders escrow the spending asset in PDA-controlled vaults.
- Limit/DCA execution is keeper-only and uses pinned Jupiter program id.
- Strategy funds disable trading instructions (borrow/settle, limit, DCA).

## Hard Problems We Solved (and How)

### 1) Preventing “partial NAV” attacks
Problem: callers can omit token accounts and understate NAV to mint cheap shares.
Solution: `enabled_token_count` + strict `remaining_accounts` layout + mint-ordered triplets.

### 2) Pinning oracle feeds (no caller-controlled pricing)
Problem: callers can pass arbitrary Pyth feeds.
Solution: store SOL/USD feed and token feeds in config/whitelist and verify pubkeys and owners.

### 3) Atomic trading (borrow and settle must be in same tx)
Problem: manager borrows SOL and never returns.
Solution: require a valid `settle_swap` later in the same transaction and validate its metas.

### 4) Avoiding “remove token while still holding balance”
Problem: manager removes whitelist entry while vault still holds the token, breaking NAV.
Solution: require the fund token ATA to be empty before removing the whitelist.

### 5) Zero-share mint protection
Problem: deposits that mint 0 shares silently lose funds to fees.
Solution: reject deposits that would mint 0 shares.

### 6) Manual lamport manipulation for SOL transfers
Problem: system transfers can fail for program-owned PDA vaults in borrow/settle and withdraw.
Solution: direct lamport mutation with careful balance checks.

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
