import { Context, MyConversation } from "../../common/context";
import { getOrCreateUser, syncUserBalanceWithOnchain } from "../../db/users";
import { getUserWallet, getUserManagerId } from "../../db/wallets";
import {
  getCoinBalance,
  getDusdcBalance,
  getDusdcDecimals,
  formatCoinAmount,
  selectCoins,
  getDusdcType,
  parseCoinAmount,
} from "../../sui/coins";
import {
  createEncryptedUserWallet,
  getUserWalletAddress,
  loadUserKeypair,
} from "../../sui/wallets";
import { Menu } from "@grammyjs/menu";
import { logger } from "../../helpers/logger";
import { InlineKeyboard } from "grammy";
import { getDatabase } from "../../db/schema";
import { Transaction } from "@mysten/sui/transactions";
import {
  executeUserTransaction,
  getExplorerTxLink,
} from "../../sui/transactions";
import {
  withdrawFromManager,
  claimSettledPositions,
  type ClaimPositionInput,
} from "../../sui/predict";
import { fetchManagerSummary } from "../../predict/client";
import { getNetworkConfig } from "../../config/network";
import {
  getClaimableSettledPositions,
  markPositionRedeemed,
} from "../../db/positions";
import { editRich, replyRich, richHtml } from "../../helpers/rich-message";

// Define help submenu
export const helpMenu = new Menu<Context>("wallet-help").back(
  "← Wallet",
  async (ctx) => {
    if (!ctx.from) return;
    const displayUser = ctx.from.username
      ? `@${ctx.from.username}`
      : ctx.from.first_name || "User";
    const text = await getWalletOverviewText(
      ctx.from.id.toString(),
      displayUser,
    );
    await editRich(ctx, text);
  },
);

export const walletMenu = new Menu<Context>("wallet-main")
  .text("🔄 Refresh", async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery({ text: "Refreshing…" });
    const displayUser = ctx.from.username
      ? `@${ctx.from.username}`
      : ctx.from.first_name || "User";
    const text = await getWalletOverviewText(
      ctx.from.id.toString(),
      displayUser,
    );
    await editRich(ctx, text);
  })
  .row()
  .text("🔑 Unlock", async (ctx) => {
    if (!ctx.from) return;
    const address = getUserWalletAddress(ctx.from.id.toString());
    if (!address) {
      await ctx.answerCallbackQuery({ text: "Create a wallet first." });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await ctx.deleteMessage();
    } catch (e) {}
    await ctx.conversation.enter("unlockWalletConversation");
  })
  .text("📤 Withdraw", async (ctx) => {
    if (!ctx.from) return;
    const address = getUserWalletAddress(ctx.from.id.toString());
    if (!address) {
      await ctx.answerCallbackQuery({ text: "Create a wallet first." });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await ctx.deleteMessage();
    } catch (e) {}
    await ctx.conversation.enter("withdrawConversation");
  })
  .row()
  .text("🔄 Swap", async (ctx) => {
    if (!ctx.from) return;
    const address = getUserWalletAddress(ctx.from.id.toString());
    if (!address) {
      await ctx.answerCallbackQuery({ text: "Create a wallet first." });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await ctx.deleteMessage();
    } catch (e) {}
    await ctx.conversation.enter("swapConversation");
  })
  .row()
  .text("🎁 Claim", async (ctx) => {
    if (!ctx.from) return;
    if (!getUserManagerId(ctx.from.id.toString())) {
      await ctx.answerCallbackQuery({
        text: "No trading account yet — place a trade first.",
      });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await ctx.deleteMessage();
    } catch (e) {}
    await ctx.conversation.enter("claimConversation");
  })
  .submenu("❓ Security", "wallet-help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editRich(
      ctx,
      `<h1>Wallet Security</h1>` +
        `<p>Non-custodial. Only you hold the keys. Your private key is encrypted with AES-256-GCM, and the key to unlock it is derived from your password with PBKDF2.</p>` +
        `<h2>Keep Your Password Safe</h2>` +
        `<ul>` +
        `<li>The bot never stores your password.</li>` +
        `<li>No transaction can be signed without it.</li>` +
        `<li>If you lose it, it cannot be recovered.</li>` +
        `<li>To trade, send SUI for gas and dUSDC collateral to your deposit address.</li>` +
        `</ul>`,
    );
  });

