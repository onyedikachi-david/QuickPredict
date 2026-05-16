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
} from "./trading.service";

const composer = new Composer<Context>();

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

// Callback handlers
composer.callbackQuery(/^confirm_trade_/, confirmTradeCallback);
composer.callbackQuery(/^cancel_trade_/, cancelTradeCallback);

// Quick action callbacks
composer.callbackQuery("cmd_status", async (ctx) => {
  await ctx.answerCallbackQuery();
  return statusCommand(ctx);
});

export { composer as tradingModule };
