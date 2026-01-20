# Fund Contract - Instruction Details

This file documents every instruction in a consistent format. It is written to support audits and long-term maintenance.

---

Initialize Global Config
I. Accounts:
1. admin (Signer)
   - platform admin wallet
2. fee_treasury (SystemAccount)
   - destination for protocol fees
3. config (init)
   - PDA of the deployed contract
   - seeds = [b"config", config_id]
   - stores:
     - config_id: u64
     - admin: Pubkey
     - keeper: Pubkey
     - fee_treasury: Pubkey
     - sol_usd_pyth_feed: Pubkey
     - pyth_program_id: Pubkey
     - deposit_fee_bps: u16
     - withdraw_fee_bps: u16
     - trade_fee_bps: u16
     - max_manager_fee_bps: u16
     - max_slippage_bps: u16
     - min_manager_deposit_lamports: u64
     - min_withdraw_timelock_secs: i64
     - max_withdraw_timelock_secs: i64
     - bump: u8
     - extra space = 8
     - total space = 211
4. system_program

II. Logic:
1. require checks:
   1. deposit_fee_bps <= 10_000
   2. withdraw_fee_bps <= 10_000
   3. trade_fee_bps <= 10_000
   4. max_manager_fee_bps <= 10_000
   5. max_slippage_bps <= 10_000
   6. min_withdraw_timelock_secs >= 0
   7. max_withdraw_timelock_secs >= min_withdraw_timelock_secs
2. set all fields on the config PDA

---

Update Global Config
I. Accounts:
1. admin (Signer)
2. fee_treasury (SystemAccount)
3. config (mut)
   - PDA seeds = [b"config", config_id]
4. (no system_program required)

II. Logic:
1. require checks:
   1. config.admin == admin
   2. fee bps <= 10_000
   3. max_manager_fee_bps <= 10_000
   4. max_slippage_bps <= 10_000
   5. min_withdraw_timelock_secs >= 0
   6. max_withdraw_timelock_secs >= min_withdraw_timelock_secs
2. update fee_treasury, oracle params, fees, min_manager_deposit_lamports, and timelock bounds

---

Set Keeper
I. Accounts:
1. admin (Signer)
2. config (mut)
   - PDA seeds = [b"config", config_id]

II. Logic:
1. require checks:
   1. config.admin == admin
   2. new_keeper != Pubkey::default()
2. set config.keeper

---

Revoke Keeper
I. Accounts:
1. admin (Signer)
2. config (mut)
   - PDA seeds = [b"config", config_id]

II. Logic:
1. require checks:
   1. config.admin == admin
2. set config.keeper = Pubkey::default()

---

Initialize Trading Fund
I. Accounts:
1. manager (Signer)
2. config
3. fee_treasury (SystemAccount)
4. fund_state (init)
   - PDA seeds = [b"fund", config, manager, fund_id]
   - stores:
     - config: Pubkey
     - manager: Pubkey
     - fund_id: u64
     - fund_type: u8 (0=trading, 1=strategy)
     - share_mint: Pubkey
     - vault: Pubkey
     - total_shares: u64
     - manager_fee_bps: u16
     - min_investor_deposit_lamports: u64
     - withdraw_timelock_secs: i64
     - enabled_token_count: u16
     - active_limit_count: u16
     - active_dca_count: u16
     - next_order_id: u64
     - bump: u8
     - share_mint_bump: u8
     - vault_bump: u8
     - extra space = 8
     - total space = 188
5. trading (init)
   - PDA seeds = [b"trading", fund_state]
   - stores:
     - fund: Pubkey
     - is_locked: bool
     - borrow_amount: u64
     - expected_min_out: u64
     - snapshot_sol: u64
     - snapshot_output: u64
     - output_mint: Pubkey
     - bump: u8
     - extra space = 8
     - total space = 106
6. share_mint (init)
   - SPL Mint PDA seeds = [b"shares", fund_state]
7. manager_share_account (init)
   - ATA for (manager, share_mint)
8. fund_vault (init)
   - PDA seeds = [b"vault", fund_state]
   - program-owned SOL vault
   - space = 8 (discriminator only)
