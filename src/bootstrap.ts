import { Bot } from "grammy";
import { config } from "./common/config";
import { Context, createContextConstructor } from "./common/context";
import { homeModule } from "./modules/home/home.module";
import { tradingModule } from "./modules/trading/trading.module";
import { socialModule } from "./modules/social/social.module";
import { autoChatAction } from "@grammyjs/auto-chat-action";
import { hydrate } from "@grammyjs/hydrate";
import { i18n, isMultipleLocales } from "./common/i18n";
import { logger } from "./helpers/logger";
import { updateLoggingMiddleware } from "./middlewares/logging.middleware";
import { sequentialize } from '@grammyjs/runner'
import { unhandledModule } from "./modules/unhandled/unhandled.module";
import { languageModule } from "./modules/language/language.module";
import { sessionMiddleware } from "./middlewares/session.middleware";
import { errorHandler } from "./common/error";
import { initializeDatabase } from "./db/schema";

// Premium grammY plugins
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { limit } from "@grammyjs/ratelimiter";
import { conversations, createConversation } from "@grammyjs/conversations";
import { signTransactionConversation } from "./modules/trading/trading.service";
import { unlockWalletConversation, withdrawConversation, claimConversation, walletMenu } from "./modules/trading/wallet.service";
import { swapConversation } from "./modules/trading/swap.service";
import { tradeBuilderAssetMenu } from "./modules/trading/trade-builder.service";
import { marketsMenu, statusMenu } from "./modules/trading/trading-menu.service";
import { leaderboardMenu, copyboardMenu } from "./modules/social/social-menu.service";

export const initializeBot = () : Bot<Context> => {

  // Exit app if bot token not set
  if (!config.botToken) throw new Error("BOT_TOKEN is not defined");

  // Initialize database
  initializeDatabase();
  logger.info("Database initialized");

  // Initialize the bot
  const bot = new Bot<Context>(config.botToken, {
    ContextConstructor: createContextConstructor({ logger, config }),
  });

  // Outgoing API Throttling & Auto-Retry for Premium Web3 Resilience
  bot.api.config.use(autoRetry());
  bot.api.config.use(apiThrottler());

  // Global HTML parse mode configurations
  bot.api.config.use((prev, method, payload, signal) =>
    prev(method, { parse_mode: "HTML", ...payload }, signal)
  );
  
  const protectedBot = bot.errorBoundary(errorHandler)

  // Rate Limiting (limit to 3 requests per second per user to shield RPC/AI budgets)
  protectedBot.use(
    limit({
      timeFrame: 1000,
      limit: 3,
      onLimitExceeded: async (ctx) => {
        await ctx.reply("⚠️ Too many requests! Please slow down.");
      },
    })
  );

  // Use the middleware
  if (config.botMode === "polling") protectedBot.use(sequentialize((ctx) => ctx.chatId?.toString()))
  config.debug && protectedBot.use(updateLoggingMiddleware);
  protectedBot.use(autoChatAction(bot.api));
  protectedBot.use(hydrate());
  protectedBot.use(sessionMiddleware());
  protectedBot.use(i18n);

  // Register Conversation Wizards (Conversations must sit after Session middleware)
  protectedBot.use(conversations());
  protectedBot.use(createConversation(signTransactionConversation));
  protectedBot.use(createConversation(unlockWalletConversation));
  protectedBot.use(createConversation(withdrawConversation));
  protectedBot.use(createConversation(swapConversation));
  protectedBot.use(createConversation(claimConversation));

  // Register all interactive menus upstream of the modules so any handler — in
  // any module — can send them. A grammY menu throws "Cannot send menu …" if its
  // middleware hasn't run before the reply that sends it (e.g. the home-screen
  // buttons that call into the trading/social menus).
  protectedBot.use(walletMenu);
  protectedBot.use(tradeBuilderAssetMenu);
  protectedBot.use(marketsMenu);
  protectedBot.use(statusMenu);
  protectedBot.use(leaderboardMenu);
  protectedBot.use(copyboardMenu);

  // Add Modules
  protectedBot.use(homeModule);
  protectedBot.use(tradingModule);
  protectedBot.use(socialModule);
  if (isMultipleLocales) protectedBot.use(languageModule)
  protectedBot.use(unhandledModule);

  // Register commands for autocomplete menu in Telegram client
  bot.api.setMyCommands([
    { command: "start", description: "Start the bot & show overview" },
    { command: "wallet", description: "Manage Sui non-custodial wallet" },
    { command: "withdraw", description: "Withdraw SUI or dUSDC to an external address" },
    { command: "swap", description: "Swap between SUI and dUSDC using DeepBook V3" },
    { command: "claim", description: "Claim settled winnings to your wallet" },
    { command: "markets", description: "View active predict markets" },
    { command: "up", description: "Go long on an asset strike" },
    { command: "down", description: "Go short on an asset strike" },
    { command: "range", description: "Trade range options" },
    { command: "status", description: "Check your open option positions" },
    { command: "balance", description: "Check off-chain and on-chain balance" },
    { command: "account", description: "Full account overview (wallet, trading account, positions)" },
    { command: "leaderboard", description: "Show top performers leaderboard" },
    { command: "help", description: "Show help and commands list" },
  ]).catch(err => {
    logger.error({ err }, "Failed to set bot commands");
  });

  return bot;
  
};
