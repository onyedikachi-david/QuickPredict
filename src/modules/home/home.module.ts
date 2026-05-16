import { Composer } from "grammy";
import { Context } from "../../common/context";
import { chatAction } from "@grammyjs/auto-chat-action";
import { handleLogMiddleware } from "../../middlewares/logging.middleware";
import { startCommand } from "./home.service";

const composer = new Composer<Context>();
const module = composer.chatType("private");

module.command("start", handleLogMiddleware("start-command"), chatAction("typing"), startCommand);
module.command("help", handleLogMiddleware("help-command"), chatAction("typing"), startCommand);

// Callback handlers for quick actions
composer.callbackQuery("cmd_markets", async (ctx) => {
  await ctx.answerCallbackQuery();
  return ctx.reply("Use /markets to view all active markets");
});

composer.callbackQuery("cmd_balance", async (ctx) => {
  await ctx.answerCallbackQuery();
  return ctx.reply("Use /balance to view your balance");
});

composer.callbackQuery("cmd_leaderboard", async (ctx) => {
  await ctx.answerCallbackQuery();
  return ctx.reply("Use /leaderboard to view top traders");
});

composer.callbackQuery("cmd_help", async (ctx) => {
  await ctx.answerCallbackQuery();
  return startCommand(ctx);
});

export { composer as homeModule };
