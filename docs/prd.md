# Product Requirements Document

**Quick-Predict**

Telegram-Native Trading Interface for DeepBook Predict

DeepBook Hackathon · Target: $35,000 First Prize

| Document version | 2.0 |
| --- | --- |
| Status | Final — approved for build |
| Product | Quick-Predict Telegram Bot |
| Protocol | DeepBook Predict (Sui Testnet) |
| Author | Product & Engineering Team |
| Last updated | May 2026 |
| Target prize | $35,000 First Prize |
| Mainnet readiness | Day-one deployment on mainnet launch |

# 1. Overview

Quick-Predict is a Telegram bot that serves as the consumer interface for DeepBook Predict — the on-chain options protocol on Sui. It lets any Telegram user open, monitor, and settle binary prediction positions using plain chat commands, with no wallet setup, no browser extension, and no prior crypto knowledge required.

The product targets a $35,000 first prize by delivering the highest-demo-impact, highest-mainnet-viability submission in the hackathon. It is not a proof of concept. It is a shippable product.

- **Network**: Sui Testnet
- **Public server**: https://predict-server.testnet.mystenlabs.com
- **Predict package**: 0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138
- **Predict object**: 0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a
- **Predict registry**: 0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64
- **Quote asset (dUSDC)**: 0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC (6 decimals)
- **Source branch**: predict-testnet-4-16
- **Asset coverage**: Oracle-agnostic — all assets from GET /predicts/:predict_id/oracles supported automatically
- **Custody model**: Custodial hot wallet v1; zkLogin self-custody migration in v2
- **No new smart contract**: bot calls predict::mint and predict::redeem_permissionless only

# 2. Problem Statement

DeepBook Predict is technically superior to every competing prediction market — sub-400ms settlement, institutional SVI pricing via Block Scholes, composability with Margin and Spot. Despite this, it has zero consumer-facing distribution.

The friction between 'I think BTC is going up' and 'I have a live on-chain options position' currently requires: a Sui wallet, testnet tokens, understanding of PredictManager objects, and a browser. This gates out the vast majority of potential users.

Simultaneously, the Polymarket Telegram bot ecosystem (PolyGun, PolyCop, Predictify, WagerUp) has already proven that Telegram is the correct distribution channel for prediction markets. These products serve hundreds of thousands of users — all on Polygon, none on Sui.

Quick-Predict closes both gaps simultaneously.

# 3. Goals

## 3.1 Hackathon Goals

| ID | Goal | Success Metric |
| --- | --- | --- |
| G1 | End-to-end live demo | Judge types /up, gets on-chain tx confirmed in < 5s |
| G2 | Options-accurate UX | Premium cost and implied probability shown before every trade |
| G3 | Social layer working | Group leaderboard with 3+ users visible during demo |
| G4 | Settlement automated | One position auto-settles with DM notification during judging |
| G5 | Copy trading functional | One trade mirrored via /copy command in demo |
| G6 | Oracle-agnostic | Bot lists assets dynamically; zero hardcoded asset names |
| G7 | Mainnet-ready architecture | All PTBs written for mainnet compatibility; zkLogin path documented |

## 3.2 Non-Goals (v1)

- Self-custody wallets or private key import
- Web or mobile app frontend
- Writing any new smart contracts
- Regulatory compliance or KYC
- Support for assets beyond what the protocol oracle registry returns

# 4. User Personas

| Persona | Profile | Primary Need | Key Behaviour |
| --- | --- | --- | --- |
| Telegram Trader | Non-custodial crypto user, phone-first, follows signals groups | Trade in < 60s with zero setup | Uses /up and /down, shares wins to group |
| Crypto Native | Has Sui wallet, uses Polymarket, wants speed | Fast execution without switching to browser | Uses /copy and /status heavily |
| Alpha Caller | Runs a 400-person signals group, shares Polymarket links manually | Group engagement and leaderboard competition | Uses /tournament and /groupleaderboard |
| Hackathon Judge | DeepBook team member, 10 minutes per project | Live demo, on-chain proof, mainnet story | Will type a command themselves during evaluation |

