import { Transaction } from "@mysten/sui/transactions";
import { getSuiClient } from "./client";
import { getSuiConfig } from "./config";
import { logger } from "../helpers/logger";

/**
 * Get dUSDC balance for an address
 */
export async function getDusdcBalance(address: string): Promise<bigint> {
  const config = getSuiConfig();
  return getCoinBalance(address, config.dusdcType);
}

/**
 * Get coin balance for an address
 */
export async function getCoinBalance(
  address: string,
  coinType: string
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
  coinType: string
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
  amount: bigint
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
      `Insufficient balance. Required: ${amount}, Available: ${totalSelected}`
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
  amount: bigint
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
