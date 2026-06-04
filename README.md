# ⚡ Quick-Predict: Telegram-Native Trading Interface for DeepBook Predict

Quick-Predict is a high-performance, non-custodial Telegram bot that serves as a mobile-first trading interface for **DeepBook Predict** — the institutional-grade on-chain binary options protocol on Sui.

By utilizing a secure, locally-encrypted wallet architecture (**Model B: Dynamic ForceReply Prompts**), Quick-Predict allows users to discover markets, calculate option metrics (implied probability, premium, net payouts), and execute real-time on-chain trades directly within Telegram.

---

## 🏗️ Core Architecture (Model B)

Quick-Predict is built from the ground up to solve the UX and security challenges of mobile prediction markets:

1. **Non-Custodial Local Wallets (Model B):**
   * Users initialize their own unique Sui keypair using `/wallet create <password>`.
   * Keypairs are locally encrypted using **AES-256-GCM** with a key derived via **PBKDF2** (310,000 iterations + unique random salt) and stored securely in SQLite.
   * During trade execution, the bot issues a Telegram `ForceReply` prompt requesting the password. The password message is intercepted, processed transiently in volatile RAM, and **instantly deleted** from the chat history using the Telegram API to prevent leakage.
2. **Onboarding Faucet Bridge:**
   * New wallets are automatically credited with **0.1 SUI** (for gas) and **1,000 dUSDC** (for option collateral) upon `/wallet create`, funded from the `SPONSOR_PRIVATE_KEY` testnet treasury.
   * This facilitates frictionless, zero-setup testing and evaluation.
3. **On-Chain & Off-Chain Ledger Reconciliation:**
   * `/balance` and `/wallet balance` query the Sui RPC directly. Off-chain SQLite cached balances are automatically synchronized to serve as live mirrors of on-chain state.
4. **WebSocket Event Streaming Keeper:**
   * Migrated from high-latency active polling to a persistent WebSocket subscription (`suiClient.subscribeEvent`) listening for `oracle::OracleSettled` logs from the Predict package.
   * The keeper settlements execute `redeem_permissionless` instantly upon oracle updates, with active polling retained only as a resilient fallback.
5. **Pre-Trade Risk Control Guard:**
   * Active checks against the Predict registry and vault state (`/vault/summary` and `/state`) prevent users from submitting transactions that exceed available vault exposure limits.
6. **DeepSeek AI Context Client:**
   * Integrates the DeepSeek API (OpenAI-compatible) inside `src/ai/context.ts` to enrich the pre-trade preview card with a concise, 15-word market context analysis.
   * Defaults to `deepseek-v4-flash` for low-latency responses; set `DEEPSEEK_MODEL=deepseek-v4-pro` to use the Pro model.

---

## 🛠️ Project Structure

```text
src/
  ai/           DeepSeek AI context client integration
  common/       shared config, context, i18n, and error handling
  db/           Drizzle/SQLite database schema and migrations
  helpers/      logger and helper utilities
  keeper/       WebSocket-enabled settlement keeper
  middlewares/  session and logging middleware
  modules/      Telegram bot commands, callback handlers, and dialogs
  predict/      DeepBook Predict client APIs and risk queries
  sui/          cryptography, PBKDF2/AES wallet routines, and Sui PTB transaction builders
  bootstrap.ts  bot and middleware registration
  index.ts      app startup entry point
docs/
  prd.md        Product Requirements Document
```

---

## 🚀 Quick Start

### 1. Prerequisites
Ensure you have [Bun](https://bun.sh) installed.

### 2. Installation
Install project dependencies:
```bash
bun install
```

### 3. Environment Setup
Configure your environment variables by copying `.env.example`:
```bash
cp .env.example .env
```

Edit `.env` to supply the following variables:
* `TELEGRAM_BOT_TOKEN`: Your Telegram Bot API token.
* `SUI_RPC_URL`: Sui RPC node URL (defaults to testnet `https://fullnode.testnet.sui.io`).
* `PREDICT_SERVER_URL`: The Predict API server URL (`https://predict-server.testnet.mystenlabs.com`).
* `SPONSOR_PRIVATE_KEY`: The bot's faucet treasury private key (must contain SUI and dUSDC).
* `DEEPSEEK_API_KEY`: DeepSeek API key for generating live market contexts.
* `DEEPSEEK_MODEL`: *(optional)* DeepSeek model to use. Defaults to `deepseek-v4-flash`; set to `deepseek-v4-pro` for higher-quality responses.

### 4. Database Setup & Migrations
Initialize the Drizzle SQLite database and run the schema migrations:
```bash
bunx drizzle-kit push
```

### 5. Running the Application
Start the development server with live reload:
```bash
bun run dev
```

Start the production build:
```bash
bun run start
```

---

## 🧪 Verification & Testing

### Cryptographic Routines
Verify that key generation, PBKDF2 derivation, and AES-256-GCM encryption/decryption are correct:
```bash
bun test src/sui/wallets.test.ts
```

### Manual BOT Interactions
1. Run `/wallet create mypassword` to create your secure wallet.
2. Confirm you receive a successful address generation, and check `/wallet balance` to verify that the onboarding faucet has automatically credited your wallet with `0.1 SUI` and `1,000 dUSDC`.
3. Browse active markets using `/markets`.
4. Submit a trade (e.g. `/up BTC 85000 10 100`).
5. Tap **[Confirm ✓]**, enter your password, and verify that the password message is immediately deleted and the transaction successfully settles on-chain.
