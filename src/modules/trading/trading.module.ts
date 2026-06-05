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
  accountCommand,
  rangeCommand,
  confirmTradeCallback,
  cancelTradeCallback,
  confirmCopyCallback,
  skipCopyCallback,
} from "./trading.service";
import { walletCommand, withdrawCommand, claimCommand } from "./wallet.service";
import { swapCommand } from "./swap.service";

const composer = new Composer<Context>();

// Menus are registered upstream in bootstrap (before all modules) so any handler
// can send them — see the menu block in src/bootstrap.ts.

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
  "account",
  handleLogMiddleware("account-command"),
  chatAction("typing"),
  accountCommand
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

composer.command(
  "claim",
  handleLogMiddleware("claim-command"),
  chatAction("typing"),
  claimCommand
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

composer.callbackQuery("cmd_claim", async (ctx) => {
  await ctx.answerCallbackQuery();
  return claimCommand(ctx);
});

export { composer as tradingModule };
