# Hedge Fund as a Service (Solana) - v1 Spec

## Overview
Build a Solana program that lets a fund manager create a hedge fund, accept SOL deposits, mint fund shares, and allow manager-led trading of whitelisted tokens via atomic borrow/settle. The platform controls a global whitelist via PDA entries. Each fund maintains its own local whitelist of enabled mints (subset of global).

## Goals (v1)
- Create a global config and platform token whitelist PDAs for approved tokens.
- Allow managers to create a trading fund, deposit initial SOL, and mint share tokens.
- Allow investors to deposit SOL in exchange for fund shares based on NAV.
- Allow investors to request and execute withdrawals after a time lock.
- Allow managers to trade whitelisted tokens using atomic borrow/settle within a single transaction.
- Allow funds to opt-in to platform-approved tokens via per-fund whitelist PDAs.
- Support limit orders and DCA orders via keeper-executed swaps and escrowed assets.
- Support strategy funds with preallocated target weights and keeper-driven rebalancing.

## Non-Goals (v1)
- Partial withdrawals or automated liquidity management.
- Cross-program oracle aggregation beyond a single oracle source (pyth/switchboard).

## Roles
- Platform (admin): initializes global config, sets fees, manages global whitelist and oracle feeds.
- Fund manager: creates and manages a fund, initiates trades, sets fund parameters.
- Investor: deposits SOL, receives shares, requests/executes withdrawal.
- Keeper (executor): trusted executor for limit/DCA order swaps (permissioned).

## On-Chain Architecture
Program owns:
- Global config PDA (platform parameters).
- Fund PDA(s) under global config.
- Fund share mint (SPL token).
- Fund treasury vault (program-owned SOL account) and token vaults (SPL token accounts).
- Fund local whitelist PDAs per token mint.
- Global whitelist PDAs per token mint.
- Optional withdrawal request PDAs per investor.

## Accounts / PDAs
- GlobalConfig PDA: `["config", config_id]`
  - admin pubkey
  - keeper pubkey (permissioned executor for orders)
  - fees: deposit_fee_bps, withdraw_fee_bps, trade_fee_bps (initially optional)
  - max_slippage_bps (oracle-based guardrail for order execution)
  - min_manager_deposit_lamports
  - sol_usd_pyth_feed (pinned SOL/USD feed)
  - pyth_program_id (pinned Pyth program)
  - bump
- GlobalWhitelist PDA: `["global_whitelist", config, mint]`
  - mint pubkey
  - decimals
  - pyth_feed (pinned token/USD feed)
  - enabled flag
  - bump
- Fund PDA: `["fund", config, manager, fund_id]`
  - manager pubkey
  - fund_type (Trading or Strategy)
  - share_mint
  - vault (program-owned PDA)
  - total_shares
  - min_investor_deposit, withdraw_timelock_secs
  - enabled_token_count
  - trade lock state (is_locked, borrow_amount, expected_min_out, snapshot_sol, snapshot_output, output_mint)
  - bump
- FundWhitelist PDA: `["whitelist", fund, mint]`
  - mint pubkey
  - decimals
  - pyth_feed (pinned token/USD feed)
  - enabled flag
  - bump
- StrategyConfig PDA: `["strategy", fund]` (strategy funds only)
  - allocations (mint + weight_bps), threshold, cooldown, last_rebalance_ts
- WithdrawRequest PDA: `["withdraw", fund, investor]`
  - investor pubkey
  - requested_shares
  - request_ts
  - bump
- LimitOrder PDA: `["limit_order", fund, order_id]`
  - per-order state (side, mint, amount_in, min_out, limit_price, oracle feed, status)
- DcaOrder PDA: `["dca_order", fund, order_id]`
  - per-order state (side, total_amount, slice_amount, interval_secs, next_exec_ts, min_out, oracle feed, status)
- Order vault authority PDA: `["limit_order_vault_auth", order]` / `["dca_order_vault_auth", order]`
- Order SOL vault PDA: `["limit_order_sol_vault", order]` / `["dca_order_sol_vault", order]`
- Token vaults: SPL token accounts owned by fund PDA.

## Instructions (v1)
1) InitializeGlobalConfig
   - Creates GlobalConfig PDA.
   - Sets fees, admin, min_manager_deposit, and pinned oracle info.

2) UpdateGlobalConfig
   - Admin updates fee params and pinned oracle info.
   - Can rotate keeper and slippage guard values.

2a) SetKeeper (admin)
   - Admin sets a new keeper pubkey for order execution.

2b) RevokeKeeper (admin)
   - Admin revokes keeper access (sets keeper to default pubkey).

