import { Context } from "../../common/context";
import { getOrCreateUser } from "../../db/users";
import { getUserWallet } from "../../db/wallets";
import { getSuiConfig } from "../../sui/config";
import { getCoinBalance, getDusdcBalance, formatCoinAmount } from "../../sui/coins";
import {
  createEncryptedUserWallet,
  getUserWalletAddress,
  loadUserKeypair,
} from "../../sui/wallets";

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

    return ctx.reply(
      `👛 <b>Your Sui Wallet</b>\n\n` +
        `Address:\n<code>${address}</code>\n\n` +
        `Commands:\n` +
        `/wallet balance - check SUI and dUSDC\n` +
        `/wallet address - show deposit address\n` +
        `/wallet unlock &lt;password&gt; - test your signing password`
    );
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

    return ctx.reply(
      `✅ <b>Wallet Created</b>\n\n` +
        `Deposit SUI or dUSDC to:\n<code>${wallet.address}</code>\n\n` +
        `Keep your password safe. It is required to sign every transaction, and the bot cannot recover it for you.`
    );
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

  const wallet = getUserWallet(ctx.from.id.toString());

  if (!wallet) {
    return ctx.reply("❌ No wallet found. Create one with /wallet create <password>");
  }

  try {
    const config = getSuiConfig();
    const [suiBalance, dusdcBalance] = await Promise.all([
      getCoinBalance(wallet.sui_address, "0x2::sui::SUI"),
      getDusdcBalance(wallet.sui_address),
    ]);

    return ctx.reply(
      `💰 <b>Onchain Balance</b>\n\n` +
        `Address:\n<code>${wallet.sui_address}</code>\n\n` +
        `SUI: ${formatCoinAmount(suiBalance, 9)}\n` +
        `dUSDC: ${formatCoinAmount(dusdcBalance, config.dusdcDecimals)}`
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