// Register submenu
walletMenu.register(helpMenu);

// Helper to render main wallet page contents dynamically
async function getWalletOverviewText(
  telegramId: string,
  displayUser: string,
): Promise<string> {
  const wallet = getUserWallet(telegramId);
  if (!wallet) {
    return (
      `<h1>Wallet</h1>` +
      `<p>You do not have a wallet yet. Once you make one, only you hold the keys.</p>` +
      `<p>Create one with <code>/wallet create your-password</code>.</p>` +
      `<blockquote>Use at least 8 characters and keep it safe. It signs every transaction and cannot be recovered.</blockquote>`
    );
  }

  try {
    await syncUserBalanceWithOnchain(telegramId);
  } catch (e) {
    logger.warn({ error: e }, "Failed to sync user balance during menu render");
  }

  let suiBalance = "unavailable";
  let dusdcBalance = "unavailable";

  try {
    const suiBal = await getCoinBalance(wallet.sui_address, "0x2::sui::SUI");
    suiBalance = `${formatCoinAmount(suiBal, 9)} SUI`;
  } catch (e) {
    logger.warn({ error: e }, "Failed to fetch SUI balance for menu");
  }

  try {
    const dusdcBal = await getDusdcBalance(wallet.sui_address);
    dusdcBalance = `${formatCoinAmount(dusdcBal, getDusdcDecimals())} dUSDC`;
  } catch (e) {
    logger.warn({ error: e }, "Failed to fetch dUSDC balance for menu");
  }

  return (
    `<h1>Wallet</h1>` +
    `<p><code>${displayUser}</code></p>` +
    `<h2>Deposit Address</h2>` +
    `<pre>${wallet.sui_address}</pre>` +
    `<h2>Balances</h2>` +
    `<ul>` +
    `<li>Gas <code>${suiBalance}</code></li>` +
    `<li>Collateral <code>${dusdcBalance}</code></li>` +
    `</ul>` +
    `<blockquote>Non-custodial. Every action needs your password to sign.</blockquote>`
  );
}

export async function unlockWalletConversation(
  conversation: MyConversation,
  ctx: Context,
) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();
  // DB read before the wait → wrap in external so replays reuse the cached value.
  const address = await conversation.external(() =>
    getUserWalletAddress(telegramId),
  );
  if (!address) {
    await replyRich(
      ctx,
      `<h1>No Wallet</h1><p>Create a wallet first with <code>/wallet create your-password</code>.</p>`,
    );
    return;
  }

  // Ask for password
  const promptMsg = await replyRich(
    ctx,
    `<h1>Enter Password</h1>` +
      `<p>This checks that your password decrypts your wallet.</p>` +
      `<p><i>Your password message is deleted right after you send it.</i></p>`,
    {
      reply_markup: { force_reply: true, selective: true },
    },
  );

  // Wait for response
  const responseCtx = await conversation.waitFor("message:text");
  const password = responseCtx.message.text.trim();
  if (password.toLowerCase() === "cancel" || password === "/cancel") {
    await replyRich(responseCtx, `<p>Unlock cancelled.</p>`);
    return;
  }
  if (password.startsWith("/")) {
    await replyRich(
      responseCtx,
      `<p>Unlock cancelled. Run the command again when ready.</p>`,
    );
    return;
  }

  // Clean up password message from Telegram chat history
  try {
    await responseCtx.api.deleteMessage(
      responseCtx.chat.id,
      responseCtx.message.message_id,
    );
  } catch (e) {
    logger.warn({ error: e }, "Failed to delete user password message");
  }

  // Delete the prompt message too to keep the chat clean
  try {
    await responseCtx.api.deleteMessage(
      responseCtx.chat.id,
      promptMsg.message_id,
    );
  } catch (e) {}

  try {
    // Attempt decryption
    loadUserKeypair(telegramId, password);
    await replyRich(
      responseCtx,
      `<h1>Wallet Unlocked</h1><p>Signer <code>${address}</code></p>`,
    );
  } catch (error) {
    await replyRich(
      responseCtx,
      `<h1>Could Not Unlock Wallet</h1><pre>${error instanceof Error ? error.message : "Invalid password"}</pre><p>Check your password and try again.</p>`,
    );
  }
}

