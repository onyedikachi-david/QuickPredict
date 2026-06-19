import type { Context } from "../common/context";
import type {
  ForceReply,
  InlineKeyboardMarkup,
  InputRichMessage,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
} from "grammy/types";

export function richHtml(html: string): InputRichMessage {
  return { html };
}

type RichReplyOptions = {
  reply_markup?:
    | InlineKeyboardMarkup
    | ReplyKeyboardMarkup
    | ReplyKeyboardRemove
    | ForceReply;
};

type RichEditOptions = {
  reply_markup?: InlineKeyboardMarkup;
};

export function replyRich(
  ctx: Context,
  html: string,
  options?: RichReplyOptions
) {
  return ctx.replyWithRichMessage(richHtml(html), options);
}

export function editRich(
  ctx: Context,
  html: string,
  options?: RichEditOptions
) {
  return ctx.editMessageText(richHtml(html), options);
}

export function sendRich(
  ctx: Context,
  chatId: number | string,
  html: string,
  options?: RichReplyOptions
) {
  return ctx.api.sendRichMessage(chatId, richHtml(html), options);
}