# 5. Functional Requirements

## 5.1 Oracle-Agnostic Market Discovery

The bot maintains a live oracle registry, refreshed every 2 minutes from the predict-server active oracle endpoint. It never hardcodes an asset name, oracle ID, or expiry. All commands resolve asset and oracle dynamically from this registry.

When multiple assets are active and a user omits the asset parameter, the bot presents an inline keyboard: [BTC] [ETH] [SOL]. When only one asset is active, it defaults silently.

## 5.2 Command Specification

### Trading Commands

| Command | Syntax | Description | Output |
| --- | --- | --- | --- |
| /up | /up [ASSET] <strike> <minutes> <amount> | Open a long binary — asset above strike at expiry | Price preview → confirm → tx hash + keyboard |
| /down | /down [ASSET] <strike> <minutes> <amount> | Open a short binary — asset below strike at expiry | Price preview → confirm → tx hash + keyboard |
| /range | /range [ASSET] <low> <high> <minutes> <amount> | Open a vertical range position | Price preview → confirm → tx hash + keyboard |
| /markets | /markets | List all active oracles with live price and expiry countdown | Asset table with /up and /down shortcuts |
| /status | /status | All open positions with ITM/OTM status and time to expiry | Positions table + balance |
| /balance | /balance | Current dUSDC balance and last 5 transactions | Balance + mini tx history |

### Social Commands

| Command | Syntax | Description | Output |
| --- | --- | --- | --- |
| /leaderboard | /leaderboard [weekly\|alltime] | Global top 10 by net PnL | Ranked list with streak indicators |
| /groupleaderboard | /groupleaderboard | Leaderboard scoped to this Telegram group | Same format, members only |
| /copy | /copy @username | Mirror next trade from target user at 1:1 size | Confirmation + copy active notification |
| /uncopy | /uncopy [@username] | Stop copying a user or all users | Confirmation |
| /copyboard | /copyboard | Top 5 most-copied users with 7-day net PnL | Ranked copy leaderboard |
| /tournament | /tournament start <minutes> | Start a group trading tournament (admin only) | Tournament open announcement + live scoring |
| /share | /share | Generate forwardable trade card for last position | Text card with on-chain tx hash |

### Parameter Constraints

| Parameter | Type | Constraints | Behaviour if Violated |
| --- | --- | --- | --- |
| ASSET | string (optional) | Any symbol returned by oracle registry | Prompt with inline keyboard if multiple active |
| strike | float | 1,000 – 999,999 (USD) | Suggest nearest valid strike from oracle grid |
| minutes | integer | 5 – 60 | Route to nearest available oracle expiry; inform user |
| amount | float | 1 – 10,000 dUSDC | Show balance, show max affordable notional at current premium |

# 6. Key UX Flows

## 6.1 Trade Entry Flow (Core Flow)

This is the most critical user journey. Every step must be fast and informative.

- User sends:  /up BTC 71000 10 100
- Bot immediately returns trade preview — premium cost, max payout, implied probability, one-line AI market context, and a [Confirm] / [Cancel] inline keyboard
- User taps Confirm
- Bot shows 'Submitting…' indicator
- PTB executes against predict::mint on Sui testnet
- Bot edits message to success state: asset, direction, strike, expiry time, premium paid, Sui explorer link
- Inline keyboard: [Check PnL] [Share] [Copy my trades]

Total elapsed time target: under 5 seconds from command to confirmed on-chain transaction.

## 6.2 Trade Preview Message Format

```text
Trade preview
BTC above $71,000
Expiry: 14:32 UTC (in 9 min) · Current BTC: $70,234
Premium:           22 dUSDC
Max payout:       100 dUSDC
Net if correct:   +78 dUSDC
Implied prob:       22%
BTC is 1.1% below strike. 22% implied probability of closing above.
[Confirm ✓]   [Cancel ✗]
```

