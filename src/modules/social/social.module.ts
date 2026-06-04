import { Composer } from "grammy";
import { Context } from "../../common/context";
import { chatAction } from "@grammyjs/auto-chat-action";
import { handleLogMiddleware } from "../../middlewares/logging.middleware";
import {
  leaderboardCommand,
  groupLeaderboardCommand,
  copyCommand,
  uncopyCommand,
  copyboardCommand,
  tournamentCommand,
  shareCommand,
} from "./social.service";
import { leaderboardMenu, copyboardMenu } from "./social-menu.service";

const composer = new Composer<Context>();

composer.use(leaderboardMenu);
composer.use(copyboardMenu);

// Social commands
composer.command(
  "leaderboard",
  handleLogMiddleware("leaderboard-command"),
  chatAction("typing"),
  leaderboardCommand
);

composer.command(
  "groupleaderboard",
  handleLogMiddleware("groupleaderboard-command"),
  chatAction("typing"),
  groupLeaderboardCommand
);

composer.command(
  "copy",
  handleLogMiddleware("copy-command"),
  chatAction("typing"),
  copyCommand
);

composer.command(
  "uncopy",
  handleLogMiddleware("uncopy-command"),
  chatAction("typing"),
  uncopyCommand
);

composer.command(
  "copyboard",
  handleLogMiddleware("copyboard-command"),
  chatAction("typing"),
  copyboardCommand
);

composer.command(
  "tournament",
  handleLogMiddleware("tournament-command"),
  chatAction("typing"),
  tournamentCommand
);

composer.command(
  "share",
  handleLogMiddleware("share-command"),
  chatAction("typing"),
  shareCommand
);

// Callback handlers for copy trading
composer.callbackQuery("cmd_copy_me", async (ctx) => {
  await ctx.answerCallbackQuery();
  return ctx.reply(
    `👥 <b>Copy Trading</b>\n\n` +
      `Share your username with others so they can copy your trades:\n\n` +
      `<code>/copy @${ctx.from?.username || "your_username"}</code>\n\n` +
      `See /copyboard for top traders.`
  );
});

composer.callbackQuery(/^share_/, async (ctx) => {
  await ctx.answerCallbackQuery();
  return shareCommand(ctx);
});

composer.callbackQuery("cmd_markets", async (ctx) => {
  await ctx.answerCallbackQuery();
  return ctx.reply("Use /markets to view all active markets");
});

export { composer as socialModule };