3) InitializeFund (trading type)
   - Creates Fund PDA.
   - Creates share mint.
   - Manager deposits min SOL into treasury and receives initial shares.
   - Stores fund params (min deposit, withdraw timelock, etc).

4) AddToken (single instruction, scoped)
   - Scope = Global: admin creates GlobalWhitelist PDA for mint.
   - Scope = Fund: manager adds mint to fund only if GlobalWhitelist PDA exists, creates FundWhitelist PDA and fund token vault.

5) RemoveToken (single instruction, scoped)
   - Scope = Global: admin closes GlobalWhitelist PDA.
   - Scope = Fund: manager closes FundWhitelist PDA, requires the fund token vault to be empty.

6) Deposit
   - Investor deposits SOL to fund treasury.
   - Computes NAV using pinned oracle prices + fund holdings.
   - Mints shares to investor based on NAV/share.
   - Applies platform fee (lamports).
   - Rejects if deposit would mint zero shares.

7) RequestWithdraw
   - Creates or updates WithdrawRequest PDA.
   - Stores request timestamp and share amount.

8) CancelWithdraw
   - Investor closes their WithdrawRequest PDA.
   - No shares are burned and no funds move.

9) ExecuteWithdraw
   - Validates timelock elapsed from WithdrawRequest.
   - Computes NAV and withdraw amount using pinned oracle prices.
   - Burns investor shares.
   - Transfers SOL from treasury (if sufficient).
   - Applies platform fee.
   - Closes WithdrawRequest PDA.

10) Borrow (trade start)
   - Manager borrows SOL from fund treasury to a manager-controlled account.
   - Must be in the same transaction as Settle (enforced by instruction sysvar).
   - Locks the fund and snapshots SOL + output token balances.
   - Records borrow amount, expected_min_out, and output mint.
   - Requires min_out > 0 and the settle instruction to reference the same accounts.

11) Settle (trade end)
   - Validates token delta >= expected_min_out and SOL vault decreased by borrow_amount.
   - Verifies tokens are whitelisted via FundWhitelist PDA.
   - Unlocks the fund and clears trade state.
   - If validation fails, whole transaction reverts.

12) CreateLimitOrder
   - Manager-only. Creates a per-order PDA and escrows the spending asset.
   - Buy order: escrow SOL from fund vault into an order SOL vault PDA.
   - Sell order: escrow tokens from fund token ATA into an order token vault ATA owned by an order vault authority PDA.
   - Stores limit price + oracle feed and min_out for slippage protection.

13) ExecuteLimitOrder
   - Keeper-only execution.
   - Validates order status, oracle feed key/owner, freshness, and confidence.
   - Checks price trigger (BUY: price <= limit, SELL: price >= limit).
   - Executes swap via CPI (Jupiter) using escrowed assets as input and fund vaults as outputs.
   - Verifies post-swap deltas >= min_out and oracle-based slippage guard.
   - Closes/marks order executed and returns any leftover escrow.

14) CancelLimitOrder
   - Manager-only. Cancels open order and refunds escrow back to fund vaults.
   - Closes order vaults and order PDA.

15) CreateDcaOrder
   - Manager-only. Creates a per-order PDA and escrows the spending asset.
   - Buy DCA: escrow SOL from fund vault into a DCA order SOL vault PDA.
   - Sell DCA: escrow tokens from fund token ATA into a DCA order token vault ATA owned by a vault authority PDA.
   - Stores total amount, slice amount, interval, min_out, next_exec_ts, and oracle feed.
   - Enforces `active_dca_count < MAX_ACTIVE_DCA`.

16) ExecuteDcaOrder
   - Keeper-only execution.
   - Requires `now >= next_exec_ts` and order is not expired.
   - Executes one slice via Jupiter CPI.
   - Verifies post-swap deltas >= min_out and oracle-based slippage guard.
   - Updates remaining amount and next_exec_ts; closes and refunds when complete.

17) CancelDcaOrder
   - Manager-only. Cancels open DCA order and refunds escrow back to fund vaults.
   - Closes order token vault and updates `active_dca_count`.

18) InitializeStrategyFund (strategy type)
   - Creates Fund PDA with `fund_type = Strategy`.
   - Creates share mint and fund vault.
   - Manager deposits min SOL and receives initial shares.

19) SetStrategy (strategy fund only, one-time)
   - Creates StrategyConfig PDA with target allocations.
   - Requires allocations sum to 10,000 bps.
   - Requires each mint to be enabled in fund whitelist.
   - Requires `enabled_token_count == allocation_count`.

20) RebalanceStrategy (keeper-only)
   - Rebalances one target mint per call using Jupiter CPI.
   - Enforces cooldown and threshold.
   - Uses NAV + target weights to compute buy/sell amount.
   - Uses oracle-based slippage guard + `min_out`.

