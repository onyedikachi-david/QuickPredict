# Deploying QuickPredict

The app is a **single long-running process** (Telegram long-polling + the 20s
settlement keeper) with a **local SQLite file** that holds users' *encrypted
wallet keys*. That dictates everything below:

- exactly **one instance** (one Telegram poller per token; one SQLite writer)
- a **persistent volume** for the DB
- **continuous backups** — losing the DB loses users' wallets. Non-negotiable.
- serverless (Vercel/Workers/Lambda) does not fit; don't try.

CI/CD is GitHub Actions:

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | every PR | typecheck + prove the Docker image builds |
| `deploy.yml` | push to `main` | typecheck → push image to GHCR → deploy to Fly (if `FLY_API_TOKEN` is set, else skips cleanly) |

---

## Path A — Fly.io (recommended now: testnet/demo)

One-time setup:

```sh
fly launch --no-deploy --copy-config --name <your-app-name>   # uses ./fly.toml
fly volumes create data --size 1 --region fra                  # SQLite volume
fly secrets set BOT_TOKEN=...                                  # + any other secrets
fly deploy --remote-only                                       # first deploy, from your machine
```

Wire up CI/CD (after the first deploy works):

```sh
fly tokens create deploy
```

Save the output as the **`FLY_API_TOKEN`** repo secret on GitHub
(Settings → Secrets and variables → Actions). From then on every push to
`main` deploys automatically.

Notes:
- `fly.toml` has **no `[[services]]`** — the app is a worker (polling), no
  public HTTP. Don't add one unless you switch to webhook mode.
- Non-secret env (NETWORK, DB_PATH, …) lives in `[env]` in `fly.toml`;
  secrets via `fly secrets set`.
- Backups on Fly: volumes get daily snapshots (5-day retention) — fine for
  testnet. **Before mainnet, add Litestream** (Path B's backup layer) or move
  to Path B entirely.

## Path B — VPS with Docker Compose (recommended for mainnet)

Any small VPS (Hetzner CX22-class). Once Docker is installed:

```sh
git clone <repo> && cd QuickPredict
cp .env.example .env        # fill: BOT_TOKEN, LITESTREAM_* (bucket + creds)
docker compose up -d --build
```

Or run the image CI already published instead of building on the box:

```sh
IMAGE=ghcr.io/<owner>/quickpredict:latest docker compose up -d
```

Backups are **Litestream**, running as a sidecar (`litestream.yml`): it streams
every SQLite change to an S3-compatible bucket (S3 / Backblaze B2 / Cloudflare
R2). Set in `.env`:

- `LITESTREAM_REPLICA_URL` — e.g. `s3://quickpredict-backups/db`
- `LITESTREAM_ACCESS_KEY_ID` / `LITESTREAM_SECRET_ACCESS_KEY`
- non-AWS buckets also need `endpoint:` uncommented in `litestream.yml`

**Run the restore drill before trusting it with real funds:**

```sh
docker compose run --rm litestream \
  restore -config /etc/litestream.yml -o /data/restored.db /data/quick-predict.db
```

A backup you've never restored is a hope, not a backup.

Auto-update on push (optional): add [Watchtower](https://containrrr.dev/watchtower/)
or a tiny cron `docker compose pull && docker compose up -d` — CI already pushes
`ghcr.io/<owner>/quickpredict:latest` on every merge to main.

---

## Production checklist

- [ ] `BOT_TOKEN` set as a secret (never in the repo / image)
- [ ] Volume mounted; `DB_PATH=/data/quick-predict.db`
- [ ] Backups streaming (Litestream) **and restore drill performed**
- [ ] Dedicated Sui RPC endpoint (`SUI_GRPC_URL`) — the public
      `fullnode.testnet.sui.io` is rate-limited and not for production traffic
      (QuickNode / Ankr / BlockVision all offer Sui testnet gRPC)
- [ ] `NETWORK=testnet` until DeepBook Predict ships mainnet IDs (the config
      seam fails fast on a half-configured mainnet — that's intentional)
- [ ] Trade fee: set `TRADE_FEE_BPS` + `TREASURY_ADDRESS` only when you mean to
      charge it (defaults off)
- [ ] Exactly **one** instance running (kill old pollers before starting new —
      two pollers on one token = Telegram 409 errors)
