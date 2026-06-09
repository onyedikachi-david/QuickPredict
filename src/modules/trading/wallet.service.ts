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
import { executeUserTransaction, getExplorerTxLink } from "../../sui/transactions";
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

// Define help submenu
export const helpMenu = new Menu<Context>("wallet-help")
  .back("← Wallet", async (ctx) => {
    if (!ctx.from) return;
    const displayUser = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || "User");
    const text = await getWalletOverviewText(ctx.from.id.toString(), displayUser);
    await ctx.editMessageText(text);
  });

export const walletMenu = new Menu<Context>("wallet-main")
  .text("🔄 Refresh", async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery({ text: "Refreshing…" });
    const displayUser = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || "User");
    const text = await getWalletOverviewText(ctx.from.id.toString(), displayUser);
    await ctx.editMessageText(text);
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
      await ctx.answerCallbackQuery({ text: "No trading account yet — place a trade first." });
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
    await ctx.editMessageText(
      `👛 <b>Wallet security</b>\n\n` +
      `Non-custodial — only you hold the keys. Your private key is encrypted with AES-256-GCM, and the key to unlock it is derived from your password with PBKDF2.\n\n` +
      `⚠️ <b>Keep your password safe:</b>\n` +
      `• The bot never stores your password — not in any database or server.\n` +
      `• No transaction can be signed without it.\n` +
      `• If you lose it, it cannot be recovered. Back it up somewhere safe.\n` +
      `• To trade, send SUI (gas) and dUSDC (collateral) to your deposit address.`
    );
  });

// Register submenu
walletMenu.register(helpMenu);

