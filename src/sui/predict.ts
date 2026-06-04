import { Transaction } from "@mysten/sui/transactions";
import { getSuiClient } from "./client";
import { getSuiConfig } from "./config";
import { executeUserTransaction } from "./transactions";
import { selectCoins } from "./coins";
import { getUserWalletAddress } from "./wallets";
import { logger } from "../helpers/logger";
import type { MintPositionParams, RedeemPositionParams, TransactionResult } from "./types";

/**
 * Mint a binary position
 * Calls predict::mint(manager, predict, oracle, strike, is_up, coin)
 */
export async function mintPosition(params: MintPositionParams): Promise<TransactionResult> {
  const config = getSuiConfig();
  const walletAddress = getUserWalletAddress(params.telegramId);

  if (!walletAddress) {
    return {
      digest: "",
      success: false,
      error: "No wallet found. Create one first with /wallet create <password>",
    };
  }

  logger.info({ params }, "Minting position...");

  const tx = new Transaction();

  // Select coins to cover the amount
  const coinIds = await selectCoins(walletAddress, config.dusdcType, BigInt(params.coinAmount));
  
  // Merge coins if multiple
  let coinArg;
  if (coinIds.length === 1) {
    coinArg = tx.object(coinIds[0]);
  } else {
    const [primaryCoin, ...coinsToMerge] = coinIds;
    coinArg = tx.object(primaryCoin);
    if (coinsToMerge.length > 0) {
      tx.mergeCoins(
        coinArg,
        coinsToMerge.map((id) => tx.object(id))
      );
    }
  }

  // Split the exact amount needed
  const [paymentCoin] = tx.splitCoins(coinArg, [params.coinAmount]);

  // Call predict::mint
  tx.moveCall({
    target: `${config.packageId}::predict::mint`,
    arguments: [
      tx.object(params.managerObjectId),
      tx.object(params.predictObjectId),
      tx.object(params.oracleId),
      tx.pure.u64(params.strike),
      tx.pure.bool(params.isUp),
      paymentCoin,
    ],
    typeArguments: [config.dusdcType],
  });

  const result = await executeUserTransaction(params.telegramId, params.password, tx);

  if (!result.success) {
    logger.error({ params, error: result.error }, "Failed to mint position");
  } else {
    logger.info({ digest: result.digest }, "Position minted successfully");
  }

  return result;
}

/**
 * Mint a range position
 * Calls predict::mint_range(manager, predict, oracle, lower_strike, upper_strike, coin)
 */
export async function mintRangePosition(params: {
  telegramId: string;
  password: string;
  managerObjectId: string;
  predictObjectId: string;
  oracleId: string;
  lowerStrike: number;
  upperStrike: number;
  coinAmount: string; // dUSDC quantity in base units
}): Promise<TransactionResult> {
  const config = getSuiConfig();
  const walletAddress = getUserWalletAddress(params.telegramId);

  if (!walletAddress) {
    return {
      digest: "",
      success: false,
      error: "No wallet found. Create one first with /wallet create <password>",
    };
  }

  logger.info({ params }, "Minting range position...");

  const tx = new Transaction();

  // Select coins to cover the amount
  const coinIds = await selectCoins(walletAddress, config.dusdcType, BigInt(params.coinAmount));
  
  // Merge coins if multiple
  let coinArg;
  if (coinIds.length === 1) {
    coinArg = tx.object(coinIds[0]);
  } else {
    const [primaryCoin, ...coinsToMerge] = coinIds;
    coinArg = tx.object(primaryCoin);
    if (coinsToMerge.length > 0) {
      tx.mergeCoins(
        coinArg,
        coinsToMerge.map((id) => tx.object(id))
      );
    }
  }

  // Split the exact amount needed
  const [paymentCoin] = tx.splitCoins(coinArg, [params.coinAmount]);

  // Call predict::mint_range
  tx.moveCall({
    target: `${config.packageId}::predict::mint_range`,
    arguments: [
      tx.object(params.managerObjectId),
      tx.object(params.predictObjectId),
      tx.object(params.oracleId),
      tx.pure.u64(params.lowerStrike),
      tx.pure.u64(params.upperStrike),
      paymentCoin,
    ],
    typeArguments: [config.dusdcType],
  });

  const result = await executeUserTransaction(params.telegramId, params.password, tx);

  if (!result.success) {
    logger.error({ params, error: result.error }, "Failed to mint range position");
  } else {
    logger.info({ digest: result.digest }, "Range position minted successfully");
  }

  return result;
}

/**
 * Redeem settled positions
 * Calls predict::redeem_permissionless(manager, predict, settled_oracle)
 */
export async function redeemPosition(params: RedeemPositionParams): Promise<TransactionResult> {
  const config = getSuiConfig();

  logger.info({ params }, "Redeeming position...");

  const tx = new Transaction();

  // Call predict::redeem_permissionless
  tx.moveCall({
    target: `${config.packageId}::predict::redeem_permissionless`,
    arguments: [
      tx.object(params.managerObjectId),
      tx.object(params.predictObjectId),
      tx.object(params.settledOracleId),
    ],
    typeArguments: [config.dusdcType],
  });

  const result = await executeUserTransaction(params.telegramId, params.password, tx);

  if (!result.success) {
    logger.error({ params, error: result.error }, "Failed to redeem position");
  } else {
    logger.info({ digest: result.digest }, "Position redeemed successfully");
  }

  return result;
}

/**
 * Get PredictManager object details
 */
export async function getPredictManager(managerObjectId: string): Promise<any> {
  const client = getSuiClient();

  try {
    const object = await client.getObject({
      id: managerObjectId,
      options: {
        showContent: true,
        showType: true,
      },
    });

    return object;
  } catch (error) {
    logger.error({ error, managerObjectId }, "Failed to get PredictManager");
    throw error;
  }
}

