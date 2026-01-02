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

## Non-Goals (v1)
- Predefined allocation strategies / auto-rebalancing.
- DCA/limit orders or cranker-based execution.
- Partial withdrawals or automated liquidity management.
- Cross-program oracle aggregation beyond a single oracle source (pyth/switchboard).

## Roles
- Platform (admin): initializes global config, sets fees, manages global whitelist and oracle feeds.
- Fund manager: creates and manages a fund, initiates trades, sets fund parameters.
- Investor: deposits SOL, receives shares, requests/executes withdrawal.

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
  - fees: deposit_fee_bps, withdraw_fee_bps, trade_fee_bps (initially optional)
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
- WithdrawRequest PDA: `["withdraw", fund, investor]`
  - investor pubkey
  - requested_shares
  - request_ts
  - bump
- Token vaults: SPL token accounts owned by fund PDA.

## Instructions (v1)
1) InitializeGlobalConfig
   - Creates GlobalConfig PDA.
   - Sets fees, admin, min_manager_deposit, and pinned oracle info.

2) UpdateGlobalConfig
   - Admin updates fee params and pinned oracle info.

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
- Only manager can call InitializeFund, AddTokenToFund, Borrow/Settle.
- Deposit/withdraw enforce min deposit and timelock.
- Trading only allowed for whitelisted tokens.
- Borrow/Settle must be in same transaction (instruction sysvar checks).
- Borrow/Settle must target the same accounts (validated from instruction sysvar metas).
- Fund token removal requires the token vault to be empty.
- Fund whitelists and fund state PDAs must be canonical for their seeds.
- Oracle data must be recent and from a trusted feed.

## Decisions
- Global whitelist uses PDA entries per mint (no Merkle root).
- Fees are collected in lamports (not shares).
- Use Pyth for oracle prices.
- Fund seed includes `fund_id` to allow multiple funds per manager.
- Precision is critical; avoid rounding where possible and use integer math with explicit scaling.

## Open Questions
- Exact NAV precision math and integer scaling strategy.
- Token vault lifecycle (sweeping/burning for full liquidation).
