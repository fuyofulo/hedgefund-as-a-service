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
- Permissionless order execution. Keeper is a trusted executor in v1.

## Roles
- Platform (admin): initializes global config, sets fees, manages global whitelist and oracle feeds.
- Fund manager: creates and manages a fund, initiates trades, sets fund parameters.
- Investor: deposits SOL, receives shares, requests/executes withdrawal.
- Keeper (executor): trusted executor for limit/DCA order swaps and strategy rebalances.

## On-Chain Architecture
Program owns:
- Global config PDA (platform parameters).
- Fund PDA(s) under global config.
- Trading PDA (trading funds only).
- Fund share mint (SPL token).
- Fund treasury vault (program-owned SOL account) and token vaults (SPL token accounts).
- Fund local whitelist PDAs per token mint.
- Global whitelist PDAs per token mint.
- Optional withdrawal request PDAs per investor.
- Limit/DCA order PDAs + escrow vaults.
- Strategy PDA (strategy funds only).

## Accounts / PDAs
- GlobalConfig PDA: `["config", config_id]`
  - admin pubkey
  - keeper pubkey (permissioned executor)
  - fee_treasury pubkey
  - sol_usd_pyth_feed (pinned SOL/USD feed)
  - pyth_program_id (pinned Pyth program)
  - fees: deposit_fee_bps, withdraw_fee_bps, trade_fee_bps
  - max_manager_fee_bps (cap for manager_fee_bps)
  - max_slippage_bps (oracle-based guardrail for orders)
  - min_manager_deposit_lamports
  - min_withdraw_timelock_secs, max_withdraw_timelock_secs
  - bump
- GlobalWhitelist PDA: `["global_whitelist", config, mint]`
  - mint pubkey
  - decimals
  - pyth_feed (pinned token/USD feed)
  - enabled flag
  - bump
- Fund PDA: `["fund", config, manager, fund_id]`
  - config pubkey
  - manager pubkey
  - fund_type (Trading or Strategy)
  - share_mint
  - vault (program-owned PDA)
  - total_shares
  - manager_fee_bps
  - min_investor_deposit_lamports
  - withdraw_timelock_secs
  - enabled_token_count
  - active_limit_count
  - active_dca_count
  - next_order_id
  - bump + share_mint_bump + vault_bump
- Trading PDA (trading funds only): `["trading", fund]`
  - fund pubkey
  - is_locked
  - borrow_amount
  - expected_min_out
  - snapshot_sol
  - snapshot_output
  - output_mint
  - bump
- FundWhitelist PDA: `["whitelist", fund, mint]`
  - mint pubkey
  - decimals
  - pyth_feed (pinned token/USD feed)
  - enabled flag
  - bump
- Strategy PDA: `["strategy", fund]`
  - allocations (mint + weight_bps)
  - allocation_count
  - rebalance_threshold_bps
  - rebalance_cooldown_secs
  - last_rebalance_ts
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
   - Sets admin, fee treasury, keeper, pinned oracle info, fee bps, max_manager_fee_bps, max_slippage_bps, min_manager_deposit, and withdraw timelock bounds.

2) UpdateGlobalConfig
   - Admin updates fee params, fee treasury, pinned oracle info, max_manager_fee_bps, max_slippage_bps, min_manager_deposit, and withdraw timelock bounds.
   - Keeper is managed only via set/revoke.

2a) SetKeeper (admin)
   - Admin sets a new keeper pubkey for order execution.

2b) RevokeKeeper (admin)
   - Admin revokes keeper access (sets keeper to default pubkey).

3) InitializeFund (trading type)
   - Creates Fund PDA.
   - Creates Trading PDA and share mint.
   - Manager supplies initial_deposit_lamports (must be >= min_manager_deposit).
   - Requires withdraw_timelock_secs within global bounds.
   - Deposit fee is sent to fee_treasury; net is deposited into fund vault.
   - Mints initial shares equal to net deposit.
   - Stores fund params (manager_fee_bps, min deposit, withdraw timelock, etc).

4) AddToken (single instruction, scoped)
   - Scope = Global: admin creates GlobalWhitelist PDA for mint.
   - Scope = Fund: manager adds mint to fund only if GlobalWhitelist PDA exists, creates FundWhitelist PDA and fund token vault.

5) RemoveToken (single instruction, scoped)
   - Scope = Global: admin closes GlobalWhitelist PDA.
   - Scope = Fund: manager closes FundWhitelist PDA, requires the fund token vault to be empty.

6) Deposit
   - Investor deposits SOL to fund treasury.
   - Requires `amount_lamports >= min_investor_deposit_lamports`.
   - Computes NAV using pinned oracle prices + fund holdings + open order escrows.
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
   - Locks the Trading and snapshots SOL + output token balances.
   - Records borrow amount, expected_min_out, and output mint in Trading.
   - Requires min_out > 0 and the settle instruction to reference the same accounts.

