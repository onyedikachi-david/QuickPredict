import { Context, MyConversation } from "../../common/context";
import { getOrCreateUser, syncUserBalanceWithOnchain } from "../../db/users";
import { getUserWallet } from "../../db/wallets";
import {
  getCoinBalance,
  getDusdcBalance,
  getDusdcDecimals,
  formatCoinAmount,
  triggerFaucetForUser,
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

// Define help submenu
export const helpMenu = new Menu<Context>("wallet-help")
  .back("⬅️ Back to Wallet", async (ctx) => {
    if (!ctx.from) return;
    const displayUser = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || "User");
    const text = await getWalletOverviewText(ctx.from.id.toString(), displayUser);
    await ctx.editMessageText(text);
  });

export const walletMenu = new Menu<Context>("wallet-main")
  .text("🔄 Refresh Balance", async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery({ text: "Updating balances..." });
    const displayUser = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || "User");
    const text = await getWalletOverviewText(ctx.from.id.toString(), displayUser);
    await ctx.editMessageText(text);
  })
  .text("🎁 Claim Faucet", async (ctx) => {
    if (!ctx.from) return;
    const telegramId = ctx.from.id.toString();
    const address = getUserWalletAddress(telegramId);
    if (!address) {
      await ctx.answerCallbackQuery({ text: "No wallet found." });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Requesting testnet faucet..." });
    const faucetResult = await triggerFaucetForUser(address);

    if (faucetResult.success) {
      await ctx.reply(
        `🎁 <b>Faucet Claimed Successfully!</b>\n\n` +
        `Credited 0.1 SUI and 1,000 dUSDC.\n` +
        `Tx: <code>${faucetResult.digest}</code>`,
        { parse_mode: "HTML" }
      );
      const displayUser = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || "User");
      const text = await getWalletOverviewText(telegramId, displayUser);
      await ctx.editMessageText(text);
    } else {
      await ctx.reply(
        `⚠️ <b>Faucet Request Failed:</b>\n\n` +
        `<code>${faucetResult.error || "No sponsor key or rate limited"}</code>`,
        { parse_mode: "HTML" }
      );
    }
  })
  .row()
  .text("🔑 Unlock / Verify", async (ctx) => {
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
  .text("🔄 Swap SUI/dUSDC", async (ctx) => {
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
  .submenu("❓ Security & Help", "wallet-help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `🛡️ <b>Sui Non-Custodial Wallet Security</b>\n\n` +
      `Your wallet's private key is stored completely encrypted using AES-256-GCM. ` +
      `The decryption key is derived using PBKDF2 from the password you chose during wallet creation.\n\n` +
      `🔑 <b>Important Security Rules:</b>\n` +
      `• The bot does <b>NOT</b> store your password on any database or server.\n` +
      `• It is impossible to execute any transaction without your password.\n` +
      `• If you lose your password, there is absolutely <b>NO way</b> to recover it. Please write down any backup info safely.\n` +
      `• To trade, send SUI (for gas) and dUSDC (for trading collateral) to your deposit address.`
    );
  });

// Register submenu
walletMenu.register(helpMenu);

// Helper to render main wallet page contents dynamically
async function getWalletOverviewText(telegramId: string, displayUser: string): Promise<string> {
  const wallet = getUserWallet(telegramId);
  if (!wallet) {
    return (
      `👛 <b>Sui Non-Custodial Wallet</b>\n\n` +
      `You do not have a wallet yet.\n\n` +
      `Create one with:\n` +
      `<code>/wallet create your-password</code>\n\n` +
      `Use at least 8 characters. Keep this password safe — it is needed to sign transactions.`
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
    `👛 <b>Your Sui Wallet Overview</b>\n\n` +
    `👤 <b>User:</b> <code>${displayUser}</code>\n` +
    `📍 <b>Deposit Address:</b>\n` +
    `<code>${wallet.sui_address}</code>\n\n` +
    `💰 <b>Onchain Balances:</b>\n` +
    `• <b>SUI (Gas):</b> <code>${suiBalance}</code>\n` +
    `• <b>dUSDC (Collateral):</b> <code>${dusdcBalance}</code>\n\n` +
    `✨ <i>This wallet is completely non-custodial. All operations require your secret password to sign.</i>`
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
    await ctx.reply("❌ Create a wallet first with /wallet create <password>");
    return;
  }

  // Ask for password
  const promptMsg = await ctx.reply(
    `🔑 <b>Verify Wallet Password</b>\n\n` +
      `Please reply with your wallet password to verify decryption capabilities.\n\n` +
      `⚠️ <i>Your password message will be instantly deleted from chat history for your security.</i>`,
    { parse_mode: "HTML" }
  );

  // Wait for response
  const responseCtx = await conversation.waitFor("message:text");
  const password = responseCtx.message.text.trim();
  if (password.toLowerCase() === "cancel" || password === "/cancel") {
    await responseCtx.reply("❌ Verification cancelled.");
    return;
  }
  if (password.startsWith("/")) {
    await responseCtx.reply("❌ Verification cancelled. Please type your command again.");
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
      `✅ <b>Decryption Verified Successfully!</b>\n\n` +
        `Signer Address: <code>${address}</code>\n\n` +
        `Your password is correct and your wallet is fully operational!`,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    await responseCtx.reply(
      `❌ <b>Decryption Failed</b>\n\n` +
        `<code>${error instanceof Error ? error.message : "Invalid password"}</code>\n\n` +
        `Please make sure your password is correct and try again.`,
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
    await ctx.reply("❌ Create a wallet first with /wallet create <password>");
    return;
  }

  // 1. Ask for token (SUI or dUSDC)
  const tokenKeyboard = new InlineKeyboard()
    .text("SUI", "withdraw_asset_SUI")
    .text("dUSDC", "withdraw_asset_dUSDC")
    .row()
    .text("✗ Cancel", "withdraw_cancel");

  const assetPrompt = await ctx.reply(
    `📤 <b>Withdrawal: Select Token</b>\n\n` +
      `Please select the token you wish to withdraw from your wallet:`,
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
    await assetCallback.reply("❌ Withdrawal cancelled.");
    return;
  }

  const token = assetCallback.callbackQuery.data === "withdraw_asset_SUI" ? "SUI" : "dUSDC";
  try {
    await assetCallback.api.deleteMessage(assetCallback.chat!.id, assetPrompt.message_id);
  } catch (e) {}

  // 2. Ask for destination address
  const addrPrompt = await ctx.reply(
    `📤 <b>Withdrawal: Destination Address</b>\n\n` +
      `Selected: <b>${token}</b>\n\n` +
      `Please reply with the destination Sui wallet address (e.g. <code>0x...</code>) where you want to send your ${token}.`,
    { parse_mode: "HTML" }
  );

  let destAddress = "";
  while (true) {
    const addrCtx = await conversation.waitFor("message:text");
    const val = addrCtx.message.text.trim();
    if (val.toLowerCase() === "cancel" || val === "/cancel") {
      await addrCtx.reply("❌ Withdrawal cancelled.");
      return;
    }
    if (val.startsWith("/")) {
      await addrCtx.reply("❌ Withdrawal cancelled. Please type your command again.");
      return;
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(val)) {
      destAddress = val;
      break;
    }
    await addrCtx.reply("❌ Invalid Sui address format. Please reply with a valid 66-character hex address starting with 0x:");
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
    `📤 <b>Withdrawal: Amount</b>\n\n` +
      `Asset: <b>${token}</b>\n` +
      `To: <code>${destAddress}</code>\n` +
      `Available Balance: <code>${formattedBalance} ${token}</code>\n\n` +
      `Please reply with the amount you wish to withdraw:`,
    { parse_mode: "HTML" }
  );

  let amountStr = "";
  let amountBase = 0n;
  while (true) {
    const amountCtx = await conversation.waitFor("message:text");
    const val = amountCtx.message.text.trim();
    if (val.toLowerCase() === "cancel" || val === "/cancel") {
      await amountCtx.reply("❌ Withdrawal cancelled.");
      return;
    }
    if (val.startsWith("/")) {
      await amountCtx.reply("❌ Withdrawal cancelled. Please type your command again.");
      return;
    }
    const num = parseFloat(val);
    if (!isNaN(num) && num > 0) {
      const decimals = token === "SUI" ? 9 : getDusdcDecimals();
      try {
        amountBase = parseCoinAmount(val, decimals);
        if (amountBase <= rawBalance) {
          if (token === "SUI" && amountBase === rawBalance) {
            await amountCtx.reply("⚠️ You cannot withdraw 100% of your SUI balance as some SUI is needed to pay for gas fees. Please enter a lower amount:");
            continue;
          }
          amountStr = val;
          break;
        } else {
          await amountCtx.reply(`❌ Insufficient balance. You only have ${formattedBalance} ${token}. Please enter a lower amount:`);
        }
      } catch (e) {
        await amountCtx.reply("❌ Invalid amount format. Please enter a valid number:");
      }
    } else {
      await amountCtx.reply("❌ Invalid amount. Please enter a positive number:");
    }
  }

  // Delete previous prompt
  try {
    await ctx.api.deleteMessage(ctx.chat!.id, amountPrompt.message_id);
  } catch (e) {}

  // 4. Ask for password
  const passPrompt = await ctx.reply(
    `🔑 <b>Withdrawal: Sign & Execute</b>\n\n` +
      `Sending: <b>${amountStr} ${token}</b>\n` +
      `To: <code>${destAddress}</code>\n\n` +
      `Please reply with your wallet password to sign and execute this withdrawal on-chain.\n` +
      `⚠️ <i>Your password message will be instantly deleted from chat history for your security.</i>`,
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
    await passCtx.reply("❌ Withdrawal cancelled.");
    return;
  }
  if (password.startsWith("/")) {
    try {
      await passCtx.api.deleteMessage(passCtx.chat.id, passPrompt.message_id);
    } catch (e) {}
    await passCtx.reply("❌ Withdrawal cancelled. Please type your command again.");
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
    `⏳ <b>Processing on-chain...</b>\n\n` +
      `Sending ${amountStr} ${token} to <code>${destAddress}</code>.\n` +
      `This may take a few seconds...`,
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
      
      if (token === "dUSDC") {
        db.prepare(
          "UPDATE users SET dusdc_balance = dusdc_balance - ? WHERE telegram_id = ?"
        ).run(parseFloat(amountStr), telegramId);
      }

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
        `✅ <b>Withdrawal Successful!</b>\n\n` +
          `💰 <b>Sent:</b> <code>${amountStr} ${token}</code>\n` +
          `📍 <b>To Address:</b>\n<code>${destAddress}</code>\n\n` +
          `🔗 <a href="${getExplorerTxLink(result.digest)}">View on SuiScan Explorer</a>`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
      );
    } else {
      await passCtx.api.editMessageText(
        passCtx.chat.id,
        loadingMsg.message_id,
        `❌ <b>Withdrawal Failed</b>\n\n` +
          `Error: <code>${result.error || "Execution failed"}</code>`,
        { parse_mode: "HTML" }
      );
    }
  } catch (error) {
    logger.error({ error }, "Withdrawal failed");
    await passCtx.api.editMessageText(
      passCtx.chat.id,
      loadingMsg.message_id,
      `❌ <b>Withdrawal Error</b>\n\n` +
        `<code>${error instanceof Error ? error.message : String(error)}</code>`,
      { parse_mode: "HTML" }
    );
  }
}

export async function withdrawCommand(ctx: Context) {
  if (!ctx.from) return;
  const address = getUserWalletAddress(ctx.from.id.toString());
  if (!address) {
    return ctx.reply("❌ Create a wallet first with /wallet create <password>");
  }
  return ctx.conversation.enter("withdrawConversation");
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
        `👛 <b>Sui Wallet</b>\n\n` +
          `You do not have a wallet yet.\n\n` +
          `Create one with:\n` +
          `<code>/wallet create your-password</code>\n\n` +
          `Use at least 8 characters. Keep this password safe — it is needed to sign transactions.`
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
    `❌ Unknown wallet command.\n\n` +
      `Available commands:\n` +
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
      `❌ Usage: <code>/wallet create your-password</code>\n\n` +
        `Use at least 8 characters. Do not reuse an important password.`
    );
  }

  try {
    const wallet = createEncryptedUserWallet(telegramId, password);

    const fundingMsg = await ctx.reply(
      `✅ <b>Wallet Created</b>\n\n` +
        `Address:\n<code>${wallet.address}</code>\n\n` +
        `🎁 <i>Triggering testnet SUI & dUSDC faucet, please wait...</i>`
    );

    const faucetResult = await triggerFaucetForUser(wallet.address);

    if (faucetResult.success) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        fundingMsg.message_id,
        `✅ <b>Wallet Created & Funded</b>\n\n` +
          `Address:\n<code>${wallet.address}</code>\n\n` +
          `🎁 <b>Faucet successful:</b> Credited 0.1 SUI and 1,000 dUSDC.\n` +
          `Tx: <code>${faucetResult.digest}</code>\n\n` +
          `Keep your password safe. It is required to sign every transaction, and the bot cannot recover it for you.`
      );
      await syncUserBalanceWithOnchain(telegramId);
    } else {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        fundingMsg.message_id,
        `✅ <b>Wallet Created (Unfunded)</b>\n\n` +
          `Address:\n<code>${wallet.address}</code>\n\n` +
          `⚠️ <i>Faucet warning: ${faucetResult.error || "no sponsor key configured"}</i>\n\n` +
          `Please fund this wallet manually with SUI and dUSDC to trade.`
      );
    }
  } catch (error) {
    return ctx.reply(
      `❌ ${error instanceof Error ? error.message : "Failed to create wallet"}`
    );
  }
}