## 6.3 Settlement DM Format (Win)

```text
You won!
BTC settled at $71,450
Your call: BTC above $71,000 ✓
Premium paid:      22 dUSDC
Payout:           100 dUSDC
Net profit:       +78 dUSDC
Balance: 1,078 dUSDC · Streak: 3 wins
[Share win]   [Trade again]
```

## 6.4 Copy Trading Flow

- User A places any trade via /up or /down
- All users who have run /copy @UserA receive an immediate DM with the same trade preview and a [Confirm copy] / [Skip] keyboard
- Confirmation executes the same PTB for the follower
- Copy trades are independently tracked in PnL — followers see their own premiums and payouts

## 6.5 Group Tournament Flow

- Group admin sends: /tournament start 30
- Bot announces tournament open to entire group
- All member trades during the window count toward the group standings
- Any member can check /tournament status for live rankings
- At expiry the bot posts the final leaderboard and announces the winner

# 7. Technical Architecture

## 7.1 Stack

| Layer | Technology | Rationale |
| --- | --- | --- |
| Runtime | Node.js 20 + TypeScript | Official Sui SDK support; fast iteration |
| Telegram framework | grammy v1.x | Best TypeScript types; middleware model; session handling |
| Sui SDK | @mysten/sui | Official SDK; PTB builder included |
| Database | SQLite via better-sqlite3 | Zero-config; atomic transactions; hackathon-appropriate |
| AI context | Anthropic API (claude-sonnet-4) | One-line market context displayed in trade preview |
| Scheduler | node-cron | Settlement keeper polling |
| Deployment | Railway.app | Free tier; persistent disk; GitHub CI; auto-restart |

## 7.2 Module Structure

```text
src/
  bot/
    commands/  trading.ts · social.ts · info.ts
    callbacks/  inline keyboard handlers
    middleware/ user.ts · group.ts · rate-limit.ts
  sui/
    client.ts  SuiClient singleton + keypair
    mint.ts    predict::mint PTB builder
    redeem.ts  predict::redeem_permissionless PTB
    manager.ts PredictManager bootstrap + reads
  predict/
    server.ts  predict-server API client
    registry.ts oracle registry (live-polled, asset-agnostic)
    pricing.ts SVI premium parsing + implied probability
  db/
    schema.ts  SQLite schema + migrations
    users.ts · positions.ts · leaderboard.ts · copy.ts · tournaments.ts
  keeper/
    settler.ts 30s poll → redeem → DM dispatch
  ai/
    context.ts Anthropic API call for pre-trade market context
  index.ts   Bot + keeper startup
```

## 7.3 Database Schema

### users

| Column | Type | Description |
| --- | --- | --- |
| telegram_id | TEXT PK | Telegram user ID |
| username | TEXT | @handle |
| dusdc_balance | INTEGER | Off-chain balance in base units (6 decimals) |
| total_pnl | INTEGER | Cumulative net PnL (payout minus premium) |
| win_count / loss_count | INTEGER | Trade outcome counters |
| streak / best_streak | INTEGER | Consecutive win streak tracking |
| created_at / last_active | INTEGER | Unix timestamps |

### positions

| Column | Type | Description |
| --- | --- | --- |
| internal_id | TEXT PK | UUID — our internal key |
| telegram_id | TEXT FK | Owner |
| asset_symbol | TEXT | e.g. BTC, ETH, SOL — from oracle registry |
| oracle_id | TEXT | OracleSVI object ID |
| expiry_ts | INTEGER | Oracle expiry timestamp |
| strike | INTEGER | Strike price in dUSDC base units |
| is_up | INTEGER | 1 = above, 0 = below |
| notional_dusdc | INTEGER | Max payout amount |
| premium_dusdc | INTEGER | Actual cost paid (from SVI price preview) |
| implied_prob | REAL | Implied probability at time of mint |
| status | TEXT | open \| settled \| redeemed |
| payout_dusdc / net_pnl | INTEGER | Settlement output |
| tx_hash | TEXT | On-chain transaction hash |