## NAV & Pricing
- NAV = SOL treasury + sum(value of token vault balances).
- Token value = oracle price * quantity.
- Use pinned Pyth price feeds in v1 (SOL/USD + per-token feeds).
- Use conservative pricing to avoid manipulation (e.g., strict staleness checks).
- NAV requires full token list: remaining accounts must include SOL feed + triplets for every enabled token, ordered by mint pubkey.
- Token vaults must be the ATA for (fund PDA, mint), and whitelist PDAs must match the expected seeds.

## Fee Model (v1)
- Deposit fee: take lamports from deposit before minting shares.
- Withdraw fee: take lamports from withdraw proceeds.
- Fee destination: platform treasury (set in GlobalConfig).

## Security & Invariants
- Only admin updates GlobalConfig.
- Only admin can set/revoke the keeper key.
- Only manager can call InitializeFund, AddTokenToFund, Borrow/Settle.
- Deposit/withdraw enforce min deposit and timelock.
- Trading only allowed for whitelisted tokens.
- Borrow/Settle must be in same transaction (instruction sysvar checks).
- Borrow/Settle must target the same accounts (validated from instruction sysvar metas).
- Fund token removal requires the token vault to be empty.
- Fund whitelists and fund state PDAs must be canonical for their seeds.
- Oracle data must be recent and from a trusted feed.
- Limit/DCA orders escrow the spending asset in PDA-controlled vaults.
- Limit/DCA order execution is keeper-only and uses pinned Jupiter program id.
- Oracle-based slippage guard (max_slippage_bps) is enforced during order execution.
- DCA has a maximum active order count per fund.
- Strategy funds disable trading instructions (borrow/settle, limit, DCA).

## Decisions
- Global whitelist uses PDA entries per mint (no Merkle root).
- Fees are collected in lamports (not shares).
- Use Pyth for oracle prices.
- Fund seed includes `fund_id` to allow multiple funds per manager.
- Precision is critical; avoid rounding where possible and use integer math with explicit scaling.

## Limit Orders (v1)

### Overview
Limit orders use a keeper-execution model while keeping custody in program-controlled vaults. Orders escrow the asset that will be spent and only release funds through a validated swap.

### Order PDA
Seeds:

```
["limit_order", fund_state.key(), order_id_le_bytes]
```

`order_id` is an incrementing `u64` stored in `FundState.next_order_id`.

Fields (example):
- `fund: Pubkey`
- `side: u8` (0 = Buy, 1 = Sell)
- `mint: Pubkey` (target mint)
- `amount_in: u64` (SOL lamports for Buy, token units for Sell)
- `min_out: u64` (slippage guard)
- `limit_price: i64`
- `price_expo: i32`
- `price_feed: Pubkey`
- `pyth_program_id: Pubkey` (or read from GlobalConfig)
- `created_ts: i64`
- `expiry_ts: i64` (0 = no expiry)
- `status: u8` (0 = open, 1 = executed, 2 = cancelled)
- `bump: u8`

### Escrow Vaults
- Buy order SOL vault (system account PDA):
  - Seeds: `["limit_order_sol_vault", order.key()]`
- Sell order token vault:
  - Vault authority PDA seeds: `["limit_order_vault_auth", order.key()]`
  - Token vault ATA: `ATA(vault_auth, mint)`

### CreateLimitOrder (manager-only)
Checks:
- Manager authorization.
- Whitelist enabled and mint matches.
- `amount_in > 0` and `min_out > 0`.
Actions:
- Create order PDA and record order state.
- Escrow assets:
  - Buy: move SOL from fund vault to order SOL vault.
  - Sell: transfer tokens from fund ATA to order token vault.

### ExecuteLimitOrder (keeper-only)
Checks:
- `order.status == open`
- `order.fund == fund_state.key()`
- Oracle feed key + owner (Pyth), freshness, and confidence.
- Trigger condition (BUY: `price <= limit`, SELL: `price >= limit`).
Actions:
- Execute swap CPI from escrow vault to fund vaults.
- Verify post-swap deltas >= `min_out` and oracle-based slippage guard.
- Mark order executed and close escrow vaults.

### CancelLimitOrder (manager-only)
Checks:
- `order.status == open`
- Manager authorization.
Actions:
- Refund escrow back to fund vaults.
- Close order vaults and order PDA.

### Swap CPI Requirements
- Input account must be the escrow vault (SOL vault PDA or token vault ATA).
- Output account must be a fund-owned vault:
  - SOL: fund vault PDA
  - Tokens: ATA of `(fund_state, mint)`
- Post-swap verification required for `min_out` and full escrow usage (no partial fills in v1).

## DCA Orders (v1)

