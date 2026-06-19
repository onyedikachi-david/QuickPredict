import { createCallbackData } from "callback-data";
import { Context } from "../../common/context";
import { createChangeLanguageKeyboard } from "./language.keyboard";
import { i18n } from "../../common/i18n";
import { editRich, replyRich } from "../../helpers/rich-message";

export const changeLanguageData = createCallbackData("language", {
  code: String,
});

export async function selectLanguageCommand(ctx: Context) {
  return replyRich(ctx, `<p>${ctx.t("language-select")}</p>`, {
    reply_markup: await createChangeLanguageKeyboard(ctx),
  });
}

export async function changeLanguage(ctx: Context) {
  if (!ctx.callbackQuery?.data) return;

  const { code: languageCode } = changeLanguageData.unpack(
    ctx.callbackQuery.data,
  );

  if (i18n.locales.includes(languageCode)) {
    await ctx.i18n.setLocale(languageCode);

    return editRich(
      ctx,
      `<p>${ctx.t("language-changed")}</p>`,
      { reply_markup: await createChangeLanguageKeyboard(ctx) },
    );
  }
}