// Helper to render main wallet page contents dynamically
async function getWalletOverviewText(telegramId: string, displayUser: string): Promise<string> {
  const wallet = getUserWallet(telegramId);
  if (!wallet) {
    return (
      `👛 <b>Wallet</b>\n\n` +
      `You don't have a wallet yet — only you hold the keys once you make one.\n\n` +
      `Create one with <code>/wallet create your-password</code>\n\n` +
      `Use at least 8 characters and keep it safe — it signs every transaction and can't be recovered.`
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
    `👛 <b>Wallet</b> · <code>${displayUser}</code>\n\n` +
    `<b>Deposit address</b>\n` +
    `<code>${wallet.sui_address}</code>\n\n` +
    `<b>Balances</b>\n` +
    `• Gas <code>${suiBalance}</code>\n` +
    `• Collateral <code>${dusdcBalance}</code>\n\n` +
    `<i>Non-custodial — only you hold the keys. Every action needs your password to sign.</i>`
  );
}

export async function unlockWalletConversation(
  conversation: MyConversation,
  ctx: Context
) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();
  const address = getUserWalletAddress(telegramId);
  if (!address) {
    await ctx.reply("Create a wallet first with <code>/wallet create your-password</code>.");
    return;
  }

  // Ask for password
  const promptMsg = await ctx.reply(
    `🔑 <b>Enter your password to unlock</b>\n\n` +
      `This checks that your password decrypts your wallet.\n\n` +
      `<i>Your password message is deleted right after you send it.</i>`,
    { parse_mode: "HTML" }
  );

  // Wait for response
  const responseCtx = await conversation.waitFor("message:text");
  const password = responseCtx.message.text.trim();
  if (password.toLowerCase() === "cancel" || password === "/cancel") {
    await responseCtx.reply("Unlock cancelled.");
    return;
  }
  if (password.startsWith("/")) {
    await responseCtx.reply("Unlock cancelled. Run the command again when ready.");
    return;
  }

  // Clean up password message from Telegram chat history
  try {
    await responseCtx.api.deleteMessage(
      responseCtx.chat.id,
      responseCtx.message.message_id
    );
  } catch (e) {
    logger.warn({ error: e }, "Failed to delete user password message");
  }

  // Delete the prompt message too to keep the chat clean
  try {
    await responseCtx.api.deleteMessage(
      responseCtx.chat.id,
      promptMsg.message_id
    );
  } catch (e) {}

  try {
    // Attempt decryption
    loadUserKeypair(telegramId, password);
    await responseCtx.reply(
      `✅ <b>Wallet unlocked</b>\n\n` +
        `Signer <code>${address}</code>`,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    await responseCtx.reply(
      `❌ <b>Couldn't unlock your wallet</b>\n\n` +
        `<code>${error instanceof Error ? error.message : "Invalid password"}</code>\n\n` +
        `Check your password and try again.`,
      { parse_mode: "HTML" }
    );
  }
}

export async function withdrawConversation(
  conversation: MyConversation,
  ctx: Context
) {
  if (!ctx.from) return;
  const telegramId = ctx.from.id.toString();
  const address = getUserWalletAddress(telegramId);
  if (!address) {
    await ctx.reply("Create a wallet first with <code>/wallet create your-password</code>.");
    return;
  }

  // 1. Ask for token (SUI or dUSDC)
  const tokenKeyboard = new InlineKeyboard()
    .text("SUI", "withdraw_asset_SUI")
    .text("dUSDC", "withdraw_asset_dUSDC")
    .row()
    .text("✗ Cancel", "withdraw_cancel");

  const assetPrompt = await ctx.reply(
    `📤 <b>Withdraw</b>\n\n` +
      `Pick a token to send.`,
    { parse_mode: "HTML", reply_markup: tokenKeyboard }
  );

  const assetCallback = await conversation.waitForCallbackQuery([
    "withdraw_asset_SUI",
    "withdraw_asset_dUSDC",
    "withdraw_cancel",
  ]);

  await assetCallback.answerCallbackQuery();
  if (assetCallback.callbackQuery.data === "withdraw_cancel") {
    try {
      await assetCallback.api.deleteMessage(assetCallback.chat!.id, assetPrompt.message_id);
    } catch (e) {}
    await assetCallback.reply("Withdrawal cancelled.");
    return;
  }

  const token = assetCallback.callbackQuery.data === "withdraw_asset_SUI" ? "SUI" : "dUSDC";
  try {
    await assetCallback.api.deleteMessage(assetCallback.chat!.id, assetPrompt.message_id);
  } catch (e) {}

  // 2. Ask for destination address
  const addrPrompt = await ctx.reply(
    `📤 <b>Withdraw ${token}</b>\n\n` +
      `Reply with the destination Sui address (starts with <code>0x</code>).`,
    { parse_mode: "HTML" }
  );

  let destAddress = "";
  while (true) {
    const addrCtx = await conversation.waitFor("message:text");
    const val = addrCtx.message.text.trim();
    if (val.toLowerCase() === "cancel" || val === "/cancel") {
      await addrCtx.reply("Withdrawal cancelled.");
      return;
    }
    if (val.startsWith("/")) {
      await addrCtx.reply("Withdrawal cancelled. Run the command again when ready.");
      return;
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(val)) {
      destAddress = val;
      break;
    }
    await addrCtx.reply("That isn't a valid Sui address. It should be 66 characters starting with <code>0x</code>.");
  }

  // Delete previous prompt
  try {
    await ctx.api.deleteMessage(ctx.chat!.id, addrPrompt.message_id);
  } catch (e) {}

  // Fetch available balance
  let rawBalance = 0n;
  let formattedBalance = "0";
  if (token === "SUI") {
    rawBalance = await getCoinBalance(address, "0x2::sui::SUI");
    formattedBalance = formatCoinAmount(rawBalance, 9);
  } else {
    rawBalance = await getDusdcBalance(address);
    formattedBalance = formatCoinAmount(rawBalance, getDusdcDecimals());
  }

  // 3. Ask for amount
  const amountPrompt = await ctx.reply(
    `📤 <b>Withdraw ${token}</b>\n\n` +
      `To <code>${destAddress}</code>\n` +
      `Available <code>${formattedBalance} ${token}</code>\n\n` +
      `Reply with the amount to send.`,
    { parse_mode: "HTML" }
  );

  let amountStr = "";
  let amountBase = 0n;
  while (true) {
    const amountCtx = await conversation.waitFor("message:text");
    const val = amountCtx.message.text.trim();
    if (val.toLowerCase() === "cancel" || val === "/cancel") {
      await amountCtx.reply("Withdrawal cancelled.");
      return;
    }
    if (val.startsWith("/")) {
      await amountCtx.reply("Withdrawal cancelled. Run the command again when ready.");
      return;
    }
    const num = parseFloat(val);
    if (!isNaN(num) && num > 0) {
      const decimals = token === "SUI" ? 9 : getDusdcDecimals();
      try {
        amountBase = parseCoinAmount(val, decimals);
        if (amountBase <= rawBalance) {
          if (token === "SUI" && amountBase === rawBalance) {
            await amountCtx.reply("⚠️ Keep some SUI for gas — you can't withdraw your full SUI balance. Enter a lower amount.");
            continue;
          }
          amountStr = val;
          break;
        } else {
          await amountCtx.reply(`Not enough ${token} — you have <code>${formattedBalance} ${token}</code>. Enter a lower amount.`);
        }
      } catch (e) {
        await amountCtx.reply("That amount isn't valid. Enter a number.");
      }
    } else {
      await amountCtx.reply("That amount isn't valid. Enter a positive number.");
    }
  }

  // Delete previous prompt
  try {
    await ctx.api.deleteMessage(ctx.chat!.id, amountPrompt.message_id);
  } catch (e) {}

  // 4. Ask for password
  const passPrompt = await ctx.reply(
    `🔑 <b>Enter your password to sign</b>\n\n` +
      `Send <code>${amountStr} ${token}</code> to <code>${destAddress}</code>\n\n` +
      `<i>Your password message is deleted right after you send it.</i>`,
    { parse_mode: "HTML" }
  );

  const passCtx = await conversation.waitFor("message:text");
  const password = passCtx.message.text.trim();

  // Clean up password message from Telegram chat history
  try {
    await passCtx.api.deleteMessage(
      passCtx.chat.id,
      passCtx.message.message_id
    );
  } catch (e) {
    logger.warn({ error: e }, "Failed to delete user password message");
  }

  if (password.toLowerCase() === "cancel" || password === "/cancel") {
    try {
      await passCtx.api.deleteMessage(passCtx.chat.id, passPrompt.message_id);
    } catch (e) {}
    await passCtx.reply("Withdrawal cancelled.");
    return;
  }
  if (password.startsWith("/")) {
    try {
      await passCtx.api.deleteMessage(passCtx.chat.id, passPrompt.message_id);
    } catch (e) {}
    await passCtx.reply("Withdrawal cancelled. Run the command again when ready.");
    return;
  }

  // Delete pass prompt
  try {
    await passCtx.api.deleteMessage(
      passCtx.chat.id,
      passPrompt.message_id
    );
  } catch (e) {}

  const loadingMsg = await passCtx.reply(
    `⏳ <i>Unlocking your wallet and sending the transaction…</i>`,
    { parse_mode: "HTML" }
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
          tx.mergeCoins(coinArg, coinsToMerge.map(id => tx.object(id)));
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
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        telegramId,
        "withdraw",
        -parseFloat(amountStr),
        `${token} Withdrawal to ${destAddress.slice(0, 8)}...`,
        now
      );

      await syncUserBalanceWithOnchain(telegramId);

      await passCtx.api.editMessageText(
        passCtx.chat.id,
        loadingMsg.message_id,
        `✅ <b>Withdrawal sent</b>\n\n` +
          `Sent <code>${amountStr} ${token}</code>\n` +
          `To <code>${destAddress}</code>\n` +
          `Tx <a href="${getExplorerTxLink(result.digest)}">${result.digest.slice(0, 8)}…${result.digest.slice(-4)}</a>`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
      );
    } else {
      await passCtx.api.editMessageText(
        passCtx.chat.id,
        loadingMsg.message_id,
        `❌ <b>Withdrawal failed</b>\n\n` +
          `<code>${result.error || "Unknown error"}</code>`,
        { parse_mode: "HTML" }
      );
    }
  } catch (error) {
    logger.error({ error }, "Withdrawal failed");
    await passCtx.api.editMessageText(
      passCtx.chat.id,
      loadingMsg.message_id,
      `❌ <b>Withdrawal failed</b>\n\n` +
        `<code>${error instanceof Error ? error.message : String(error)}</code>`,
      { parse_mode: "HTML" }
    );
  }
}

