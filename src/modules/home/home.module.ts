import { Composer } from "grammy";
import { Context } from "../../common/context";
import { chatAction } from "@grammyjs/auto-chat-action";
import { handleLogMiddleware } from "../../middlewares/logging.middleware";
import { startCommand, helpCommand } from "./home.service";
import { marketsCommand, balanceCommand, accountCommand } from "../trading/trading.service";
import { leaderboardCommand } from "../social/social.service";

const composer = new Composer<Context>();
const module = composer.chatType("private");

module.command("start", handleLogMiddleware("start-command"), chatAction("typing"), startCommand);
module.command("help", handleLogMiddleware("help-command"), chatAction("typing"), helpCommand);

// Callback handlers for quick actions
composer.callbackQuery("cmd_markets", async (ctx) => {
  await ctx.answerCallbackQuery();
  return marketsCommand(ctx);
});

composer.callbackQuery("cmd_balance", async (ctx) => {
  await ctx.answerCallbackQuery();
  return balanceCommand(ctx);
});

composer.callbackQuery("cmd_leaderboard", async (ctx) => {
  await ctx.answerCallbackQuery();
  return leaderboardCommand(ctx);
});

composer.callbackQuery("cmd_help", async (ctx) => {
  await ctx.answerCallbackQuery();
  return helpCommand(ctx);
});

composer.callbackQuery("cmd_account", async (ctx) => {
  await ctx.answerCallbackQuery();
  return accountCommand(ctx);
});

export { composer as homeModule };
