# Quick-Predict

Quick-Predict is a Telegram-native trading interface for DeepBook Predict on Sui, built on a grammY foundation and guided by `docs/prd.md`.

## Product Direction

Quick-Predict lets Telegram users open, monitor, and settle binary prediction positions through chat commands without browser wallet setup.

The PRD target includes:

- **Oracle-agnostic market discovery**: live market support from the DeepBook Predict oracle registry.
- **Core trading commands**: `/up`, `/down`, `/range`, `/markets`, `/status`, and `/balance`.
- **Options-aware previews**: premium, max payout, net profit, and implied probability before confirmation.
- **Sui integration**: PTBs for `predict::mint` and `predict::redeem_permissionless`.
- **Social layer**: leaderboards, copy trading, share cards, and group tournaments.
- **Settlement keeper**: automated redemption and settlement notifications.

## Current Status

This project has been reset as a fresh Git repository using the grammY template branch as the starting point. Product implementation should proceed from the PRD.

## Documentation

- **PRD**: `docs/prd.md`
- **Original Word PRD**: `quick-predict-prd-final (1).docx`

## Setup

Install dependencies:

```bash
bun install
```

Create an environment file:

```bash
cp .env.example .env
```

Fill in `.env` with Telegram, Sui, DeepBook Predict, and optional Anthropic values.

Run in development:

```bash
bun run dev
```

Run in production:

```bash
bun run start
```

## Scripts

- **`bun run dev`**: start the bot with hot reload.
- **`bun run start`**: start the bot once.

## Project Structure

```text
src/
  common/       shared config, context, i18n, and error handling
  helpers/      logger and helper utilities
  middlewares/  session and logging middleware
  modules/      Telegram feature modules
  bootstrap.ts  bot setup
  index.ts      app entry point
docs/
  prd.md
```

## Next Implementation Targets

- **Configuration**: wire DeepBook Predict, Sui, dUSDC, and keeper environment variables into typed config.
- **Persistence**: add SQLite schema for users, positions, copy follows, tournaments, and group membership.
- **Predict API client**: implement oracle registry and pricing data access.
- **Sui integration**: implement PTB builders for mint and redeem flows.
- **Telegram commands**: implement the P0 flow from the PRD.
