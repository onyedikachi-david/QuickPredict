import { Context, MyConversation } from "../../common/context";
import { getUserWalletAddress } from "../../sui/wallets";
import { getNetworkConfig } from "../../config/network";
import { getRpcClient } from "../../sui/client";
import {
  getCoinBalance,
  getDusdcBalance,
  getDusdcDecimals,
  formatCoinAmount,
  parseCoinAmount,
  selectCoins,
} from "../../sui/coins";
import { syncUserBalanceWithOnchain } from "../../db/users";
import { InlineKeyboard } from "grammy";
import { Transaction } from "@mysten/sui/transactions";
import {
  DeepBookClient,
  testnetCoins,
  mainnetCoins,
} from "@mysten/deepbook-v3";
import {
  executeUserTransaction,
  getExplorerTxLink,
} from "../../sui/transactions";
import { logger } from "../../helpers/logger";
import { getDatabase } from "../../db/schema";

export async function swapConversation(
  conversation: MyConversation,
  ctx: Context,
) {
  if (!ctx.from) return;
  const telegramId = ctx.from.id.toString();
  const address = getUserWalletAddress(telegramId);
  if (!address) {
    await ctx.reply("Create a wallet first with <code>/wallet create your-password</code>.");
    return;
  }

  // 1. Ask for swap direction
  const directionKeyboard = new InlineKeyboard()
    .text("SUI → dUSDC", "swap_dir_SUI_dUSDC")
    .text("dUSDC → SUI", "swap_dir_dUSDC_SUI")
    .row()
    .text("✗ Cancel", "swap_cancel");

  const dirPrompt = await ctx.reply(
    `🔄 <b>Swap</b>\n\n` +
      `Pick a direction.`,
    { parse_mode: "HTML", reply_markup: directionKeyboard },
  );

  const dirCallback = await conversation.waitForCallbackQuery([
    "swap_dir_SUI_dUSDC",
    "swap_dir_dUSDC_SUI",
    "swap_cancel",
  ]);

  await dirCallback.answerCallbackQuery();
  if (dirCallback.callbackQuery.data === "swap_cancel") {
    try {
      await dirCallback.api.deleteMessage(
        dirCallback.chat!.id,
        dirPrompt.message_id,
      );
    } catch (e) {}
    await dirCallback.reply("Swap cancelled.");
    return;
  }

  const isSuiToDusdc = dirCallback.callbackQuery.data === "swap_dir_SUI_dUSDC";
  const fromToken = isSuiToDusdc ? "SUI" : "dUSDC";
  const toToken = isSuiToDusdc ? "dUSDC" : "SUI";

  try {
    await dirCallback.api.deleteMessage(
      dirCallback.chat!.id,
      dirPrompt.message_id,
    );
  } catch (e) {}

  // Fetch balances
  const rawSuiBalance = await getCoinBalance(address, "0x2::sui::SUI");
  const formattedSuiBalance = formatCoinAmount(rawSuiBalance, 9);

  const rawDusdcBalance = await getDusdcBalance(address);
  const formattedDusdcBalance = formatCoinAmount(
    rawDusdcBalance,
    getDusdcDecimals(),
  );

  const availableBalanceStr = isSuiToDusdc
    ? formattedSuiBalance
    : formattedDusdcBalance;
  const availableBalanceRaw = isSuiToDusdc ? rawSuiBalance : rawDusdcBalance;

  // 2. Ask for amount
  const amountPrompt = await ctx.reply(
    `🔄 <b>Swap ${fromToken} → ${toToken}</b>\n\n` +
      `Available <code>${availableBalanceStr} ${fromToken}</code>\n\n` +
      `Reply with the amount of ${fromToken} to swap, or type <code>cancel</code>.`,
    { parse_mode: "HTML" },
  );

  let amountStr = "";
  let amountBase = 0n;
  let simulatedOut = 0;
  let minOutBase = 0n;

  while (true) {
    const amountCtx = await conversation.waitFor("message:text");
    const val = amountCtx.message.text.trim();
    if (val.toLowerCase() === "cancel" || val === "/cancel") {
      await amountCtx.reply("Swap cancelled.");
      return;
    }
    if (val.startsWith("/")) {
      await amountCtx.reply(
        "Swap cancelled. Run the command again when ready.",
      );
      return;
    }

    const num = parseFloat(val);
    if (!isNaN(num) && num > 0) {
      const decimals = isSuiToDusdc ? 9 : getDusdcDecimals();
      try {
        amountBase = parseCoinAmount(val, decimals);
        if (amountBase <= availableBalanceRaw) {
          // If SUI -> dUSDC, ensure we leave at least 0.2 SUI for gas fees
          if (isSuiToDusdc && availableBalanceRaw - amountBase < 200_000_000n) {
            await amountCtx.reply(
              `⚠️ Keep at least <code>0.2 SUI</code> for gas. ` +
                `You can swap up to <code>${formatCoinAmount(availableBalanceRaw - 200_000_000n, 9)} SUI</code>. ` +
                `Enter a lower amount.`,
            );
            continue;
          }
          amountStr = val;
          break;
        } else {
          await amountCtx.reply(
            `Not enough ${fromToken} — you have <code>${availableBalanceStr} ${fromToken}</code>. ` +
              `Enter a lower amount.`,
          );
        }
      } catch (e) {
        await amountCtx.reply(
          "That amount isn't valid. Enter a number.",
        );
      }
    } else {
      await amountCtx.reply(
        "That amount isn't valid. Enter a positive number.",
      );
    }
  }

  // Delete previous prompt
  try {
    await ctx.api.deleteMessage(ctx.chat!.id, amountPrompt.message_id);
  } catch (e) {}

  // 3. Simulate Swap to show estimate and rate
  const simMsg = await ctx.reply(
    "⏳ <i>Estimating swap output…</i>",
    { parse_mode: "HTML" },
  );

  const cfg = getNetworkConfig();
  const network = cfg.network;
  const isMainnet = network === "mainnet";
  const poolKey = cfg.deepbook.suiUsdcPoolKey;

  try {
    const suiClient = getRpcClient();
    const dbClient = new DeepBookClient({
      client: suiClient,
      address,
      network,
    });

    if (isSuiToDusdc) {
      const estimate = await dbClient.getQuoteQuantityOut(
        poolKey,
        parseFloat(amountStr),
      );
      simulatedOut = estimate.quoteOut;
      // Convert standard units back to base units for slippage protection (1% slippage)
      const quoteDecimals = getDusdcDecimals();
      minOutBase = parseCoinAmount(
        (simulatedOut * 0.99).toFixed(quoteDecimals),
        quoteDecimals,
      );
    } else {
      const estimate = await dbClient.getBaseQuantityOut(
        poolKey,
        parseFloat(amountStr),
      );
      simulatedOut = estimate.baseOut;
      // Convert SUI units back to base units for slippage protection (1% slippage)
      minOutBase = parseCoinAmount((simulatedOut * 0.99).toFixed(9), 9);
    }
  } catch (err) {
    logger.warn(
      { err, amountStr, fromToken },
      "Failed to simulate DeepBook swap output",
    );
    // Fallback to 0 min out if simulation fails (e.g. due to pool initialization or indexer issues)
    simulatedOut = 0;
    minOutBase = 0n;
  }

  try {
    await ctx.api.deleteMessage(ctx.chat!.id, simMsg.message_id);
  } catch (e) {}

  // 4. Request Password to execute
  const rateInfo =
    simulatedOut > 0
      ? `• Estimated out <code>${simulatedOut.toFixed(4)} ${toToken}</code>\n` +
        `• Rate <code>1 ${fromToken} ≈ ${(simulatedOut / parseFloat(amountStr)).toFixed(4)} ${toToken}</code>\n\n`
      : `⚠️ Couldn't estimate output — the swap will run without slippage protection.\n\n`;

  const passPrompt = await ctx.reply(
    `🔑 <b>Enter your password to sign</b>\n\n` +
      `Swap <code>${amountStr} ${fromToken}</code> → ${toToken}\n` +
      rateInfo +
      `<i>Your password message is deleted right after you send it.</i>`,
    { parse_mode: "HTML" },
  );

  const passCtx = await conversation.waitFor("message:text");
  const password = passCtx.message.text.trim();

  // Clean up password message from Telegram chat history
  try {
    await passCtx.api.deleteMessage(
      passCtx.chat.id,
      passCtx.message.message_id,
    );
  } catch (e) {
    logger.warn({ error: e }, "Failed to delete user password message");
  }

  if (password.toLowerCase() === "cancel" || password === "/cancel") {
    try {
      await passCtx.api.deleteMessage(passCtx.chat.id, passPrompt.message_id);
    } catch (e) {}
    await passCtx.reply("Swap cancelled.");
    return;
  }
  if (password.startsWith("/")) {
    try {
      await passCtx.api.deleteMessage(passCtx.chat.id, passPrompt.message_id);
    } catch (e) {}
    await passCtx.reply("Swap cancelled. Run the command again when ready.");
    return;
  }

  // Delete pass prompt
  try {
    await passCtx.api.deleteMessage(passCtx.chat.id, passPrompt.message_id);
  } catch (e) {}

  const loadingMsg = await passCtx.reply(
    `⏳ <i>Unlocking your wallet and preparing the swap…</i>`,
    { parse_mode: "HTML" },
  );

  try {
    const suiClient = getRpcClient();
    const dbClient = new DeepBookClient({
      client: suiClient,
      address,
      network,
    });

    const tx = new Transaction();
    tx.setSender(address);

    const decimalsOut = isSuiToDusdc ? getDusdcDecimals() : 9;
    const minOutFloat = parseFloat(formatCoinAmount(minOutBase, decimalsOut));

    if (isSuiToDusdc) {
      // SUI -> dUSDC
      const [suiCoinToSwap] = tx.splitCoins(tx.gas, [amountBase]);

      const swapFn = dbClient.deepBook.swapExactBaseForQuote({
        poolKey,
        amount: parseFloat(amountStr),
        deepAmount: 0,
        minOut: minOutFloat,
        baseCoin: suiCoinToSwap,
      });

      const [baseCoinResult, quoteCoinResult, deepCoinResult] = swapFn(tx);

      // Return swapped and leftover objects to user
      tx.transferObjects(
        [baseCoinResult, quoteCoinResult, deepCoinResult],
        tx.pure.address(address),
      );
    } else {
      // dUSDC -> SUI
      const quoteCoinType = isMainnet
        ? mainnetCoins.USDC.type
        : testnetCoins.DBUSDC.type;

      const coinIds = await selectCoins(address, quoteCoinType, amountBase);
      let coinArg;
      if (coinIds.length === 1) {
        coinArg = tx.object(coinIds[0]);
      } else {
        const [primaryCoin, ...coinsToMerge] = coinIds;
        coinArg = tx.object(primaryCoin);
        if (coinsToMerge.length > 0) {
          tx.mergeCoins(
            coinArg,
            coinsToMerge.map((id) => tx.object(id)),
          );
        }
      }

      const [quoteCoinToSwap] = tx.splitCoins(coinArg, [amountBase]);

      const swapFn = dbClient.deepBook.swapExactQuoteForBase({
        poolKey,
        amount: parseFloat(amountStr),
        deepAmount: 0,
        minOut: minOutFloat,
        quoteCoin: quoteCoinToSwap,
      });

      const [baseCoinResult, quoteCoinResult, deepCoinResult] = swapFn(tx);

      // Return swapped and leftover objects to user
      tx.transferObjects(
        [baseCoinResult, quoteCoinResult, deepCoinResult],
        tx.pure.address(address),
      );
    }

    const result = await executeUserTransaction(telegramId, password, tx);

    try {
      await passCtx.api.deleteMessage(passCtx.chat.id, loadingMsg.message_id);
    } catch (e) {}

    if (result.success && result.digest) {
      // Swap succeeded! Reconcile local database balances asynchronously
      syncUserBalanceWithOnchain(telegramId).catch((err) => {
        logger.error(
          { err, telegramId },
          "Failed to reconcile balance after swap",
        );
      });

      const explorerLink = getExplorerTxLink(result.digest);
      await passCtx.reply(
        `✅ <b>Swap complete</b>\n\n` +
          `Swapped <code>${amountStr} ${fromToken}</code> → ${toToken}\n` +
          `Tx <a href="${explorerLink}">${result.digest.slice(0, 8)}…${result.digest.slice(-4)}</a>`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      );
    } else {
      await passCtx.reply(
        `❌ <b>Swap failed</b>\n\n` +
          `<code>${result.error || "Unknown error"}</code>`,
        { parse_mode: "HTML" },
      );
    }
  } catch (error) {
    try {
      await passCtx.api.deleteMessage(passCtx.chat.id, loadingMsg.message_id);
    } catch (e) {}

    logger.error({ error, telegramId }, "Swap execution crashed");
    await passCtx.reply(
      `❌ <b>Swap failed</b>\n\n` +
        `<code>${error instanceof Error ? error.message : String(error)}</code>`,
      { parse_mode: "HTML" },
    );
  }
}

export async function swapCommand(ctx: Context) {
  if (!ctx.from) return;
  const address = getUserWalletAddress(ctx.from.id.toString());
  if (!address) {
    await ctx.reply("Create a wallet first with <code>/wallet create your-password</code>.");
    return;
  }
  await ctx.conversation.enter("swapConversation");
}