9. system_program
10. token_program
11. associated_token_program
12. rent

II. Logic:
1. require checks:
   1. withdraw_timelock_secs within config bounds
   2. manager_fee_bps <= config.max_manager_fee_bps
   3. initial_deposit_lamports >= config.min_manager_deposit_lamports
2. compute initial deposit fee and net
3. initialize fund_state and trading fields
4. transfer fee to fee_treasury and net to fund_vault
5. mint shares to manager equal to net deposit

---

Initialize Strategy Fund
I. Accounts:
1. manager (Signer)
2. config
3. fee_treasury (SystemAccount)
4. fund_state (init)
   - PDA seeds = [b"fund", config, manager, fund_id]
   - same fields as trading fund, but fund_type = 1
5. share_mint (init)
   - SPL Mint PDA seeds = [b"shares", fund_state]
6. manager_share_account (init)
   - ATA for (manager, share_mint)
7. fund_vault (init)
   - PDA seeds = [b"vault", fund_state]
8. system_program
9. token_program
10. associated_token_program
11. rent

II. Logic:
1. require checks:
   1. withdraw_timelock_secs within config bounds
   2. manager_fee_bps <= config.max_manager_fee_bps
   3. initial_deposit_lamports >= config.min_manager_deposit_lamports
2. compute initial deposit fee and net
3. initialize fund_state fields
4. transfer fee to fee_treasury and net to fund_vault
5. mint shares to manager equal to net deposit

---

Add Token (Global Scope)
I. Accounts:
1. authority (Signer)
   - must be config.admin
2. config
3. mint
4. global_whitelist (mut, unchecked)
   - PDA seeds = [b"global_whitelist", config, mint]
   - stores:
     - config: Pubkey
     - mint: Pubkey
     - decimals: u8
     - pyth_feed: Pubkey
     - enabled: bool
     - bump: u8
     - extra space = 8
     - total space = 107
5. system_program
6. token_program
7. associated_token_program

II. Logic:
1. require checks:
   1. authority == config.admin
   2. pyth_feed != Pubkey::default()
   3. global_whitelist PDA matches seeds and is empty
2. create and serialize GlobalWhitelist

---

Add Token (Fund Scope)
I. Accounts:
1. authority (Signer)
   - must be fund_state.manager
2. config
3. mint
4. global_whitelist (unchecked)
   - validated against config + mint
5. remaining_accounts (ordered)
   1. fund_state (mut)
   2. fund_whitelist (unchecked)
      - PDA seeds = [b"whitelist", fund_state, mint]
      - stores:
        - fund: Pubkey
        - mint: Pubkey
        - decimals: u8
        - pyth_feed: Pubkey
        - enabled: bool
        - bump: u8
        - extra space = 8
        - total space = 107
   3. fund_token_vault (ATA)
      - ATA for (fund_state, mint)
6. system_program
7. token_program
8. associated_token_program

II. Logic:
1. require checks:
   1. fund_state PDA is canonical for config + manager + fund_id
   2. authority == fund_state.manager
   3. global_whitelist exists, enabled, and matches mint and pyth_feed
   4. fund_whitelist PDA matches seeds and is empty
   5. fund_token_vault equals ATA(fund_state, mint)
2. create and serialize FundWhitelist
3. create fund_token_vault ATA if needed
4. increment fund_state.enabled_token_count

---

Remove Token (Global Scope)
I. Accounts:
1. authority (Signer)
   - must be config.admin
2. config
3. mint
4. global_whitelist (mut)
   - PDA seeds = [b"global_whitelist", config, mint]
5. system_program

II. Logic:
1. require checks:
   1. authority == config.admin
   2. global_whitelist PDA matches seeds
2. close GlobalWhitelist and return lamports to authority

---

Remove Token (Fund Scope)
I. Accounts:
1. authority (Signer)
   - must be fund_state.manager
2. config
3. mint
4. remaining_accounts (ordered)
   1. fund_state (mut)
   2. fund_whitelist (mut)
      - PDA seeds = [b"whitelist", fund_state, mint]
   3. fund_token_vault (ATA)
      - ATA for (fund_state, mint)
5. system_program