### Supporting tables

| Table | Key Columns | Purpose |
| --- | --- | --- |
| copy_follows | follower_id, leader_id, ratio, active | Copy trading relationships |
| tournaments | id, group_id, start_ts, end_ts, status | Group tournament state |
| tournament_scores | tournament_id, telegram_id, net_pnl, trade_count | Per-tournament rankings |
| user_groups | telegram_id, group_id, last_seen | Group membership for scoped leaderboards |

## 7.4 On-Chain Interaction Map

| Trigger | Bot Action | Protocol Call | Notes |
| --- | --- | --- | --- |
| User confirms /up or /down | Build and submit PTB | predict::mint(manager, predict, oracle, strike, direction, coin) | Position stored as quantity in MarketKey table inside PredictManager |
| Oracle settles (keeper) | Scan DB for open positions on this oracle | predict::redeem_permissionless(manager, predict, settled_oracle) | Permissionless — no original signer required; payout returned to manager |
| Bot startup (once) | Create manager if not exists | predict::create_manager(predict) | Bot has one PredictManager for all custodial positions |
| /range confirmed | Build range PTB | predict::mint with lower_strike and higher_strike | Pays when settlement lands in (lower, higher] band |

## 7.5 predict-server API Endpoints Used

All reads go through the public server unless a wallet flow requires authoritative on-chain state. The bot uses the following endpoints:

| Endpoint | Method | Bot Usage |
| --- | --- | --- |
| GET /predicts/:predict_id/oracles | REST | Oracle registry refresh every 2 min — source of all asset/expiry data |
| GET /oracles/:oracle_id/state | REST | Oracle lifecycle check (Active / Pending settlement / Settled) before every mint |
| GET /oracles/:oracle_id/svi/latest | REST | Latest SVI params — used to compute implied probability and premium estimate |
| GET /oracles/:oracle_id/prices/latest | REST | Current spot price for /markets display and trade preview context |
| GET /predicts/:predict_id/vault/summary | REST | Vault utilisation — shown when approaching exposure cap |
| GET /predicts/:predict_id/state | REST | Protocol config including max_total_exposure_pct |
| GET /managers/:manager_id/positions/summary | REST | Verify on-chain position state after mint confirmation |
| GET /positions/minted | REST | Keeper: scan for all open positions to match against settled oracles |
| GET /oracles/:oracle_id/ask-bounds | REST | Per-oracle price bounds — enforce before submitting mint to avoid ask-bound rejection |

## 7.6 Live Event Streaming (Low-Latency Oracle Updates)

For the settlement keeper and real-time price display, subscribe to Sui checkpoint or event streaming filtered by the Predict package ID. The four event types to watch:

| Event Type | Trigger | Bot Action |
| --- | --- | --- |
| oracle::OracleActivated | New oracle goes live | Add to registry; announce new market in active groups if configured |
| oracle::OraclePricesUpdated | Spot/forward price updated | Refresh displayed price in /status and /markets cache |
| oracle::OracleSVIUpdated | SVI parameters updated | Invalidate cached SVI premium estimates; force re-price on next trade preview |
| oracle::OracleSettled | Oracle expiry + first post-expiry price push | Trigger keeper: call redeem_permissionless, send settlement DMs, update leaderboard |

Package ID for event filter: 0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138

# 8. Pricing and Options UX

DeepBook Predict prices positions from oracle fair price plus protocol spread and utilization adjustments. Users are paying an options premium, not a 1:1 stake. This distinction is the most important UX decision in the product — every competitor ignores it; we make it central.

Before every mint transaction the bot must call the price preview endpoint on predict-server (or compute from SVI parameters if no endpoint exists) and display:

- Premium cost — the actual dUSDC deducted from balance
- Max payout — the notional amount received on a win
- Net profit — payout minus premium
- Implied probability — premium divided by notional, displayed as a percentage
- AI context line — one sentence of market context from the Anthropic API

