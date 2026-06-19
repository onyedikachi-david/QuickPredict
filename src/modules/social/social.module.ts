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
import { replyRich } from "../../helpers/rich-message";

const composer = new Composer<Context>();

// Menus (leaderboard, copyboard) are registered upstream in bootstrap.

// Social commands
composer.command(
  "leaderboard",
  handleLogMiddleware("leaderboard-command"),
  chatAction("typing"),
  leaderboardCommand,
);

composer.command(
  "groupleaderboard",
  handleLogMiddleware("groupleaderboard-command"),
  chatAction("typing"),
  groupLeaderboardCommand,
);

composer.command(
  "copy",
  handleLogMiddleware("copy-command"),
  chatAction("typing"),
  copyCommand,
);

composer.command(
  "uncopy",
  handleLogMiddleware("uncopy-command"),
  chatAction("typing"),
  uncopyCommand,
);

composer.command(
  "copyboard",
  handleLogMiddleware("copyboard-command"),
  chatAction("typing"),
  copyboardCommand,
);

composer.command(
  "tournament",
  handleLogMiddleware("tournament-command"),
  chatAction("typing"),
  tournamentCommand,
);

composer.command(
  "share",
  handleLogMiddleware("share-command"),
  chatAction("typing"),
  shareCommand,
);

// Callback handlers for copy trading
composer.callbackQuery("cmd_copy_me", async (ctx) => {
  await ctx.answerCallbackQuery();
  return replyRich(
    ctx,
    `<h1>Copy Trading</h1>` +
      `<p>Share your username with others so they can copy your trades:</p>` +
      `<p><code>/copy @${ctx.from?.username || "your_username"}</code></p>` +
      `<p>See /copyboard for top traders.</p>`,
  );
});

composer.callbackQuery(/^share_/, async (ctx) => {
  await ctx.answerCallbackQuery();
  return shareCommand(ctx);
});

composer.callbackQuery("cmd_markets", async (ctx) => {
  await ctx.answerCallbackQuery();
  return replyRich(ctx, `<p>Use /markets to view all active markets</p>`);
});

export { composer as socialModule };