II. Logic:
1. require checks:
   1. fund_state PDA is canonical and matches fund_id
   2. authority == fund_state.manager
   3. fund_whitelist PDA matches seeds
   4. fund_token_vault is ATA(fund_state, mint)
   5. fund_token_vault.amount == 0
2. close FundWhitelist (program-owned) and refund rent to authority
3. decrement fund_state.enabled_token_count

---

Deposit
I. Accounts:
1. investor (Signer)
2. config
3. fund_state (mut)
4. fund_vault (mut)
5. share_mint (mut)
6. investor_share_account (init_if_needed)
   - ATA for (investor, share_mint)
7. fee_treasury (mut)
8. system_program
9. token_program
10. associated_token_program
11. rent
12. remaining_accounts (strict layout)
   - [sol_feed] + 3 * enabled_token_count
   - then 3 * active_limit_count
   - then 3 * active_dca_count

II. Logic:
1. require checks:
   1. amount_lamports >= fund_state.min_investor_deposit_lamports
2. compute fee and net deposit
3. compute NAV using strict remaining_accounts layout
4. require total_shares > 0 and nav_lamports > 0
5. compute shares_to_mint, require > 0
6. transfer fee to fee_treasury and net to fund_vault
7. mint shares to investor
8. increment fund_state.total_shares

---

Request Withdraw
I. Accounts:
1. investor (Signer)
2. config
3. fund_state
4. share_mint
5. investor_share_account (mut)
6. withdraw_request (init_if_needed)
   - PDA seeds = [b"withdraw", fund_state, investor]
   - stores:
     - fund: Pubkey
     - investor: Pubkey
     - shares: u64
     - request_ts: i64
     - bump: u8
     - extra space = 8
     - total space = 89
7. system_program
8. rent

II. Logic:
1. require checks:
   1. shares > 0
   2. investor_share_account.amount >= shares
2. set withdraw_request fields and timestamp

---

Cancel Withdraw
I. Accounts:
1. investor (Signer)
2. config
3. fund_state
4. withdraw_request (mut, close = investor)
   - PDA seeds = [b"withdraw", fund_state, investor]

II. Logic:
1. require checks:
   1. withdraw_request.fund == fund_state
   2. withdraw_request.investor == investor
2. close withdraw_request (rent refunded to investor)

---

Execute Withdraw
I. Accounts:
1. investor (Signer)
2. config
3. fund_state (mut)
4. fund_vault (mut)
5. share_mint (mut)
6. investor_share_account (mut)
7. withdraw_request (mut, close = investor)
8. fee_treasury (mut)
9. token_program
10. remaining_accounts (same layout as Deposit)

II. Logic:
1. require checks:
   1. withdraw_request.fund == fund_state
   2. withdraw_request.investor == investor
   3. shares > 0
   4. timelock elapsed
   5. investor_share_account.amount >= shares
2. compute NAV using strict remaining_accounts layout
3. compute gross and net lamports, apply withdraw fee
4. require fund_vault.lamports >= gross
5. burn shares from investor
6. decrement fund_state.total_shares
7. move lamports via manual mutation (vault -> investor + fee_treasury)

---

Borrow For Swap (Trading Fund)
I. Accounts:
1. manager (Signer)
2. config
3. fund_state (mut)
4. trading (mut)
   - PDA seeds = [b"trading", fund_state]
5. fund_vault (mut)
6. manager_receive (SystemAccount, mut)
   - must equal manager
7. output_whitelist
8. output_token_vault (mut)
9. instructions_sysvar (unchecked)
10. system_program

II. Logic:
1. require checks:
   1. fund_type == trading
   2. trading.is_locked == false
   3. manager == fund_state.manager
   4. manager_receive == manager
   5. amount_in > 0, min_amount_out > 0
   6. output_whitelist enabled, canonical PDA, matches fund
   7. output_token_vault is ATA(fund_state, output_mint)
   8. fund_vault has sufficient lamports
   9. settle_swap instruction exists later in same tx with matching metas
2. snapshot vault balances and set trading lock fields
3. move SOL from fund_vault to manager_receive via manual lamport mutation

---