This approach serves three purposes: it is honest with users about cost, it demonstrates deep protocol understanding to judges, and it naturally teaches users how binary options work — turning the product into its own onboarding.

# 9. Security Architecture

The Polycule hack (January 2026, $230k lost) made security the first question any judge or user will ask about a custodial Telegram bot. The following measures are non-negotiable.

## 9.1 Hot Wallet Controls

- Private key stored in Railway.app encrypted environment variables only — never in code, never in DB
- Key rotation plan: if compromised, predict::redeem_permissionless lets positions be redeemed to any address without the original signer
- Withdrawal limits: no single user can withdraw more than 500 dUSDC per hour off-chain

## 9.2 On-Chain Transparency

- Every transaction hash surfaced to the user and hyperlinked to Sui testnet explorer
- Bot's single wallet address is public — anyone can audit the aggregate position
- Users can independently verify their position quantities by reading the PredictManager object on-chain

## 9.3 Rate Limiting

| Limit | Value | Scope | Enforcement |
| --- | --- | --- | --- |
| Max open positions | 10 | Per user | DB check before mint |
| Trade cooldown | 30 seconds | Per user | In-memory timestamp check |
| Max trades per hour | 10 | Per user | DB rolling count |
| Copy leaders max | 3 | Per user | copy_follows table count |
| Tournament concurrent | 1 | Per group | tournaments table check |

## 9.4 zkLogin Migration Path (v2)

Sui's zkLogin enables wallet creation from OAuth providers (Google, Apple). Post-hackathon, each user gets their own on-chain PredictManager created via their zkLogin wallet. The UX is identical — no command changes. Custody moves entirely to the user. This is the definitive answer to the custody question and a genuine technical differentiator vs all Polygon-based competitors.

# 10. Non-Functional Requirements

## 10.1 Performance Targets

| Requirement | Target | Implementation Note |
| --- | --- | --- |
| Command acknowledgement | < 500ms | grammy middleware; synchronous SQLite reads |
| Price preview display | < 1.5s | Parallel: predict-server API + Anthropic API |
| On-chain tx submission | < 5s | PTB pre-built before user taps Confirm |
| Settlement detection lag | < 2 minutes | 30s keeper polling of predict-server settled oracle endpoint |
| Bot uptime during judging | 99.9% | Railway.app with auto-restart on crash |
| Oracle registry refresh | Every 2 minutes | Background cron; zero impact on command latency |

## 10.2 Error Handling

Every error returns a specific, actionable message. Generic error strings are not acceptable.

| Error Scenario | User-Facing Response | Recovery Action |
| --- | --- | --- |
| Oracle expired between preview and confirm | Oracle expired while you were confirming. Here is the next available expiry: [new preview] | Auto-route to next oracle, re-display preview |
| Insufficient vault liquidity | Max position for this expiry is X dUSDC (vault is 94% utilised). Try a smaller amount. | Show actual max derived from vault state |
| User balance too low | You have 450 dUSDC. At the current 22% premium, max notional is ~2,045 dUSDC. Try: /up BTC 71000 10 450 | Show max affordable notional |
| On-chain tx timeout | Transaction timed out — your dUSDC has been returned. Try again. | Balance restored atomically in SQLite |
| Malformed command | Usage: /up [ASSET] <strike> <minutes> <amount>. Example: /up BTC 71000 10 100 | Show correct syntax with working example |
| No oracle matches requested minutes | Nearest available expiry is 12 minutes. Routing to that oracle. | Silently route; inform user |
| Copy leader has no recent trades | @user has not traded in 7 days. See /copyboard for active traders. | Offer copyboard alternative |

# 11. Feature Priority Matrix