### Overview
DCA orders execute on a fixed interval (time-based) instead of a price trigger. They use the same escrow model as limit orders and a keeper for execution.

### Order PDA
Seeds:

```
["dca_order", fund_state.key(), order_id_le_bytes]
```

Fields (example):
- `fund: Pubkey`
- `side: u8` (0 = Buy, 1 = Sell)
- `mint: Pubkey`
- `total_amount: u64`
- `slice_amount: u64`
- `remaining_amount: u64`
- `interval_secs: i64`
- `next_exec_ts: i64`
- `min_out: u64`
- `price_feed: Pubkey`
- `pyth_program_id: Pubkey`
- `expiry_ts: i64` (0 = no expiry)
- `status: u8` (open/executed/cancelled)
- `bump: u8`

### Escrow Vaults
- Buy DCA SOL vault (system account PDA):
  - Seeds: `["dca_order_sol_vault", order.key()]`
- Sell DCA token vault:
  - Vault authority PDA seeds: `["dca_order_vault_auth", order.key()]`
  - Token vault ATA: `ATA(vault_auth, mint)`

### CreateDcaOrder (manager-only)
Checks:
- Manager authorization.
- Whitelist enabled and mint matches.
- `total_amount > 0`, `slice_amount > 0`, `slice_amount <= total_amount`.
- `interval_secs > 0`, `min_out > 0`.
- `active_dca_count < MAX_ACTIVE_DCA`.
Actions:
- Create order PDA and record order state (`next_exec_ts = now + interval_secs`).
- Escrow assets:
  - Buy: move SOL from fund vault to order SOL vault.
  - Sell: transfer tokens from fund ATA to order token vault.

### ExecuteDcaOrder (keeper-only)
Checks:
- `order.status == open`
- `now >= next_exec_ts`
- Not expired if `expiry_ts` is set.
- Oracle feed key/owner (Pyth), freshness, confidence.
Actions:
- Execute one slice via Jupiter CPI.
- Verify post-swap deltas >= `min_out` and oracle-based slippage guard.
- Update `remaining_amount` and `next_exec_ts`.
- If `remaining_amount == 0`, mark executed, close vaults, and return any leftover SOL to the fund vault.

### CancelDcaOrder (manager-only)
Checks:
- `order.status == open`
- Manager authorization.
Actions:
- Refund escrow back to fund vaults.
- Close order token vault and update `active_dca_count`.

## Strategy Funds (v1)

### Overview
Strategy funds use preallocated target weights and keeper-driven rebalancing. The fund type is fixed at creation and cannot be changed.

### Fund Type
- `fund_type = Trading` allows borrow/settle + limit/DCA.
- `fund_type = Strategy` disables trading instructions and enables strategy rebalancing.

### StrategyConfig PDA
Seeds:
```
["strategy", fund_state.key()]
```

Fields:
- `allocations`: fixed array (max 8) of `(mint, weight_bps)`
- `allocation_count`
- `rebalance_threshold_bps`
- `rebalance_cooldown_secs`
- `last_rebalance_ts`

### SetStrategy (one-time)
- Manager-only.
- Requires allocations sum to 10,000 bps.
- Requires all mints to be enabled in the fund whitelist.
- Requires `enabled_token_count == allocation_count`.
- Creates the StrategyConfig PDA; cannot be called again.

### RebalanceStrategy (keeper-only)
- One token per call.
- Requires cooldown elapsed and deviation above threshold.
- Uses NAV + target weights to compute buy/sell amount.
- Swaps via Jupiter CPI using fund vaults as source/destination.
- Uses oracle-based slippage guard and `min_out`.

## Open Questions
- Exact NAV precision math and integer scaling strategy.
- Token vault lifecycle (sweeping/burning for full liquidation).

## Mainnet Readiness Checklist
- Security review/audit of all instructions and PDA seed usage.
- Threat model and explicit trust assumptions (keeper model, manager powers).
- Hardened key management: admin + keeper as multisig, hardware wallets, key rotation plan.
- Mainnet oracle configuration: correct SOL/USD + token feeds, verified Pyth program id.
- Mainnet Jupiter program id pinned and validated.
- Run full devnet/testnet burn-in with real oracle accounts and real swaps.
- Add monitoring/alerting for: failed keeper runs, stale oracles, fund lock stuck, NAV anomalies.
- Rate-limit/order caps tuned (MAX_ACTIVE_DCA, max order sizes).
- Compute budget checks for NAV (token count limits) and swap CPIs.
- Finalize fee parameters and slippage guard (max_slippage_bps).
- On-chain upgrade authority plan (lock/transfer authority post-deploy).
- Incident response runbook (pause, revoke keeper, emergency withdrawals).