Settle Swap (Trading Fund)
I. Accounts:
1. manager (Signer)
2. config
3. fund_state (mut)
4. trading (mut)
5. fund_vault (mut)
6. output_whitelist
7. output_token_vault (mut)

II. Logic:
1. require checks:
   1. trading.is_locked == true
   2. fund_type == trading
   3. manager == fund_state.manager
   4. output_whitelist canonical + enabled
   5. output_token_vault is ATA(fund_state, output_mint)
   6. fund_vault lamports == snapshot_sol - borrow_amount
   7. output_delta >= expected_min_out
2. clear trading lock fields

---

Create Limit Order
I. Accounts:
1. manager (Signer)
2. config
3. fund_state (mut)
4. fund_vault (mut)
5. mint
6. whitelist (FundWhitelist)
7. order (init)
   - PDA seeds = [b"limit_order", fund_state, next_order_id]
   - stores:
     - fund: Pubkey
     - side: u8
     - mint: Pubkey
     - amount_in: u64
     - min_out: u64
     - limit_price: i64
     - price_expo: i32
     - price_feed: Pubkey
     - pyth_program_id: Pubkey
     - created_ts: i64
     - expiry_ts: i64
     - status: u8
     - bump: u8
     - extra space = 8
     - total space = 183
8. order_sol_vault (mut, unchecked)
   - PDA seeds = [b"limit_order_sol_vault", order]
   - system account, space = 0
9. order_vault_auth (unchecked)
   - PDA seeds = [b"limit_order_vault_auth", order]
10. order_token_vault (mut, unchecked)
    - ATA for (order_vault_auth, WSOL or mint)
11. fund_token_vault (mut)
    - ATA for (fund_state, mint)
12. wsol_mint (native_mint)
13. system_program
14. token_program
15. associated_token_program
16. rent

II. Logic:
1. require checks:
   1. fund_state.manager == manager
   2. fund_type == trading
   3. side is BUY or SELL
   4. amount_in > 0, min_out > 0, limit_price > 0
   5. whitelist enabled and matches fund + mint
2. increment fund_state.next_order_id and active_limit_count
3. write LimitOrder fields
4. BUY:
   1. create order_sol_vault system PDA if needed
   2. require order_token_vault is ATA(vault_auth, WSOL)
   3. create WSOL ATA if needed, require amount == 0
   4. move lamports from fund_vault to order_sol_vault
5. SELL:
   1. require order_token_vault is ATA(vault_auth, mint)
   2. create ATA if needed, require amount == 0
   3. transfer tokens from fund_token_vault to order_token_vault using fund PDA signer

---

Execute Limit Order
I. Accounts:
1. executor (Signer, must be keeper)
2. config
3. fund_state (mut)
4. fund_vault (mut)
5. whitelist (FundWhitelist)
6. fund_token_vault (mut)
7. order (mut)
8. order_sol_vault (mut, unchecked)
9. order_vault_auth (unchecked)
10. order_token_vault (mut)
11. price_feed (unchecked)
12. sol_price_feed (unchecked)
13. swap_program (unchecked, Jupiter)
14. token_program
15. system_program
16. remaining_accounts (CPI accounts for Jupiter)

II. Logic:
1. require checks:
   1. executor == config.keeper
   2. fund_type == trading
   3. order.status == open
   4. order.fund == fund_state
   5. expiry_ts not passed (if set)
   6. whitelist matches fund/mint and pinned feed
   7. price_feed owner == pyth_program_id, fresh + confidence
   8. price trigger satisfied
   9. swap_program == Jupiter
   10. order vaults are canonical
   11. fund_token_vault is ATA(fund_state, mint)
2. BUY:
   1. move lamports from order_sol_vault to order_token_vault
   2. sync_native
3. invoke Jupiter CPI (order_vault_auth signs)
4. post-swap checks:
   1. output delta >= min_out
   2. output delta >= oracle-based slippage guard
   3. order_token_vault drained to 0
5. close order_token_vault
6. set order.status = executed
7. decrement active_limit_count

---