export async function withdrawCommand(ctx: Context) {
  if (!ctx.from) return;
  const address = getUserWalletAddress(ctx.from.id.toString());
  if (!address) {
    return ctx.reply("Create a wallet first with <code>/wallet create your-password</code>.");
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
  ctx: Context
) {
  if (!ctx.from) return;
  const telegramId = ctx.from.id.toString();

  const managerId = getUserManagerId(telegramId);
  if (!managerId) {
    await ctx.reply(
      "No trading account yet — place a trade with /up or /down first."
    );
    return;
  }

  // Settled winnings the keeper could not auto-redeem (ranges, plus any binary
  // whose auto-redeem failed) still need an owner-signed on-chain redeem.
  const pending = getClaimableSettledPositions(telegramId);

  // Balance already sitting in the manager (auto-redeemed binaries, dust).
  const summary = await fetchManagerSummary(managerId);
  const currentBalance = summary?.trading_balance ?? 0;

  // Each settled winner pays exactly its notional ($1 x qty) when redeemed.
  const pendingPayout = pending.reduce((sum, p) => sum + p.notional_dusdc, 0);
  const totalBase = currentBalance + pendingPayout;

  if (totalBase <= 0) {
    await ctx.reply(
      `🎁 <b>Claim</b>\n\n` +
        `Nothing to claim right now.\n\n` +
        `<i>Winning positions become claimable here once they settle.</i>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const totalStr = formatCoinAmount(BigInt(totalBase), getDusdcDecimals());

  const passPrompt = await ctx.reply(
    `🔑 <b>Enter your password to sign</b>\n\n` +
      `Claim <code>${totalStr} dUSDC</code> to your wallet.\n` +
      (pending.length > 0
        ? `Redeems ${pending.length} settled position${pending.length === 1 ? "" : "s"} and moves your trading account balance to your wallet.\n\n`
        : `Moves your trading account balance to your wallet.\n\n`) +
      `<i>Your password message is deleted right after you send it.</i>`,
    { parse_mode: "HTML" }
  );

  const passCtx = await conversation.waitFor("message:text");
  const password = passCtx.message.text.trim();

  try {
    await passCtx.api.deleteMessage(passCtx.chat.id, passCtx.message.message_id);
  } catch (e) {
    logger.warn({ error: e }, "Failed to delete user password message");
  }

  if (password.toLowerCase() === "cancel" || password.startsWith("/")) {
    try {
      await passCtx.api.deleteMessage(passCtx.chat.id, passPrompt.message_id);
    } catch (e) {}
    await passCtx.reply("Claim cancelled.");
    return;
  }

  try {
    await passCtx.api.deleteMessage(passCtx.chat.id, passPrompt.message_id);
  } catch (e) {}

  const loadingMsg = await passCtx.reply(
    `⏳ <i>Unlocking your wallet and claiming ${totalStr} dUSDC…</i>`,
    { parse_mode: "HTML" }
  );

  try {
    let result;
    if (pending.length > 0) {
      result = await claimSettledPositions({
        telegramId,
        password,
        managerObjectId: managerId,
        withdrawAmountBase: BigInt(totalBase),
        positions: pending.map((p): ClaimPositionInput =>
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
              }
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
        `✅ <b>Claimed</b>\n\n` +
          `Moved <code>${totalStr} dUSDC</code> to your wallet.\n` +
          `Tx <a href="${getExplorerTxLink(result.digest)}">${result.digest.slice(0, 8)}…${result.digest.slice(-4)}</a>`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
      );
    } else {
      await passCtx.api.editMessageText(
        passCtx.chat.id,
        loadingMsg.message_id,
        `❌ <b>Claim failed</b>\n\n<code>${result.error || "Unknown error"}</code>`,
        { parse_mode: "HTML" }
      );
    }
  } catch (error) {
    logger.error({ error, telegramId }, "Claim failed");
    await passCtx.api.editMessageText(
      passCtx.chat.id,
      loadingMsg.message_id,
      `❌ <b>Claim failed</b>\n\n<code>${error instanceof Error ? error.message : String(error)}</code>`,
      { parse_mode: "HTML" }
    );
  }
}

export async function claimCommand(ctx: Context) {
  if (!ctx.from) return;
  if (!getUserManagerId(ctx.from.id.toString())) {
    return ctx.reply(
      "No trading account yet — place a trade with /up or /down first."
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
      return ctx.reply(
        `👛 <b>Wallet</b>\n\n` +
          `You don't have a wallet yet — only you hold the keys once you make one.\n\n` +
          `Create one with <code>/wallet create your-password</code>\n\n` +
          `Use at least 8 characters and keep it safe — it signs every transaction and can't be recovered.`
      );
    }

    const displayUser = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || "User");
    const text = await getWalletOverviewText(user.telegram_id, displayUser);
    return ctx.reply(text, {
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

  return ctx.reply(
    `That isn't a wallet command.\n\n` +
      `Try:\n` +
      `/wallet create &lt;password&gt;\n` +
      `/wallet address\n` +
      `/wallet balance\n` +
      `/wallet unlock &lt;password&gt;`
  );
}

async function createWalletCommand(ctx: Context, args: string[]) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();
  const password = args.join(" ");

  if (!password) {
    return ctx.reply(
      `Usage: <code>/wallet create your-password</code>\n\n` +
        `Use at least 8 characters. Don't reuse an important password.`
    );
  }

  try {
    const wallet = createEncryptedUserWallet(telegramId, password);

    const net = getNetworkConfig().network;
    const gasHint =
      net === "mainnet"
        ? "for gas"
        : "for gas (grab some from the public Sui testnet faucet)";
    return ctx.reply(
      `✅ <b>Wallet created</b> — only you hold the keys.\n\n` +
        `<b>Deposit address</b>\n<code>${wallet.address}</code>\n\n` +
        `To start trading, fund this address on Sui <b>${net}</b>:\n` +
        `• SUI — ${gasHint}\n` +
        `• dUSDC — your trading collateral\n\n` +
        `Then check it with /balance.\n\n` +
        `Keep your password safe — it signs every transaction and <b>can't be recovered</b>.`
    );
  } catch (error) {
    return ctx.reply(
      `❌ <b>Couldn't create your wallet</b>\n\n<code>${error instanceof Error ? error.message : "Failed to create wallet"}</code>`
    );
  }
}

async function walletAddressCommand(ctx: Context) {
  if (!ctx.from) return;

  const wallet = getUserWallet(ctx.from.id.toString());

  if (!wallet) {
    return ctx.reply("No wallet yet. Create one with <code>/wallet create your-password</code>.");
  }

  return ctx.reply(
    `👛 <b>Deposit address</b>\n\n` +
      `<code>${wallet.sui_address}</code>\n\n` +
      `Send SUI for gas and dUSDC for trading to this address.`
  );
}

async function walletBalanceCommand(ctx: Context) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();
  const wallet = getUserWallet(telegramId);

  if (!wallet) {
    return ctx.reply("No wallet yet. Create one with <code>/wallet create your-password</code>.");
  }

  try {
    await syncUserBalanceWithOnchain(telegramId);

    const [suiResult, dusdcResult] = await Promise.allSettled([
      getCoinBalance(wallet.sui_address, "0x2::sui::SUI"),
      getDusdcBalance(wallet.sui_address),
    ]);
    const suiBalance = suiResult.status === "fulfilled" ? formatCoinAmount(suiResult.value, 9) : "unavailable";
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
          suiError: suiResult.status === "rejected" ? suiResult.reason : undefined,
          dusdcError: dusdcResult.status === "rejected" ? dusdcResult.reason : undefined,
        },
        "Fetched partial wallet balance"
      );
    }

    return ctx.reply(
      `💰 <b>Balance</b>\n\n` +
        `Address <code>${wallet.sui_address}</code>\n\n` +
        `• Gas <code>${suiBalance}</code> SUI\n` +
        `• Collateral <code>${dusdcBalance}</code> dUSDC${warning}`
    );
  } catch (error) {
    ctx.logger.error({ error }, "Failed to fetch wallet balance");
    return ctx.reply("Couldn't fetch your on-chain balance. Try again in a moment.");
  }
}

async function walletUnlockCommand(ctx: Context, args: string[]) {
  if (!ctx.from) return;

  const password = args.join(" ");

  if (!password) {
    return ctx.reply("Usage: <code>/wallet unlock your-password</code>");
  }

  try {
    const keypair = loadUserKeypair(ctx.from.id.toString(), password);
    const address = keypair.getPublicKey().toSuiAddress();

    return ctx.reply(
      `✅ <b>Wallet unlocked</b>\n\n` +
        `Signer <code>${address}</code>`
    );
  } catch (error) {
    return ctx.reply(
      `❌ <b>Couldn't unlock your wallet</b>\n\n<code>${error instanceof Error ? error.message : "Failed to unlock wallet"}</code>`
    );
  }
}
