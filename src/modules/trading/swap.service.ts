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
import { replyRich } from "../../helpers/rich-message";

export async function swapConversation(
  conversation: MyConversation,
  ctx: Context,
) {
  if (!ctx.from) return;
  const telegramId = ctx.from.id.toString();
  // DB read before the wait → wrap in external so replays reuse the cached value.
  const address = await conversation.external(() => getUserWalletAddress(telegramId));
  if (!address) {
    await replyRich(ctx, `<h1>No Wallet</h1><p>Create one with <code>/wallet create your-password</code>.</p>`);
    return;
  }

  // 1. Ask for swap direction
  const directionKeyboard = new InlineKeyboard()
    .text("SUI → dUSDC", "swap_dir_SUI_dUSDC")
    .text("dUSDC → SUI", "swap_dir_dUSDC_SUI")
    .row()
    .text("✗ Cancel", "swap_cancel");

  const dirPrompt = await replyRich(
    ctx,
    `<h1>Swap</h1><p>Pick a direction.</p>`,
    { reply_markup: directionKeyboard },
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
    await replyRich(dirCallback, `<p>Swap cancelled.</p>`);
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

  // Fetch balances — network reads BETWEEN waits, so they must run inside
  // conversation.external (else they re-fire on every replay). bigints aren't
  // JSON-serializable, so pass them out as strings.
  const { rawSui, rawDusdc } = await conversation.external(async () => {
    const s = await getCoinBalance(address, "0x2::sui::SUI");
    const d = await getDusdcBalance(address);
    return { rawSui: s.toString(), rawDusdc: d.toString() };
  });
  const rawSuiBalance = BigInt(rawSui);
  const rawDusdcBalance = BigInt(rawDusdc);
  const formattedSuiBalance = formatCoinAmount(rawSuiBalance, 9);
  const formattedDusdcBalance = formatCoinAmount(rawDusdcBalance, getDusdcDecimals());

  const availableBalanceStr = isSuiToDusdc
    ? formattedSuiBalance
    : formattedDusdcBalance;
  const availableBalanceRaw = isSuiToDusdc ? rawSuiBalance : rawDusdcBalance;

  // 2. Ask for amount
  const amountPrompt = await replyRich(
    ctx,
    `<h1>Swap ${fromToken} to ${toToken}</h1>` +
      `<p>Available <code>${availableBalanceStr} ${fromToken}</code></p>` +
      `<p>Reply with the amount of ${fromToken} to swap, or type <code>cancel</code>.</p>`,
  );

  let amountStr = "";
  let amountBase = 0n;

  while (true) {
    const amountCtx = await conversation.waitFor("message:text");
    const val = amountCtx.message.text.trim();
    if (val.toLowerCase() === "cancel" || val === "/cancel") {
      await replyRich(amountCtx, `<p>Swap cancelled.</p>`);
      return;
    }
    if (val.startsWith("/")) {
      await replyRich(
        amountCtx,
        `<p>Swap cancelled. Run the command again when ready.</p>`,
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
            await replyRich(
              amountCtx,
              `<h1>Keep Gas Available</h1>` +
                `<p>Keep at least <code>0.2 SUI</code> for gas. You can swap up to <code>${formatCoinAmount(availableBalanceRaw - 200_000_000n, 9)} SUI</code>.</p>` +
                `<p>Enter a lower amount.</p>`,
            );
            continue;
          }
          amountStr = val;
          break;
        } else {
          await replyRich(
            amountCtx,
            `<h1>Not Enough ${fromToken}</h1><p>You have <code>${availableBalanceStr} ${fromToken}</code>. Enter a lower amount.</p>`,
          );
        }
      } catch (e) {
        await replyRich(amountCtx, `<p>That amount isn't valid. Enter a number.</p>`);
      }
    } else {
      await replyRich(
        amountCtx,
        `<p>That amount isn't valid. Enter a positive number.</p>`,
      );
    }
  }

  // Delete previous prompt
  try {
    await ctx.api.deleteMessage(ctx.chat!.id, amountPrompt.message_id);
  } catch (e) {}

  // 3. Simulate Swap to show estimate and rate
  const simMsg = await replyRich(ctx, `<p><i>Estimating swap output...</i></p>`);

  const cfg = getNetworkConfig();
  const network = cfg.network;
  const isMainnet = network === "mainnet";
  const poolKey = cfg.deepbook.suiUsdcPoolKey;

  // The DeepBook quote is a NETWORK call between waits — wrap it so it doesn't
  // re-fire on every replay (which could shift the slippage floor). minOutBase is
  // a bigint, so pass it out as a string.
  const { simulatedOut, minOutBaseStr } = await conversation.external(async () => {
    try {
      const dbClient = new DeepBookClient({ client: getRpcClient(), address, network });
      if (isSuiToDusdc) {
        const estimate = await dbClient.getQuoteQuantityOut(poolKey, parseFloat(amountStr));
        const qd = getDusdcDecimals();
        return {
          simulatedOut: estimate.quoteOut,
          minOutBaseStr: parseCoinAmount((estimate.quoteOut * 0.99).toFixed(qd), qd).toString(),
        };
      }
      const estimate = await dbClient.getBaseQuantityOut(poolKey, parseFloat(amountStr));
      return {
        simulatedOut: estimate.baseOut,
        minOutBaseStr: parseCoinAmount((estimate.baseOut * 0.99).toFixed(9), 9).toString(),
      };
    } catch (err) {
      logger.warn({ err, amountStr, fromToken }, "Failed to simulate DeepBook swap output");
      return { simulatedOut: 0, minOutBaseStr: "0" };
    }
  });
  const minOutBase = BigInt(minOutBaseStr);

  try {
    await ctx.api.deleteMessage(ctx.chat!.id, simMsg.message_id);
  } catch (e) {}

  // 4. Request Password to execute
  const rateInfo =
    simulatedOut > 0
      ? `<ul>` +
        `<li>Estimated out <code>${simulatedOut.toFixed(4)} ${toToken}</code></li>` +
        `<li>Rate <code>1 ${fromToken} ≈ ${(simulatedOut / parseFloat(amountStr)).toFixed(4)} ${toToken}</code></li>` +
        `</ul>`
      : `<blockquote>Could not estimate output. The swap will run without slippage protection.</blockquote>`;

  const passPrompt = await replyRich(
    ctx,
    `<h1>Enter Password to Sign</h1>` +
      `<p>Swap <code>${amountStr} ${fromToken}</code> to ${toToken}</p>` +
      rateInfo +
      `<p><i>Your password message is deleted right after you send it.</i></p>`,
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
    await replyRich(passCtx, `<p>Swap cancelled.</p>`);
    return;
  }
  if (password.startsWith("/")) {
    try {
      await passCtx.api.deleteMessage(passCtx.chat.id, passPrompt.message_id);
    } catch (e) {}
    await replyRich(
      passCtx,
      `<p>Swap cancelled. Run the command again when ready.</p>`,
    );
    return;
  }

  // Delete pass prompt
  try {
    await passCtx.api.deleteMessage(passCtx.chat.id, passPrompt.message_id);
  } catch (e) {}

  const loadingMsg = await replyRich(passCtx, `<p><i>Unlocking your wallet and preparing the swap...</i></p>`);

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
      await replyRich(
        passCtx,
        `<h1>Swap Complete</h1>` +
          `<ul>` +
          `<li>Swapped <code>${amountStr} ${fromToken}</code> to ${toToken}</li>` +
          `<li>Tx <a href="${explorerLink}">${result.digest.slice(0, 8)}...${result.digest.slice(-4)}</a></li>` +
          `</ul>`,
      );
    } else {
      await replyRich(passCtx, `<h1>Swap Failed</h1><pre>${result.error || "Unknown error"}</pre>`);
    }
  } catch (error) {
    try {
      await passCtx.api.deleteMessage(passCtx.chat.id, loadingMsg.message_id);
    } catch (e) {}

    logger.error({ error, telegramId }, "Swap execution crashed");
    await replyRich(passCtx, `<h1>Swap Failed</h1><pre>${error instanceof Error ? error.message : String(error)}</pre>`);
  }
}

export async function swapCommand(ctx: Context) {
  if (!ctx.from) return;
  const address = getUserWalletAddress(ctx.from.id.toString());
  if (!address) {
    await replyRich(ctx, `<h1>No Wallet</h1><p>Create one with <code>/wallet create your-password</code>.</p>`);
    return;
  }
  await ctx.conversation.enter("swapConversation");
}