Cancel Limit Order
I. Accounts:
1. manager (Signer)
2. config
3. fund_state (mut)
4. fund_vault (mut)
5. whitelist (FundWhitelist)
6. fund_token_vault (mut)
7. order (mut, close = fund_vault)
8. order_sol_vault (mut, unchecked)
9. order_vault_auth (unchecked)
10. order_token_vault (mut)
11. token_program
12. system_program

II. Logic:
1. require checks:
   1. manager == fund_state.manager
   2. fund_type == trading
   3. order.status == open
   4. order.fund == fund_state
2. BUY:
   1. transfer all lamports from order_sol_vault to fund_vault
   2. close WSOL ATA if empty
3. SELL:
   1. transfer tokens from order_token_vault to fund_token_vault
   2. close order_token_vault
4. set order.status = cancelled
5. decrement active_limit_count

---

Create DCA Order
I. Accounts:
1. manager (Signer)
2. config
3. fund_state (mut)
4. fund_vault (mut)
5. mint
6. whitelist (FundWhitelist)
7. order (init)
   - PDA seeds = [b"dca_order", fund_state, next_order_id]
   - stores:
     - fund: Pubkey
     - side: u8
     - mint: Pubkey
     - total_amount: u64
     - slice_amount: u64
     - remaining_amount: u64
     - interval_secs: i64
     - next_exec_ts: i64
     - min_out: u64
     - price_feed: Pubkey
     - pyth_program_id: Pubkey
     - expiry_ts: i64
     - status: u8
     - bump: u8
     - extra space = 8
     - total space = 195
8. order_sol_vault (mut, unchecked)
   - PDA seeds = [b"dca_order_sol_vault", order]
   - system account, space = 0
9. order_vault_auth (unchecked)
   - PDA seeds = [b"dca_order_vault_auth", order]
10. order_token_vault (mut, unchecked)
    - ATA for (order_vault_auth, WSOL or mint)
11. fund_token_vault (mut)
    - ATA for (fund_state, mint)
12. wsol_mint (native_mint)
13. system_program
14. token_program
15. associated_token_program
16. rent

II. Logic:
1. require checks:
   1. side is BUY or SELL
   2. total_amount > 0, slice_amount > 0, slice_amount <= total_amount
   3. interval_secs > 0, min_out > 0
   4. manager == fund_state.manager
   5. fund_type == trading
   6. active_dca_count < MAX_ACTIVE_DCA
   7. whitelist enabled and matches fund + mint
2. increment next_order_id and active_dca_count
3. write DcaOrder fields and set next_exec_ts
4. create order_sol_vault system PDA if needed
5. BUY:
   1. order_token_vault is ATA(vault_auth, WSOL)
   2. create WSOL ATA if needed, require amount == 0
   3. move lamports from fund_vault to order_sol_vault
6. SELL:
   1. order_token_vault is ATA(vault_auth, mint)
   2. create ATA if needed, require amount == 0
   3. transfer tokens from fund_token_vault to order_token_vault

---

Execute DCA Order
I. Accounts:
1. executor (Signer, must be keeper)
2. config
3. fund_state (mut)
4. fund_vault (mut)
5. whitelist (FundWhitelist)
6. fund_token_vault (mut)
7. order (mut)
8. order_sol_vault (mut, unchecked)
9. order_vault_auth (unchecked)
10. order_token_vault (mut)
11. price_feed (unchecked)
12. sol_price_feed (unchecked)
13. swap_program (unchecked, Jupiter)
14. token_program
15. system_program
16. remaining_accounts (CPI accounts for Jupiter)

II. Logic:
1. require checks:
   1. executor == config.keeper
   2. fund_type == trading
   3. order.status == open
   4. order.fund == fund_state
   5. now >= next_exec_ts
   6. expiry_ts not passed (if set)
   7. whitelist matches fund/mint and pinned feed
   8. oracle feed owner, freshness, confidence
   9. swap_program == Jupiter
2. compute slice_amount for this execution
3. BUY:
   1. move lamports from order_sol_vault to order_token_vault
   2. sync_native
4. invoke Jupiter CPI (order_vault_auth signs)
5. post-swap checks:
   1. output delta >= min_out
   2. output delta >= oracle slippage guard
   3. order_token_vault drained to 0
6. update remaining_amount and next_exec_ts
7. if remaining_amount == 0, close vaults and decrement active_dca_count