11) Settle (trade end)
   - Validates token delta >= expected_min_out and SOL vault decreased by borrow_amount.
   - Verifies tokens are whitelisted via FundWhitelist PDA.
   - Unlocks Trading and clears trade state fields.
   - If validation fails, whole transaction reverts.

12) CreateLimitOrder
   - Manager-only. Creates a per-order PDA and escrows the spending asset.
   - Buy order: escrow SOL from fund vault into an order SOL vault PDA.
   - Sell order: escrow tokens from fund token ATA into an order token vault ATA owned by an order vault authority PDA.
   - Increments `active_limit_count`.

13) ExecuteLimitOrder
   - Keeper-only execution.
   - Validates order status, oracle feed key/owner, freshness, and confidence.
   - Checks price trigger (BUY: price <= limit, SELL: price >= limit).
   - Executes swap via CPI (Jupiter) using escrowed assets as input and fund vaults as outputs.
   - Verifies post-swap deltas >= min_out and oracle-based slippage guard.
   - Marks order executed, closes escrow, decrements `active_limit_count`.

14) CancelLimitOrder
   - Manager-only. Cancels open order and refunds escrow back to fund vaults.
   - Closes order vaults and order PDA.
   - Decrements `active_limit_count`.

15) CreateDcaOrder
   - Manager-only. Creates a per-order PDA and escrows the spending asset.
   - Buy DCA: escrow SOL from fund vault into a DCA order SOL vault PDA.
   - Sell DCA: escrow tokens from fund token ATA into a DCA order token vault ATA owned by a vault authority PDA.
   - Stores total amount, slice amount, interval, min_out, next_exec_ts, and oracle feed.
   - Increments `active_dca_count` (max active enforced).

16) ExecuteDcaOrder
   - Keeper-only execution.
   - Requires `now >= next_exec_ts` and order is not expired.
   - Executes one slice via Jupiter CPI.
   - Verifies post-swap deltas >= min_out and oracle-based slippage guard.
   - Updates remaining amount and next_exec_ts; closes and refunds when complete.
   - Decrements `active_dca_count` when order completes.

17) CancelDcaOrder
   - Manager-only. Cancels open DCA order and refunds escrow back to fund vaults.
   - Closes order token vault and updates `active_dca_count`.

18) InitializeStrategyFund (strategy type)
   - Creates Fund PDA with `fund_type = Strategy`.
   - Creates share mint and fund vault.
   - Manager supplies initial_deposit_lamports (must be >= min_manager_deposit).
   - Requires withdraw_timelock_secs within global bounds.
   - Deposit fee is sent to fee_treasury; net is deposited into fund vault.
   - Mints initial shares equal to net deposit.

19) SetStrategy (strategy fund only, one-time)
   - Creates Strategy PDA with target allocations.
   - Requires allocations sum to 10,000 bps.
   - Requires each mint to be enabled in fund whitelist.
   - Requires `enabled_token_count == allocation_count`.
   - Stores rebalance_threshold_bps and rebalance_cooldown_secs, sets last_rebalance_ts to now.

20) RebalanceStrategy (keeper-only)
   - Rebalances one target mint per call.
   - Enforces cooldown and threshold.
   - Requires WSOL vault to be swept before rebalance (no wrapped SOL balance).
   - Uses NAV + target weights to compute buy/sell amount.
   - Uses oracle-based slippage guard + `min_out`.
   - Validation accounts are separate from CPI accounts (validation triplets are not passed to Jupiter).

21) SweepWsol (keeper-only)
   - Closes the fund WSOL ATA to the fund vault.
   - Used to ensure SOL liquidity is in the fund vault and WSOL is zero before rebalances.

## NAV & Pricing
- NAV = SOL treasury + sum(value of token vault balances) + open order escrows.
- Token value = oracle price * quantity.
- Use pinned Pyth price feeds in v1 (SOL/USD + per-token feeds).
- Use strict staleness checks and confidence bounds.

NAV completeness:
- `remaining_accounts` layout is strict.
- Base layout: `[sol_feed] + 3 * enabled_token_count`.
- Then limit order triplets (per active order): `[limit_order, order_sol_vault, order_token_vault]`.
- Then DCA order triplets (per active order): `[dca_order, dca_sol_vault, dca_token_vault]`.
- Base token triplets are ordered by mint pubkey ascending.
- Limit/DCA triplets are ordered by order PDA pubkey ascending.

Order escrow inclusion:
- BUY orders add their SOL vault lamports into NAV.
- SELL orders add their escrowed token value into NAV using the token price map.

## Fee Model (v1)
- Deposit fee: take lamports from deposit before minting shares.
- Withdraw fee: take lamports from withdraw proceeds.
- Fee destination: platform treasury (set in GlobalConfig).

## Security & Invariants
- Only admin updates GlobalConfig or global whitelist.
- Only admin can set/revoke the keeper key.
- Only manager can create funds, add/remove fund tokens, or trade.
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
- Keeper is a trusted executor for orders and rebalancing in v1.

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
- Ensure WSOL sweep workflow is reliable and automated by the keeper.