async function walletAddressCommand(ctx: Context) {
  if (!ctx.from) return;

  const wallet = getUserWallet(ctx.from.id.toString());

  if (!wallet) {
    return ctx.reply("❌ No wallet found. Create one with /wallet create <password>");
  }

  return ctx.reply(
    `👛 <b>Your Deposit Address</b>\n\n` +
      `<code>${wallet.sui_address}</code>\n\n` +
      `Send SUI for gas and dUSDC for trading to this address.`
  );
}

async function walletBalanceCommand(ctx: Context) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();
  const wallet = getUserWallet(telegramId);

  if (!wallet) {
    return ctx.reply("❌ No wallet found. Create one with /wallet create <password>");
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
        ? `\n\n⚠️ One or more balances could not be fetched from Sui RPC.`
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
      `💰 <b>Onchain Balance</b>\n\n` +
        `Address:\n<code>${wallet.sui_address}</code>\n\n` +
        `SUI: ${suiBalance}\n` +
        `dUSDC: ${dusdcBalance}${warning}`
    );
  } catch (error) {
    ctx.logger.error({ error }, "Failed to fetch wallet balance");
    return ctx.reply("❌ Failed to fetch onchain balance. Please try again later.");
  }
}

async function walletUnlockCommand(ctx: Context, args: string[]) {
  if (!ctx.from) return;

  const password = args.join(" ");

  if (!password) {
    return ctx.reply("❌ Usage: <code>/wallet unlock your-password</code>");
  }

  try {
    const keypair = loadUserKeypair(ctx.from.id.toString(), password);
    const address = keypair.getPublicKey().toSuiAddress();

    return ctx.reply(
      `✅ Wallet unlocked successfully.\n\n` +
        `Signer address:\n<code>${address}</code>`
    );
  } catch (error) {
    return ctx.reply(
      `❌ ${error instanceof Error ? error.message : "Failed to unlock wallet"}`
    );
  }
}