---

Cancel DCA Order
I. Accounts:
1. manager (Signer)
2. config
3. fund_state (mut)
4. fund_vault (mut)
5. whitelist (FundWhitelist)
6. fund_token_vault (mut)
7. order (mut)
8. order_sol_vault (mut, unchecked)
9. order_vault_auth (unchecked)
10. order_token_vault (mut)
11. token_program
12. system_program

II. Logic:
1. require checks:
   1. manager == fund_state.manager
   2. fund_type == trading
   3. order.status == open
   4. order.fund == fund_state
2. BUY:
   1. transfer all lamports from order_sol_vault to fund_vault
   2. close WSOL ATA if empty
3. SELL:
   1. transfer tokens from order_token_vault to fund_token_vault
   2. close order_token_vault
4. set order.status = cancelled
5. decrement active_dca_count

---

Set Strategy
I. Accounts:
1. manager (Signer)
2. fund_state (mut)
3. strategy (init)
   - PDA seeds = [b"strategy", fund_state]
   - stores:
     - fund: Pubkey
     - allocation_count: u8
     - allocations: [mint, weight_bps] (max 8)
     - rebalance_threshold_bps: u16
     - rebalance_cooldown_secs: i64
     - last_rebalance_ts: i64
     - bump: u8
     - extra space = 8
     - total space = 332
4. system_program
5. remaining_accounts
   - list of FundWhitelist PDAs, one per allocation

II. Logic:
1. require checks:
   1. manager == fund_state.manager
   2. fund_type == strategy
   3. allocations non-empty, <= 8
   4. weights sum to 10,000
   5. rebalance_threshold_bps <= 10,000
   6. rebalance_cooldown_secs > 0
   7. enabled_token_count == allocation_count
   8. each allocation mint has a matching enabled FundWhitelist
2. write Strategy fields and initialize allocation array
3. set last_rebalance_ts = now

---

Rebalance Strategy
I. Accounts:
1. executor (Signer, must be keeper)
2. config
3. fund_state (mut)
4. fund_vault (mut)
5. strategy (mut)
6. fund_token_vault (mut)
   - ATA for (fund_state, target_mint)
7. fund_wsol_vault (mut, unchecked)
   - ATA for (fund_state, WSOL)
8. wsol_mint (native_mint)
9. sol_price_feed (unchecked)
10. swap_program (unchecked, Jupiter)
11. token_program
12. associated_token_program
13. system_program
14. remaining_accounts
   - validation triplets for every allocation:
     - [FundWhitelist, token vault ATA, Pyth price]
   - CPI accounts for Jupiter (after the validation triplets)

II. Logic:
1. require checks:
   1. executor == config.keeper
   2. fund_type == strategy
   3. strategy.fund == fund_state
   4. allocation_count > 0 and matches enabled_token_count
   5. WSOL vault is ATA(fund_state, WSOL) and amount == 0
   6. cooldown elapsed
2. validate SOL price feed and token price feeds
3. compute NAV from fund_vault + token vault values
4. compute target value for target_mint
5. require deviation > threshold
6. split remaining_accounts:
   - first 3 * allocation_count for validation
   - remainder for Jupiter CPI
7. BUY path:
   1. move SOL from fund_vault to fund_wsol_vault and sync_native
   2. Jupiter CPI
   3. require token delta >= min_out and oracle slippage guard
8. SELL path:
   1. Jupiter CPI
   2. enforce actual_sold <= sell_amount + dust tolerance
   3. require SOL delta >= min_out and oracle slippage guard
9. update last_rebalance_ts

---

Sweep WSOL
I. Accounts:
1. executor (Signer, must be keeper)
2. config
3. fund_state
4. fund_vault (mut)
5. fund_wsol_vault (mut, unchecked)
   - ATA for (fund_state, WSOL)
6. token_program

II. Logic:
1. require checks:
   1. executor == config.keeper
   2. fund_wsol_vault == ATA(fund_state, WSOL)
2. if WSOL vault does not exist, return Ok
3. sync_native on WSOL ATA
4. close WSOL ATA to fund_vault (fund_state PDA signs)
