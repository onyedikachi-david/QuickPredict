<div align="center">

### Telegram-native trading interface for DeepBook Predict

One command to trade. Non-custodial by design.

[**QuickPredict**](https://github.com/onyedikachi/QuickPredict)

![Status](https://img.shields.io/badge/status-testnet-E8590C)
![Bot](https://img.shields.io/badge/bot-MIT-2F6FED)

</div>

## What Is QuickPredict?

QuickPredict is a Telegram bot that serves as a mobile-first trading interface
for **DeepBook Predict** — the institutional-grade on-chain binary options
protocol on Sui.

Users can discover markets, calculate option metrics (implied probability,
premium, net payouts), and execute real-time on-chain trades directly within
Telegram — all while maintaining full non-custodial ownership of their funds
through a secure, locally-encrypted wallet architecture.

## Problem

DeepBook Predict is technically superior to competing prediction markets —
sub-400ms settlement, institutional SVI pricing, composability with Margin and
Spot. Yet it has zero consumer-facing distribution. The friction between "I
think BTC is going up" and "I have a live on-chain position" requires a Sui
wallet, testnet tokens, and browser. This gates out most potential users.

## Solution

QuickPredict closes both gaps — bringing prediction markets to Telegram where
the audience already exists, while keeping funds non-custodial and trades
on-chain.

## Architecture

- **Non-Custodial Local Wallets (Model B)** — Users initialize their own Sui
  keypair with `/wallet create <password>`. Keypairs are encrypted with
  AES-256-GCM, derived via PBKDF2 (310,000 iterations + unique salt), stored in
  SQLite. Password prompts use Telegram ForceReply and are deleted instantly.
- **Onboarding Faucet Bridge** — New wallets receive 0.1 SUI (gas) and 1,000
  dUSDC (collateral) upon creation, funded from the testnet treasury.
- **WebSocket Event Streaming Keeper** — Subscribes to `oracle::OracleSettled`
  events and executes `redeem_permissionless` instantly on oracle updates, with
  active polling as fallback.
- **Pre-Trade Risk Control Guard** — Active checks against Predict registry and
  vault state prevent transactions exceeding exposure limits.
- **DeepSeek AI Context Client** — Enriches trade preview cards with concise
  market context analysis.

## Project Structure

- [`src/ai/`](./src/ai) — DeepSeek AI context client integration
- [`src/common/`](./src/common) — shared config, context, i18n, error handling
- [`src/db/`](./src/db) — Drizzle/SQLite database schema and migrations
- [`src/helpers/`](./src/helpers) — logger and helper utilities
- [`src/keeper/`](./src/keeper) — WebSocket-enabled settlement keeper
- [`src/middlewares/`](./src/middlewares) — session and logging middleware
- [`src/modules/`](./src/modules) — Telegram bot commands, callbacks, dialogs
- [`src/predict/`](./src/predict) — DeepBook Predict client APIs and risk queries
- [`src/sui/`](./src/sui) — cryptography, PBKDF2/AES wallet routines, PTB builders
- [`src/bootstrap.ts`](./src/bootstrap.ts) — bot and middleware registration
- [`src/index.ts`](./src/index.ts) — app startup entry point
- [`docs/prd.md`](./docs/prd.md) — Product Requirements Document

The app is a single long-running process (Telegram long-polling + 20s settlement
keeper) with a local SQLite file holding encrypted wallet keys.

## Requirements

- Bun `>=1.0`
- Docker with Compose (for production deployment)
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))

## Quick Start

```bash
cp .env.example .env
bun install
bunx drizzle-kit push
bun run dev
```

The bot starts polling for Telegram messages via long-polling (no public HTTP
needed).

Useful commands:

```bash
bun run dev              # start with live reload
bun run start            # production build
bun run typecheck        # TypeScript type checking
bun run db:generate      # generate Drizzle migrations
bun run db:migrate       # run database migrations
```

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `BOT_TOKEN` | Telegram Bot API token | Yes |
| `SUI_RPC_URL` | Sui RPC node URL (default: testnet) | No |
| `PREDICT_SERVER_URL` | Predict API server URL | No |
| `SPONSOR_PRIVATE_KEY` | Faucet treasury private key (testnet) | Yes |
| `DEEPSEEK_API_KEY` | DeepSeek API key for market context | No |
| `DEEPSEEK_MODEL` | DeepSeek model (default: `deepseek-v4-flash`) | No |

## Verification

```bash
bun test src/sui/wallets.test.ts   # verify cryptographic routines
bun run typecheck                   # TypeScript validation
```

### Manual Bot Interactions

1. `/wallet create mypassword` — create secure wallet, receive faucet credits
2. `/wallet balance` — verify 0.1 SUI + 1,000 dUSDC credited
3. `/markets` — browse active prediction markets
4. `/up BTC 85000 10 100` — submit a trade
5. Confirm → enter password → verify password deleted and transaction settles

## Deployment

QuickPredict is designed for a single instance with a persistent volume (one
Telegram poller per token, one SQLite writer). Serverless platforms do not fit
this architecture.

See [`DEPLOY.md`](./DEPLOY.md) for full deployment documentation.

### Fly.io (Testnet/Demo)

```bash
fly launch --no-deploy --copy-config --name <your-app-name>
fly volumes create data --size 1 --region fra
fly secrets set BOT_TOKEN=...
fly deploy --remote-only
```

### VPS with Docker Compose (Mainnet)

```bash
git clone <repo> && cd QuickPredict
cp .env.example .env  # fill: BOT_TOKEN, LITESTREAM_* (bucket + creds)
docker compose up -d --build
```

Backups use **Litestream** as a sidecar, streaming SQLite changes to S3/B2/R2.

## CI/CD

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| [`ci.yml`](./.github/workflows/ci.yml) | every PR | typecheck + Docker image build |
| [`deploy.yml`](./.github/workflows/deploy.yml) | push to `main` | typecheck → push image to GHCR → deploy to Fly |

## Production Checklist

- [ ] `BOT_TOKEN` set as a secret (never in repo/image)
- [ ] Volume mounted; `DB_PATH=/data/quick-predict.db`
- [ ] Backups streaming (Litestream) and restore drill performed
- [ ] Dedicated Sui RPC endpoint (`SUI_GRPC_URL`) — public nodes are rate-limited
- [ ] `NETWORK=testnet` until DeepBook Predict ships mainnet IDs
- [ ] Exactly one instance running (two pollers on one token = Telegram 409 errors)

## License

MIT
