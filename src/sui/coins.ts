import { Transaction } from "@mysten/sui/transactions";
import { getSuiClient } from "./client";
import { getSuiConfig } from "./config";
import { logger } from "../helpers/logger";

const TESTNET_DUSDC_TYPE_FALLBACK =
  "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC";

export function getDusdcType(): string {
  return process.env.DUSDC_TYPE || TESTNET_DUSDC_TYPE_FALLBACK;
}

export function getDusdcDecimals(): number {
  const decimals = Number.parseInt(process.env.DUSDC_DECIMALS || "6", 10);
  return Number.isInteger(decimals) && decimals >= 0 ? decimals : 6;
}

/**
 * Get dUSDC balance for an address
 */
export async function getDusdcBalance(address: string): Promise<bigint> {
  return getCoinBalance(address, getDusdcType());
}

/**
 * Get coin balance for an address
 */
export async function getCoinBalance(
  address: string,
  coinType: string,
): Promise<bigint> {
  const client = getSuiClient();

  try {
    const balance = await client.getBalance({
      owner: address,
      coinType,
    });

    return BigInt(balance.totalBalance);
  } catch (error) {
    logger.error({ error, address, coinType }, "Failed to get coin balance");
    throw error;
  }
}

/**
 * Get all coin objects of a specific type for an address
 */
export async function getCoinObjects(
  address: string,
  coinType: string,
): Promise<Array<{ objectId: string; balance: bigint }>> {
  const client = getSuiClient();

  try {
    const coins = await client.getCoins({
      owner: address,
      coinType,
    });

    return coins.data.map((coin) => ({
      objectId: coin.coinObjectId,
      balance: BigInt(coin.balance),
    }));
  } catch (error) {
    logger.error({ error, address, coinType }, "Failed to get coin objects");
    throw error;
  }
}

/**
 * Select coins to cover a specific amount
 * Returns coin object IDs that sum to at least the required amount
 */
export async function selectCoins(
  address: string,
  coinType: string,
  amount: bigint,
): Promise<string[]> {
  const coins = await getCoinObjects(address, coinType);

  if (coins.length === 0) {
    throw new Error(`No ${coinType} coins found for address ${address}`);
  }

  // Sort coins by balance (largest first) for efficiency
  coins.sort((a, b) => (a.balance > b.balance ? -1 : 1));

  const selectedCoins: string[] = [];
  let totalSelected = 0n;

  for (const coin of coins) {
    selectedCoins.push(coin.objectId);
    totalSelected += coin.balance;

    if (totalSelected >= amount) {
      break;
    }
  }

  if (totalSelected < amount) {
    throw new Error(
      `Insufficient balance. Required: ${amount}, Available: ${totalSelected}`,
    );
  }

  return selectedCoins;
}

/**
 * Split a coin into a specific amount
 * Returns the coin object that can be used in a transaction
 */
export function splitCoin(
  tx: Transaction,
  coinType: string,
  amount: bigint,
): any {
  const config = getSuiConfig();

  // For dUSDC, we need to split from gas or existing coins
  if (coinType === config.dusdcType) {
    // This will be handled by the transaction builder
    // The actual coin selection happens in the transaction execution
    return tx.splitCoins(tx.gas, [amount]);
  }

  throw new Error(`Unsupported coin type: ${coinType}`);
}

/**
 * Format coin amount with decimals
 */
export function formatCoinAmount(amount: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;

  if (fraction === 0n) {
    return whole.toString();
  }

  const fractionStr = fraction.toString().padStart(decimals, "0");
  return `${whole}.${fractionStr}`;
}

/**
 * Parse coin amount from decimal string
 */
export function parseCoinAmount(amount: string, decimals: number): bigint {
  const [whole, fraction = ""] = amount.split(".");
  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  const combined = whole + paddedFraction;
  return BigInt(combined);
}

export async function triggerFaucetForUser(
  targetAddress: string,
): Promise<{ success: boolean; digest?: string; error?: string }> {
  const sponsorPrivateKeyHex =
    process.env.SPONSOR_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!sponsorPrivateKeyHex) {
    logger.warn(
      "No SPONSOR_PRIVATE_KEY or PRIVATE_KEY defined in env. Faucet skipped.",
    );
    return {
      success: false,
      error: "Faucet not configured on server (.env is missing private key)",
    };
  }

  try {
    const { parsePrivateKey } = await import("./wallets");
    const { executeTransaction } = await import("./transactions");

    const sponsorKeypair = parsePrivateKey(sponsorPrivateKeyHex);
    const sponsorAddress = sponsorKeypair.getPublicKey().toSuiAddress();
    const config = getSuiConfig();

    const tx = new Transaction();
    tx.setSender(sponsorAddress);

    // 1. Split SUI for gas (0.1 SUI = 100,000,000 MIST)
    const [suiCoin] = tx.splitCoins(tx.gas, [100_000_000n]);
    tx.transferObjects([suiCoin], targetAddress);

    // 2. Split and transfer 1000 dUSDC (1,000,000,000 base units)
    const coinIds = await selectCoins(
      sponsorAddress,
      config.dusdcType,
      1_000_000_000n,
    );
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
    const [paymentCoin] = tx.splitCoins(coinArg, [1_000_000_000n]);
    tx.transferObjects([paymentCoin], targetAddress);

    const result = await executeTransaction(tx, sponsorKeypair);
    return result;
  } catch (error) {
    logger.error({ error, targetAddress }, "Faucet execution failed");
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