| Feature | Priority | Build Day | Demo Impact |
| --- | --- | --- | --- |
| Oracle-agnostic registry | P0 — must ship | Day 1 | Foundation for all commands |
| predict::mint PTB integration | P0 — must ship | Day 1 | Core value proposition |
| predict::redeem_permissionless keeper | P0 — must ship | Day 1 | Minimum requirement proof |
| Trade preview with premium + implied prob | P0 — must ship | Day 2 | Biggest judge differentiator |
| /start onboarding + balance | P0 — must ship | Day 2 | Demo entry point |
| /up and /down commands (full flow) | P0 — must ship | Day 2 | Core trading flow |
| Settlement DM with net PnL | P0 — must ship | Day 3 | Closes the loop in the demo |
| /status and /balance | P0 — must ship | Day 3 | Portfolio management baseline |
| /leaderboard and /groupleaderboard | P1 — high | Day 3 | Social differentiation |
| Share trade card (text) | P1 — high | Day 3 | Viral acquisition mechanic |
| /copy and /copyboard | P1 — high | Day 3 | Killer feature; biggest demo moment |
| AI market context (Anthropic API) | P1 — high | Day 4 | 15 lines of code; maximum visual impact |
| Group tournament mode | P2 — medium | Day 4 | Best group demo feature |
| /range positions | P3 — stretch | Day 4 if time | Deeper protocol integration proof |
| /alert price notifications | P3 — stretch | Day 4 if time | Retention feature |

# 12. Build Milestones

Critical path note: the Sui SDK and predict::mint PTB are the highest-risk components. Tackle them first on Day 1. All other work (Telegram handlers, DB, social features) is low-risk and can proceed in parallel once the on-chain calls are proven.

| Milestone | Deliverable | Day | Risk |
| --- | --- | --- | --- |
| M0 — Protocol research | Hit predict-server API; document all response shapes; confirm preview endpoint existence | Day 1 AM | High |
| M1 — Sui integration | predict::mint and predict::redeem_permissionless verified on testnet via Sui explorer | Day 1 PM | High |
| M2 — Oracle registry | Live oracle polling; asset-agnostic command parsing; /markets command working | Day 2 AM | Medium |
| M3 — Trade preview | Premium, payout, implied probability displayed correctly before every mint | Day 2 AM | Medium |
| M4 — Core commands | /start, /up, /down, /status, /balance end-to-end with DB persistence | Day 2 PM | Low |
| M5 — Settlement keeper | 30s poll; auto-redeem; settlement DM with full net PnL breakdown | Day 3 AM | Medium |
| M6 — Social layer | /leaderboard, /groupleaderboard, /copy, /copyboard, share cards | Day 3 PM | Low |
| M7 — AI context | Anthropic API call returning one-line market context in trade preview | Day 4 AM | Low |
| M8 — Tournament | Group tournament start, live standings, winner announcement | Day 4 AM | Low |
| M9 — Polish and deploy | All error cases; rate limiting; Railway deployment; demo prep | Day 4 PM | Low |

# 13. Resolved Integration Details and Remaining Unknowns

The contract docs have answered most previously open questions. The table below states what is now known, what is confirmed by the docs, and what still needs a live API call to resolve on Day 1.

