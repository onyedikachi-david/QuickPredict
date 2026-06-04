import { Composer } from "grammy";
import { Context } from "../../common/context";
import { chatAction } from "@grammyjs/auto-chat-action";
import { handleLogMiddleware } from "../../middlewares/logging.middleware";
import {
  upCommand,
  downCommand,
  marketsCommand,
  statusCommand,
  balanceCommand,
  rangeCommand,
  confirmTradeCallback,
  cancelTradeCallback,
  confirmCopyCallback,
  skipCopyCallback,
} from "./trading.service";
import { walletCommand, walletMenu, withdrawCommand } from "./wallet.service";
import { swapCommand } from "./swap.service";
import { tradeBuilderAssetMenu } from "./trade-builder.service";
import { marketsMenu, statusMenu } from "./trading-menu.service";

const composer = new Composer<Context>();

// Register wallet and trade builder menu middlewares before commands
composer.use(walletMenu);
composer.use(tradeBuilderAssetMenu);
composer.use(marketsMenu);
composer.use(statusMenu);

// Trading commands
composer.command(
  "up",
  handleLogMiddleware("up-command"),
  chatAction("typing"),
  upCommand
);

composer.command(
  "down",
  handleLogMiddleware("down-command"),
  chatAction("typing"),
  downCommand
);

composer.command(
  "markets",
  handleLogMiddleware("markets-command"),
  chatAction("typing"),
  marketsCommand
);

composer.command(
  "status",
  handleLogMiddleware("status-command"),
  chatAction("typing"),
  statusCommand
);

composer.command(
  "balance",
  handleLogMiddleware("balance-command"),
  chatAction("typing"),
  balanceCommand
);

composer.command(
  "range",
  handleLogMiddleware("range-command"),
  chatAction("typing"),
  rangeCommand
);

composer.command(
  "wallet",
  handleLogMiddleware("wallet-command"),
  chatAction("typing"),
  walletCommand
);

composer.command(
  "withdraw",
  handleLogMiddleware("withdraw-command"),
  chatAction("typing"),
  withdrawCommand
);

composer.command(
  "swap",
  handleLogMiddleware("swap-command"),
  chatAction("typing"),
  swapCommand
);

// Callback handlers
composer.callbackQuery(/^confirm_trade_/, confirmTradeCallback);
composer.callbackQuery(/^cancel_trade_/, cancelTradeCallback);
composer.callbackQuery(/^copy_confirm_/, confirmCopyCallback);
composer.callbackQuery(/^copy_skip_/, skipCopyCallback);

// Quick action callbacks
composer.callbackQuery("cmd_status", async (ctx) => {
  await ctx.answerCallbackQuery();
  return statusCommand(ctx);
});

export { composer as tradingModule };
