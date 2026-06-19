import { Context } from "../../common/context";
import { replyRich } from "../../helpers/rich-message";

export function unhandledMessages(ctx: Context) {
  return replyRich(ctx, `<p>${ctx.t("unhandled")}</p>`);
}

export function unhandledCallbackQueries(ctx: Context) {
  return ctx.answerCallbackQuery();
}