| ID | What We Now Know | Source | Day 1 Action |
| --- | --- | --- | --- |
| OQ-1 | No /preview endpoint exists in the public API. Price preview must be computed from GET /oracles/:oracle_id/svi/latest (SVI params) using the closed-form binary digital pricing formula: price = N(d2) where d2 is derived from SVI vol at the given strike and expiry. | GET /oracles/:oracle_id/svi/latest — confirmed in docs | Implement SVI pricer in pricing.ts on Day 1. No external endpoint dependency. |
| OQ-2 | predict::mint exact argument order must be read from packages/predict/sources/predict.move on the predict-testnet-4-16 branch. Docs confirm it takes: manager, predict, oracle, strike, is_up, and the quote coin. | github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/predict.move | Wrong order = every tx fails. Verify before writing mint.ts. |
| OQ-3 | predict::redeem_permissionless targets a specific settled OracleSVI. Docs confirm: after settlement the vault compacts dense strike matrix into settled state. Keeper must call redeem per settled oracle, not per individual position. | predict.move source + Design doc: 'vault can compact...after settlement' | Keeper loop: one redeem call per settled oracle covers all positions in that oracle. |
| OQ-4 | Oracle list is available at GET /predicts/:predict_id/oracles. The underlying asset symbol field name must be confirmed by hitting the live endpoint. Use predict object ID: 0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a | curl https://predict-server.testnet.mystenlabs.com/predicts/0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a/oracles | Determines the field name used for oracle-agnostic asset grouping in registry.ts. |
| OQ-5 | Docs state each user creates one PredictManager and reuses it. For custodial v1 the bot holds one manager. Positions are stored as quantities keyed by MarketKey (oracle_id, expiry, strike, is_up) — multiple users betting the same key share one on-chain quantity entry. Off-chain DB must track per-user quantities independently. | Design doc: 'manager stores binary position quantities in a table keyed by MarketKey' | DB positions table is the source of truth for per-user exposure. On-chain manager tracks aggregate only. |
| OQ-6 | Vault risk is enforced by max_total_exposure_pct config on the Predict shared object. Read current value via GET /predicts/:predict_id/state before computing max allowed notional per trade. Surface vault utilisation to users when approaching the limit. | GET /predicts/:predict_id/vault/summary — confirmed endpoint in docs | Show users when vault is near capacity; error message must show actual max notional available. |

# 14. Judging Demo Script

Target duration: 90 seconds. Run live, not as a video. Practice this three times before judging.

## 0:00 — Hook (15 seconds)

"Polymarket did $7 billion in February alone. DeepBook Predict is objectively better — sub-400ms settlement, institutional Block Scholes pricing, composable with the rest of DeFi. But it has zero consumer users. Here is the distribution layer."

## 0:15 — Live trade demo (40 seconds)

Open Telegram on phone or screen share. DM the bot. Type /start — show balance and live BTC price appearing. Type /up BTC 71000 10 100. Show the trade preview: premium, implied probability, AI context line. Say: "This is what every competitor misses — we show the actual options premium, not a fake 1:1 stake." Tap Confirm. Show the success message with Sui explorer link. Open the explorer on screen. Say: "That is a real on-chain transaction. Block Scholes SVI priced it. The vault is on the other side."

## 0:55 — Social layer (20 seconds)

Switch to demo group. Type /groupleaderboard — show three accounts competing. Type /tournament start 5. Show the announcement. Say: "Prediction markets go viral as social games, not as financial instruments. This is how you get the next 100,000 users on Sui."

## 1:15 — Mainnet story (15 seconds)

"Every PTB in this bot is written for mainnet. The oracle registry is live-polled — when DeepBook adds ETH or SOL, the bot supports them automatically. When zkLogin ships, users get self-custody without changing a single command. Quick-Predict is the distribution DeepBook Predict needs to win."

# Appendix A — Environment Variables

```env
# All values are live testnet — copy exactly as shown
BOT_TOKEN=                         # From @BotFather
PRIVATE_KEY=                       # Bot Sui keypair hex (32 bytes)
ANTHROPIC_API_KEY=                 # For AI market context feature

# DeepBook Predict — testnet (predict-testnet-4-16)
PREDICT_PACKAGE_ID=0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138
PREDICT_OBJECT_ID=0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a
PREDICT_REGISTRY_ID=0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64
DUSDC_TYPE=0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC
DUSDC_CURRENCY_ID=0xf3000dff421833d4bb8ed58fac146d691a3aaba2785aa1989af65a7089ca3e9c
DUSDC_DECIMALS=6

# Populated at first bot startup (predict::create_manager result)
PREDICT_MANAGER_ID=                # Set after manager creation

# Endpoints
SUI_RPC_URL=https://fullnode.testnet.sui.io
PREDICT_SERVER_URL=https://predict-server.testnet.mystenlabs.com

# Tunables
STARTING_BALANCE_DUSDC=1000000000   # 1,000 dUSDC (6 decimal base units)
SETTLEMENT_POLL_SECONDS=30
ORACLE_REGISTRY_REFRESH_SEC=120
MAX_POSITIONS_PER_USER=10
MAX_TRADES_PER_HOUR=10
COPY_MAX_LEADERS=3
```