export async function withdrawConversation(
  conversation: MyConversation,
  ctx: Context,
) {
  if (!ctx.from) return;
  const telegramId = ctx.from.id.toString();
  // DB read before the wait → wrap in external so replays reuse the cached value.
  const address = await conversation.external(() =>
    getUserWalletAddress(telegramId),
  );
  if (!address) {
    await replyRich(
      ctx,
      `<h1>No Wallet</h1><p>Create a wallet first with <code>/wallet create your-password</code>.</p>`,
    );
    return;
  }

  // 1. Ask for token (SUI or dUSDC)
  const tokenKeyboard = new InlineKeyboard()
    .text("SUI", "withdraw_asset_SUI")
    .text("dUSDC", "withdraw_asset_dUSDC")
    .row()
    .text("✗ Cancel", "withdraw_cancel");

  const assetPrompt = await replyRich(
    ctx,
    `<h1>Withdraw</h1><p>Pick a token to send.</p>`,
    { reply_markup: tokenKeyboard },
  );

  const assetCallback = await conversation.waitForCallbackQuery([
    "withdraw_asset_SUI",
    "withdraw_asset_dUSDC",
    "withdraw_cancel",
  ]);

  await assetCallback.answerCallbackQuery();
  if (assetCallback.callbackQuery.data === "withdraw_cancel") {
    try {
      await assetCallback.api.deleteMessage(
        assetCallback.chat!.id,
        assetPrompt.message_id,
      );
    } catch (e) {}
    await replyRich(assetCallback, `<p>Withdrawal cancelled.</p>`);
    return;
  }

  const token =
    assetCallback.callbackQuery.data === "withdraw_asset_SUI" ? "SUI" : "dUSDC";
  try {
    await assetCallback.api.deleteMessage(
      assetCallback.chat!.id,
      assetPrompt.message_id,
    );
  } catch (e) {}

  // 2. Ask for destination address
  const addrPrompt = await replyRich(
    ctx,
    `<h1>Withdraw ${token}</h1><p>Reply with the destination Sui address (starts with <code>0x</code>).</p>`,
  );

  let destAddress = "";
  while (true) {
    const addrCtx = await conversation.waitFor("message:text");
    const val = addrCtx.message.text.trim();
    if (val.toLowerCase() === "cancel" || val === "/cancel") {
      await replyRich(addrCtx, `<p>Withdrawal cancelled.</p>`);
      return;
    }
    if (val.startsWith("/")) {
      await replyRich(
        addrCtx,
        `<p>Withdrawal cancelled. Run the command again when ready.</p>`,
      );
      return;
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(val)) {
      destAddress = val;
      break;
    }
    await replyRich(
      addrCtx,
      `<p>That isn't a valid Sui address. It should be 66 characters starting with <code>0x</code>.</p>`,
    );
  }

  // Delete previous prompt
  try {
    await ctx.api.deleteMessage(ctx.chat!.id, addrPrompt.message_id);
  } catch (e) {}

  // Fetch available balance — a network read BETWEEN waits, so it must run inside
  // conversation.external: otherwise it re-fires on every replay and the balance
  // used to validate the amount could drift. bigint isn't JSON-serializable, so
  // persist it as a string via beforeStore/afterLoad.
  const rawBalance = await conversation.external({
    task: () =>
      token === "SUI"
        ? getCoinBalance(address, "0x2::sui::SUI")
        : getDusdcBalance(address),
    beforeStore: (v: bigint) => v.toString(),
    afterLoad: (s: string) => BigInt(s),
  });
  const formattedBalance = formatCoinAmount(
    rawBalance,
    token === "SUI" ? 9 : getDusdcDecimals(),
  );

  // 3. Ask for amount
  const amountPrompt = await replyRich(
    ctx,
    `<h1>Withdraw ${token}</h1>` +
      `<p>To <code>${destAddress}</code></p>` +
      `<p>Available <code>${formattedBalance} ${token}</code></p>` +
      `<p>Reply with the amount to send.</p>`,
  );

  let amountStr = "";
  let amountBase = 0n;
  while (true) {
    const amountCtx = await conversation.waitFor("message:text");
    const val = amountCtx.message.text.trim();
    if (val.toLowerCase() === "cancel" || val === "/cancel") {
      await replyRich(amountCtx, `<p>Withdrawal cancelled.</p>`);
      return;
    }
    if (val.startsWith("/")) {
      await replyRich(
        amountCtx,
        `<p>Withdrawal cancelled. Run the command again when ready.</p>`,
      );
      return;
    }
    const num = parseFloat(val);
    if (!isNaN(num) && num > 0) {
      const decimals = token === "SUI" ? 9 : getDusdcDecimals();
      try {
        amountBase = parseCoinAmount(val, decimals);
        if (amountBase <= rawBalance) {
          if (token === "SUI" && amountBase === rawBalance) {
            await replyRich(
              amountCtx,
              `<p>⚠️ Keep some SUI for gas — you can't withdraw your full SUI balance. Enter a lower amount.</p>`,
            );
            continue;
          }
          amountStr = val;
          break;
        } else {
          await replyRich(
            amountCtx,
            `<p>Not enough ${token} — you have <code>${formattedBalance} ${token}</code>. Enter a lower amount.</p>`,
          );
        }
      } catch (e) {
        await replyRich(
          amountCtx,
          `<p>That amount isn't valid. Enter a number.</p>`,
        );
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

  // 4. Ask for password (ForceReply)
  const passPrompt = await replyRich(
    ctx,
    `<h1>Enter Password to Sign</h1>` +
      `<p>Send <code>${amountStr} ${token}</code> to <code>${destAddress}</code>.</p>` +
      `<p><i>Your password message is deleted right after you send it.</i></p>`,
    {
      reply_markup: { force_reply: true, selective: true },
    },
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
    await replyRich(passCtx, `<p>Withdrawal cancelled.</p>`);
    return;
  }
  if (password.startsWith("/")) {
    try {
      await passCtx.api.deleteMessage(passCtx.chat.id, passPrompt.message_id);
    } catch (e) {}
    await replyRich(
      passCtx,
      `<p>Withdrawal cancelled. Run the command again when ready.</p>`,
    );
    return;
  }

  // Delete pass prompt
  try {
    await passCtx.api.deleteMessage(passCtx.chat.id, passPrompt.message_id);
  } catch (e) {}

  const loadingMsg = await replyRich(
    passCtx,
    `<p>⏳ <i>Unlocking your wallet and sending the transaction…</i></p>`,
  );

  try {
    const tx = new Transaction();
    tx.setSender(address);

    if (token === "SUI") {
      const [suiCoin] = tx.splitCoins(tx.gas, [amountBase]);
      tx.transferObjects([suiCoin], destAddress);
    } else {
      const dusdcType = getDusdcType();
      const coinIds = await selectCoins(address, dusdcType, amountBase);
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
      const [paymentCoin] = tx.splitCoins(coinArg, [amountBase]);
      tx.transferObjects([paymentCoin], destAddress);
    }

    const result = await executeUserTransaction(telegramId, password, tx);

    if (result.success && result.digest) {
      const db = getDatabase();
      const now = Date.now();

      // Log the withdrawal as a bot-action record (the authoritative balance is
      // re-read from chain by syncUserBalanceWithOnchain below).
      db.prepare(
        `INSERT INTO transactions (telegram_id, type, amount, description, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        telegramId,
        "withdraw",
        -parseFloat(amountStr),
        `${token} Withdrawal to ${destAddress.slice(0, 8)}...`,
        now,
      );

      await syncUserBalanceWithOnchain(telegramId);

      await passCtx.api.editMessageText(
        passCtx.chat.id,
        loadingMsg.message_id,
        richHtml(
          `<h1>Withdrawal Sent</h1>` +
            `<ul>` +
            `<li>Sent <code>${amountStr} ${token}</code></li>` +
            `<li>To <code>${destAddress}</code></li>` +
            `<li>Tx <a href="${getExplorerTxLink(result.digest)}">${result.digest.slice(0, 8)}...${result.digest.slice(-4)}</a></li>` +
            `</ul>`,
        ),
      );
    } else {
      await passCtx.api.editMessageText(
        passCtx.chat.id,
        loadingMsg.message_id,
        richHtml(
          `<h1>Withdrawal Failed</h1><pre>${result.error || "Unknown error"}</pre>`,
        ),
      );
    }
  } catch (error) {
    logger.error({ error }, "Withdrawal failed");
    await passCtx.api.editMessageText(
      passCtx.chat.id,
      loadingMsg.message_id,
      richHtml(
        `<h1>Withdrawal Failed</h1><pre>${error instanceof Error ? error.message : String(error)}</pre>`,
      ),
    );
  }
}

export async function withdrawCommand(ctx: Context) {
  if (!ctx.from) return;
  const address = getUserWalletAddress(ctx.from.id.toString());
  if (!address) {
    return replyRich(
      ctx,
      `<h1>No Wallet</h1><p>Create a wallet first with <code>/wallet create your-password</code>.</p>`,
    );
  }
  return ctx.conversation.enter("withdrawConversation");
}

/**
 * Claim realized winnings: withdraw the user's on-chain Trading Account
 * (PredictManager) dUSDC balance back to their wallet. Settled binary winners
 * are auto-redeemed into the manager by the settlement keeper; this realizes
 * that balance into the spendable wallet.
 */
export async function claimConversation(
  conversation: MyConversation,
  ctx: Context,
) {
  if (!ctx.from) return;
  const telegramId = ctx.from.id.toString();

  // Gather claim state up front in ONE external block: it mixes a DB read with a
  // NETWORK call (manager summary) that would otherwise re-fire on every replay,
  // possibly with a different balance. Caching it keeps the amount shown to the
  // user consistent with what actually gets redeemed.
  const claimState = await conversation.external(async () => {
    const mId = getUserManagerId(telegramId);
    if (!mId) return null;
    // Settled winnings the keeper couldn't auto-redeem (ranges, or a failed binary
    // auto-redeem) still need an owner-signed redeem; the rest already sits in the
    // manager balance.
    const pendingPositions = getClaimableSettledPositions(telegramId);
    const summary = await fetchManagerSummary(mId);
    const currentBalance = summary?.trading_balance ?? 0;
    // Each settled winner pays its notional ($1 x qty) on redeem.
    const payout = pendingPositions.reduce(
      (sum, p) => sum + p.notional_dusdc,
      0,
    );
    return {
      managerId: mId,
      pending: pendingPositions,
      totalBase: currentBalance + payout,
    };
  });

  if (!claimState) {
    await replyRich(
      ctx,
      `<h1>No Trading Account</h1><p>No trading account yet — place a trade with /up or /down first.</p>`,
    );
    return;
  }
  const { managerId, pending, totalBase } = claimState;

  if (totalBase <= 0) {
    await replyRich(
      ctx,
      `<h1>Claim</h1>` +
        `<p>Nothing to claim right now.</p>` +
        `<p><i>Winning positions become claimable here once they settle.</i></p>`,
    );
    return;
  }

  const totalStr = formatCoinAmount(BigInt(totalBase), getDusdcDecimals());

  const passPrompt = await replyRich(
    ctx,
    `<h1>Enter Password to Sign</h1>` +
      `<p>Claim <code>${totalStr} dUSDC</code> to your wallet.</p>` +
      (pending.length > 0
        ? `<p>Redeems ${pending.length} settled position${pending.length === 1 ? "" : "s"} and moves your trading account balance to your wallet.</p>`
        : `<p>Moves your trading account balance to your wallet.</p>`) +
      `<p><i>Your password message is deleted right after you send it.</i></p>`,
    {
      reply_markup: { force_reply: true, selective: true },
    },
  );

  const passCtx = await conversation.waitFor("message:text");
  const password = passCtx.message.text.trim();

  try {
    await passCtx.api.deleteMessage(
      passCtx.chat.id,
      passCtx.message.message_id,
    );
  } catch (e) {
    logger.warn({ error: e }, "Failed to delete user password message");
  }

  if (password.toLowerCase() === "cancel" || password.startsWith("/")) {
    try {
      await passCtx.api.deleteMessage(passCtx.chat.id, passPrompt.message_id);
    } catch (e) {}
    await replyRich(passCtx, `<p>Claim cancelled.</p>`);
    return;
  }

  try {
    await passCtx.api.deleteMessage(passCtx.chat.id, passPrompt.message_id);
  } catch (e) {}

  const loadingMsg = await replyRich(
    passCtx,
    `<p>⏳ <i>Unlocking your wallet and claiming ${totalStr} dUSDC…</i></p>`,
  );

  try {
    let result;
    if (pending.length > 0) {
      result = await claimSettledPositions({
        telegramId,
        password,
        managerObjectId: managerId,
        withdrawAmountBase: BigInt(totalBase),
        positions: pending.map(
          (p): ClaimPositionInput =>
            p.position_type === "range"
              ? {
                  kind: "range",
                  oracleId: p.oracle_id,
                  expiryMs: p.expiry_ts,
                  quantityBase: p.notional_dusdc,
                  lowerStrikeDollars: p.lower_strike ?? p.strike,
                  upperStrikeDollars: p.upper_strike ?? p.strike,
                }
              : {
                  kind: "binary",
                  oracleId: p.oracle_id,
                  expiryMs: p.expiry_ts,
                  quantityBase: p.notional_dusdc,
                  strikeDollars: p.strike,
                  isUp: Boolean(p.is_up),
                },
        ),
      });
    } else {
      result = await withdrawFromManager({
        telegramId,
        password,
        managerObjectId: managerId,
        amountBase: BigInt(totalBase),
      });
    }

    if (result.success && result.digest) {
      if (pending.length > 0) {
        for (const p of pending) markPositionRedeemed(p.internal_id);
      }
      await syncUserBalanceWithOnchain(telegramId);
      await passCtx.api.editMessageText(
        passCtx.chat.id,
        loadingMsg.message_id,
        richHtml(
          `<h1>Claimed</h1>` +
            `<ul>` +
            `<li>Moved <code>${totalStr} dUSDC</code> to your wallet.</li>` +
            `<li>Tx <a href="${getExplorerTxLink(result.digest)}">${result.digest.slice(0, 8)}...${result.digest.slice(-4)}</a></li>` +
            `</ul>`,
        ),
      );
    } else {
      await passCtx.api.editMessageText(
        passCtx.chat.id,
        loadingMsg.message_id,
        richHtml(
          `<h1>Claim Failed</h1><pre>${result.error || "Unknown error"}</pre>`,
        ),
      );
    }
  } catch (error) {
    logger.error({ error, telegramId }, "Claim failed");
    await passCtx.api.editMessageText(
      passCtx.chat.id,
      loadingMsg.message_id,
      richHtml(
        `<h1>Claim Failed</h1><pre>${error instanceof Error ? error.message : String(error)}</pre>`,
      ),
    );
  }
}

export async function claimCommand(ctx: Context) {
  if (!ctx.from) return;
  if (!getUserManagerId(ctx.from.id.toString())) {
    return replyRich(
      ctx,
      `<h1>No Trading Account</h1><p>No trading account yet — place a trade with /up or /down first.</p>`,
    );
  }
  return ctx.conversation.enter("claimConversation");
}

function parseWalletArgs(ctx: Context): string[] {
  return ctx.message?.text?.trim().split(/\s+/).slice(1) || [];
}

export async function walletCommand(ctx: Context) {
  if (!ctx.from) return;

  const user = getOrCreateUser(ctx.from.id.toString(), ctx.from.username);
  const args = parseWalletArgs(ctx);
  const action = args[0]?.toLowerCase();

  if (!action) {
    const address = getUserWalletAddress(user.telegram_id);

    if (!address) {
      return replyRich(
        ctx,
        `<h1>Wallet</h1>` +
          `<p>You do not have a wallet yet. Once you make one, only you hold the keys.</p>` +
          `<p>Create one with <code>/wallet create your-password</code>.</p>` +
          `<blockquote>Use at least 8 characters and keep it safe. It signs every transaction and cannot be recovered.</blockquote>`,
      );
    }

    const displayUser = ctx.from.username
      ? `@${ctx.from.username}`
      : ctx.from.first_name || "User";
    const text = await getWalletOverviewText(user.telegram_id, displayUser);
    return replyRich(ctx, text, {
      reply_markup: walletMenu,
    });
  }

  if (action === "create") {
    return createWalletCommand(ctx, args.slice(1));
  }

  if (action === "address") {
    return walletAddressCommand(ctx);
  }

  if (action === "balance") {
    return walletBalanceCommand(ctx);
  }

  if (action === "unlock") {
    return walletUnlockCommand(ctx, args.slice(1));
  }

  return replyRich(
    ctx,
    `<h1>Wallet Commands</h1>` +
      `<p>That is not a wallet command.</p>` +
      `<ul>` +
      `<li><code>/wallet create &lt;password&gt;</code></li>` +
      `<li><code>/wallet address</code></li>` +
      `<li><code>/wallet balance</code></li>` +
      `<li><code>/wallet unlock &lt;password&gt;</code></li>` +
      `</ul>`,
  );
}

async function createWalletCommand(ctx: Context, args: string[]) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();
  const password = args.join(" ");

  if (!password) {
    return replyRich(
      ctx,
      `<h1>Create Wallet</h1>` +
        `<p>Usage: <code>/wallet create your-password</code></p>` +
        `<blockquote>Use at least 8 characters. Do not reuse an important password.</blockquote>`,
    );
  }

  try {
    const wallet = createEncryptedUserWallet(telegramId, password);

    const net = getNetworkConfig().network;
    const gasHint =
      net === "mainnet"
        ? "for gas"
        : "for gas (grab some from the public Sui testnet faucet)";
    return replyRich(
      ctx,
      `<h1>Wallet Created</h1>` +
        `<p>Only you hold the keys.</p>` +
        `<h2>Deposit Address</h2>` +
        `<pre>${wallet.address}</pre>` +
        `<h2>Fund This Wallet on Sui ${net}</h2>` +
        `<ul>` +
        `<li>SUI - ${gasHint}</li>` +
        `<li>dUSDC - your trading collateral</li>` +
        `</ul>` +
        `<p>Then check it with /balance.</p>` +
        `<blockquote>Keep your password safe. It signs every transaction and cannot be recovered.</blockquote>`,
    );
  } catch (error) {
    return replyRich(
      ctx,
      `<h1>Could Not Create Wallet</h1><pre>${error instanceof Error ? error.message : "Failed to create wallet"}</pre>`,
    );
  }
}

async function walletAddressCommand(ctx: Context) {
  if (!ctx.from) return;

  const wallet = getUserWallet(ctx.from.id.toString());

  if (!wallet) {
    return replyRich(
      ctx,
      `<h1>No Wallet</h1><p>Create one with <code>/wallet create your-password</code>.</p>`,
    );
  }

  return replyRich(
    ctx,
    `<h1>Deposit Address</h1>` +
      `<pre>${wallet.sui_address}</pre>` +
      `<p>Send SUI for gas and dUSDC for trading to this address.</p>`,
  );
}

async function walletBalanceCommand(ctx: Context) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();
  const wallet = getUserWallet(telegramId);

  if (!wallet) {
    return replyRich(
      ctx,
      `<h1>No Wallet</h1><p>Create one with <code>/wallet create your-password</code>.</p>`,
    );
  }

  try {
    await syncUserBalanceWithOnchain(telegramId);

    const [suiResult, dusdcResult] = await Promise.allSettled([
      getCoinBalance(wallet.sui_address, "0x2::sui::SUI"),
      getDusdcBalance(wallet.sui_address),
    ]);
    const suiBalance =
      suiResult.status === "fulfilled"
        ? formatCoinAmount(suiResult.value, 9)
        : "unavailable";
    const dusdcBalance =
      dusdcResult.status === "fulfilled"
        ? formatCoinAmount(dusdcResult.value, getDusdcDecimals())
        : "unavailable";

    const warning =
      suiResult.status === "rejected" || dusdcResult.status === "rejected"
        ? `\n\n⚠️ Some balances couldn't be fetched from Sui RPC.`
        : "";

    if (suiResult.status === "rejected" || dusdcResult.status === "rejected") {
      ctx.logger.warn(
        {
          suiError:
            suiResult.status === "rejected" ? suiResult.reason : undefined,
          dusdcError:
            dusdcResult.status === "rejected" ? dusdcResult.reason : undefined,
        },
        "Fetched partial wallet balance",
      );
    }

    return replyRich(
      ctx,
      `<h1>Balance</h1>` +
        `<h2>Address</h2>` +
        `<pre>${wallet.sui_address}</pre>` +
        `<ul>` +
        `<li>Gas <code>${suiBalance}</code> SUI</li>` +
        `<li>Collateral <code>${dusdcBalance}</code> dUSDC</li>` +
        `</ul>` +
        (warning
          ? `<blockquote>Some balances could not be fetched from Sui RPC.</blockquote>`
          : ""),
    );
  } catch (error) {
    ctx.logger.error({ error }, "Failed to fetch wallet balance");
    return replyRich(
      ctx,
      `<h1>Balance Error</h1><p>Couldn't fetch your on-chain balance. Try again in a moment.</p>`,
    );
  }
}

async function walletUnlockCommand(ctx: Context, args: string[]) {
  if (!ctx.from) return;

  const password = args.join(" ");

  if (!password) {
    return replyRich(
      ctx,
      `<h1>Unlock Wallet</h1><p>Usage: <code>/wallet unlock your-password</code></p>`,
    );
  }

  try {
    const keypair = loadUserKeypair(ctx.from.id.toString(), password);
    const address = keypair.getPublicKey().toSuiAddress();

    return replyRich(
      ctx,
      `<h1>Wallet Unlocked</h1><p>Signer <code>${address}</code></p>`,
    );
  } catch (error) {
    return replyRich(
      ctx,
      `<h1>Could Not Unlock Wallet</h1><pre>${error instanceof Error ? error.message : "Failed to unlock wallet"}</pre>`,
    );
  }
}