# Appendix B — Message Templates

## Trade Preview

```text
Trade preview
{ASSET} {above|below} ${strike}
Expiry: {time} UTC (in {N} min) · Current {ASSET}: ${price}
Premium:           {premium} dUSDC
Max payout:       {notional} dUSDC
Net if correct:   +{net} dUSDC
Implied prob:       {prob}%
{AI context line — one sentence, max 15 words}
[Confirm ✓]   [Cancel ✗]
```

## Position Opened

```text
Position opened
{ASSET} {above|below} ${strike}
Expires: {time} UTC
Premium paid: {premium} dUSDC
Tx: {hash} ↗
[Check PnL]   [Share]   [Copy my trades]
```

## Settlement — Win

```text
You won!
{ASSET} settled at ${settlement_price}
Your call: {ASSET} {above|below} ${strike} ✓
Premium paid:      {premium} dUSDC
Payout:           {payout} dUSDC
Net profit:       +{net} dUSDC
Balance: {new_balance} dUSDC · Streak: {streak}
[Share win]   [Trade again]
```

## Settlement — Loss

```text
Position expired worthless
{ASSET} settled at ${settlement_price}
Your call: {ASSET} {above|below} ${strike} ✗
Premium lost: {premium} dUSDC
Balance: {new_balance} dUSDC
[Trade again]
```

## Shareable Trade Card

```text
━━━━━━━━━━━━━━━━━━━━━
Quick-Predict | {WIN / LOSS}
━━━━━━━━━━━━━━━━━━━━━
{ASSET} {above|below} ${strike} {✓|✗}
Settled at: ${settlement_price}
Net PnL: {+/-}{amount} dUSDC
Tx: {short_hash}
━━━━━━━━━━━━━━━━━━━━━
Trade at @QuickPredictBot
```

# Appendix C — Protocol Source Pointers

All source files are on the predict-testnet-4-16 branch of github.com/MystenLabs/deepbookv3. Read these before writing any PTB code.

| Area | File | What to Read |
| --- | --- | --- |
| predict::mint and redeem entry points | packages/predict/sources/predict.move | Exact function signatures, argument order, return types, and emitted events |
| PredictManager account model | packages/predict/sources/predict_manager.move | How positions are stored as MarketKey quantities; deposit and withdraw capabilities |
| Oracle state machine | packages/predict/sources/oracle.move | OracleSVI lifecycle states (Inactive/Active/Pending/Settled); how settlement price is frozen |
| Vault accounting | packages/predict/sources/vault/vault.move | max_total_exposure_pct enforcement; how PLP supply and withdrawal work |
| Registry and admin | packages/predict/sources/registry.move | Oracle creation; quote asset management; how oracle_id maps to underlying asset |

## Key MarketKey Structure

Binary positions are keyed by (oracle_id, expiry, strike, is_up). The is_up boolean distinguishes above/below at the same strike. Vertical ranges are keyed by (oracle_id, expiry, lower_strike, higher_strike) and pay when settlement lands in (lower, higher].

## Oracle Lifecycle States

| State | Condition | Bot Behaviour |
| --- | --- | --- |
| Inactive | Oracle exists but not yet activated | Do not show in /markets; do not accept trades |
| Active | Accepts live spot/forward/SVI updates before expiry | Show in /markets; accept /up, /down, /range |
| Pending settlement | Expiry reached; awaiting first post-expiry price push | Show as 'Settling...' in /status; do not accept new trades |
| Settled | First post-expiry price update received; settlement price frozen | Trigger keeper: call redeem_permissionless; send settlement DMs |
