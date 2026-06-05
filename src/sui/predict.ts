import { Transaction } from "@mysten/sui/transactions";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getSuiClient } from "./client";
import { getSuiConfig } from "./config";
import { executeUserTransaction, executeTransaction } from "./transactions";
import { selectCoins } from "./coins";
import { getUserWalletAddress } from "./wallets";
import { getUserManagerId, setUserManagerId } from "../db/wallets";
import { logger } from "../helpers/logger";
import type {
  MintPositionParams,
  MintRangePositionParams,
  RedeemPositionParams,
  RedeemRangePositionParams,
  CreateManagerResult,
  TransactionResult,
} from "./types";

// Strikes / prices are 9-decimal scaled on-chain; dUSDC quantities are 6-decimal.
const PRICE_SCALE = 1_000_000_000;

/** Scale a human dollar strike (e.g. 75000) to the on-chain 1e9-scaled u64. */
function toScaledStrike(dollars: number): bigint {
  return BigInt(Math.round(dollars * PRICE_SCALE));
}

/**
 * Top up the PredictManager's balance from the wallet's existing dUSDC coins so
 * that a subsequent mint can pull the premium from the manager. Adds the
 * merge/split/deposit calls to `tx`. No-op when `amountBase <= 0`.
 */
async function addManagerDeposit(
  tx: Transaction,
  walletAddress: string,
  managerObjectId: string,
  dusdcType: string,
  amountBase: bigint
): Promise<void> {
  if (amountBase <= 0n) return;

  const coinIds = await selectCoins(walletAddress, dusdcType, amountBase);
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

  const [depositCoin] = tx.splitCoins(coinArg, [amountBase]);
  tx.moveCall({
    target: `${getSuiConfig().packageId}::predict_manager::deposit`,
    typeArguments: [dusdcType],
    arguments: [tx.object(managerObjectId), depositCoin],
  });
}

/** Build a `MarketKey` (binary UP/DOWN) inside `tx`. */
function buildMarketKey(
  tx: Transaction,
  packageId: string,
  oracleId: string,
  expiryMs: number,
  strikeDollars: number,
  isUp: boolean
) {
  return tx.moveCall({
    target: `${packageId}::market_key::new`,
    arguments: [
      tx.pure.id(oracleId),
      tx.pure.u64(BigInt(expiryMs)),
      tx.pure.u64(toScaledStrike(strikeDollars)),
      tx.pure.bool(isUp),
    ],
  });
}

/** Build a `RangeKey` (vertical range) inside `tx`. */
function buildRangeKey(
  tx: Transaction,
  packageId: string,
  oracleId: string,
  expiryMs: number,
  lowerStrikeDollars: number,
  upperStrikeDollars: number
) {
  return tx.moveCall({
    target: `${packageId}::range_key::new`,
    arguments: [
      tx.pure.id(oracleId),
      tx.pure.u64(BigInt(expiryMs)),
      tx.pure.u64(toScaledStrike(lowerStrikeDollars)),
      tx.pure.u64(toScaledStrike(upperStrikeDollars)),
    ],
  });
}

/**
 * Create a PredictManager for the caller and return its object id.
 * Each user holds exactly one; it carries their deposited dUSDC and positions.
 */
export async function createPredictManager(
  telegramId: string,
  password: string
): Promise<CreateManagerResult> {
  const config = getSuiConfig();
  const walletAddress = getUserWalletAddress(telegramId);

  if (!walletAddress) {
    return {
      digest: "",
      success: false,
      error: "No wallet found. Create one first with /wallet create <password>",
    };
  }

  const tx = new Transaction();
  tx.setSender(walletAddress);
  tx.moveCall({
    target: `${config.packageId}::predict::create_manager`,
    arguments: [],
  });

  const result = await executeUserTransaction(telegramId, password, tx);
  if (!result.success) {
    logger.error({ telegramId, error: result.error }, "Failed to create PredictManager");
    return { digest: result.digest, success: false, error: result.error };
  }

  const changes = Array.isArray(result.objectChanges) ? result.objectChanges : [];
  // Match by type (works for both JSON-RPC objectChanges and the gRPC objectTypes
  // shape) — a create_manager tx only ever touches the one new PredictManager.
  const created = changes.find(
    (change: any) =>
      typeof change?.objectType === "string" &&
      change.objectType.endsWith("::predict_manager::PredictManager")
  );
  const managerId = created?.objectId as string | undefined;

  if (!managerId) {
    logger.error(
      { telegramId, digest: result.digest },
      "PredictManager transaction succeeded but manager id was not found in objectChanges"
    );
    return {
      digest: result.digest,
      success: false,
      error: "Trading account created but its id could not be read. Please retry.",
    };
  }

  return { digest: result.digest, success: true, managerId };
}

/**
 * Return the user's PredictManager id, creating and persisting one if needed.
 */
export async function ensurePredictManager(
  telegramId: string,
  password: string
): Promise<
  | { ok: true; managerId: string; created: boolean }
  | { ok: false; error: string }
> {
  const existing = getUserManagerId(telegramId);
  if (existing) return { ok: true, managerId: existing, created: false };

  const result = await createPredictManager(telegramId, password);
  if (!result.success || !result.managerId) {
    return { ok: false, error: result.error || "Failed to create trading account" };
  }

  setUserManagerId(telegramId, result.managerId);
  logger.info(
    { telegramId, managerId: result.managerId },
    "Created and stored PredictManager for user"
  );
  return { ok: true, managerId: result.managerId, created: true };
}

/**
 * Mint a binary position.
 *
 * PTB: `predict_manager::deposit` (fund premium) -> `market_key::new` ->
 * `predict::mint<DUSDC>(predict, manager, oracle, key, quantity, clock)`.
 * The contract pulls the premium (ask x quantity) from the manager balance.
 */
export async function mintPosition(
  params: MintPositionParams
): Promise<TransactionResult> {
  const config = getSuiConfig();
  const walletAddress = getUserWalletAddress(params.telegramId);

  if (!walletAddress) {
    return {
      digest: "",
      success: false,
      error: "No wallet found. Create one first with /wallet create <password>",
    };
  }

  logger.info(
    {
      telegramId: params.telegramId,
      oracleId: params.oracleId,
      strikeDollars: params.strikeDollars,
      isUp: params.isUp,
      quantityBase: params.quantityBase,
    },
    "Minting position..."
  );

  const tx = new Transaction();
  tx.setSender(walletAddress);

  await addManagerDeposit(
    tx,
    walletAddress,
    params.managerObjectId,
    config.dusdcType,
    params.depositBase
  );

  const key = buildMarketKey(
    tx,
    config.packageId,
    params.oracleId,
    params.expiryMs,
    params.strikeDollars,
    params.isUp
  );

  tx.moveCall({
    target: `${config.packageId}::predict::mint`,
    typeArguments: [config.dusdcType],
    arguments: [
      tx.object(params.predictObjectId),
      tx.object(params.managerObjectId),
      tx.object(params.oracleId),
      key,
      tx.pure.u64(BigInt(params.quantityBase)),
      tx.object.clock(),
    ],
  });

  const result = await executeUserTransaction(params.telegramId, params.password, tx);

  if (!result.success) {
    logger.error({ error: result.error }, "Failed to mint position");
  } else {
    logger.info({ digest: result.digest }, "Position minted successfully");
  }

  return result;
}

/**
 * Mint a vertical range position.
 *
 * PTB: `predict_manager::deposit` -> `range_key::new` ->
 * `predict::mint_range<DUSDC>(predict, manager, oracle, key, quantity, clock)`.
 */
export async function mintRangePosition(
  params: MintRangePositionParams
): Promise<TransactionResult> {
  const config = getSuiConfig();
  const walletAddress = getUserWalletAddress(params.telegramId);

  if (!walletAddress) {
    return {
      digest: "",
      success: false,
      error: "No wallet found. Create one first with /wallet create <password>",
    };
  }

  logger.info(
    {
      telegramId: params.telegramId,
      oracleId: params.oracleId,
      lowerStrikeDollars: params.lowerStrikeDollars,
      upperStrikeDollars: params.upperStrikeDollars,
      quantityBase: params.quantityBase,
    },
    "Minting range position..."
  );

  const tx = new Transaction();
  tx.setSender(walletAddress);

  await addManagerDeposit(
    tx,
    walletAddress,
    params.managerObjectId,
    config.dusdcType,
    params.depositBase
  );

  const key = buildRangeKey(
    tx,
    config.packageId,
    params.oracleId,
    params.expiryMs,
    params.lowerStrikeDollars,
    params.upperStrikeDollars
  );

  tx.moveCall({
    target: `${config.packageId}::predict::mint_range`,
    typeArguments: [config.dusdcType],
    arguments: [
      tx.object(params.predictObjectId),
      tx.object(params.managerObjectId),
      tx.object(params.oracleId),
      key,
      tx.pure.u64(BigInt(params.quantityBase)),
      tx.object.clock(),
    ],
  });

  const result = await executeUserTransaction(params.telegramId, params.password, tx);

  if (!result.success) {
    logger.error({ error: result.error }, "Failed to mint range position");
  } else {
    logger.info({ digest: result.digest }, "Range position minted successfully");
  }

  return result;
}

/**
 * Redeem a binary position back into the PredictManager balance. When `settled`
 * is true the protocol's permissionless redeem path is used; otherwise the live
 * owner-only redeem is used for an early exit at the current bid.
 */
export async function redeemPosition(
  params: RedeemPositionParams
): Promise<TransactionResult> {
  const config = getSuiConfig();
  const walletAddress = getUserWalletAddress(params.telegramId);

  if (!walletAddress) {
    return {
      digest: "",
      success: false,
      error: "No wallet found. Create one first with /wallet create <password>",
    };
  }

  logger.info({ telegramId: params.telegramId, settled: params.settled }, "Redeeming position...");

  const tx = new Transaction();
  tx.setSender(walletAddress);

  const key = buildMarketKey(
    tx,
    config.packageId,
    params.oracleId,
    params.expiryMs,
    params.strikeDollars,
    params.isUp
  );

  tx.moveCall({
    target: `${config.packageId}::predict::${params.settled ? "redeem_permissionless" : "redeem"}`,
    typeArguments: [config.dusdcType],
    arguments: [
      tx.object(params.predictObjectId),
      tx.object(params.managerObjectId),
      tx.object(params.oracleId),
      key,
      tx.pure.u64(BigInt(params.quantityBase)),
      tx.object.clock(),
    ],
  });

  const result = await executeUserTransaction(params.telegramId, params.password, tx);

  if (!result.success) {
    logger.error({ error: result.error }, "Failed to redeem position");
  } else {
    logger.info({ digest: result.digest }, "Position redeemed successfully");
  }

  return result;
}

/**
 * Redeem a vertical range position. `predict::redeem_range` is owner-gated (no
 * permissionless variant exists), so this always requires the manager owner.
 */
export async function redeemRangePosition(
  params: RedeemRangePositionParams
): Promise<TransactionResult> {
  const config = getSuiConfig();
  const walletAddress = getUserWalletAddress(params.telegramId);

  if (!walletAddress) {
    return {
      digest: "",
      success: false,
      error: "No wallet found. Create one first with /wallet create <password>",
    };
  }

  const tx = new Transaction();
  tx.setSender(walletAddress);

  const key = buildRangeKey(
    tx,
    config.packageId,
    params.oracleId,
    params.expiryMs,
    params.lowerStrikeDollars,
    params.upperStrikeDollars
  );

  tx.moveCall({
    target: `${config.packageId}::predict::redeem_range`,
    typeArguments: [config.dusdcType],
    arguments: [
      tx.object(params.predictObjectId),
      tx.object(params.managerObjectId),
      tx.object(params.oracleId),
      key,
      tx.pure.u64(BigInt(params.quantityBase)),
      tx.object.clock(),
    ],
  });

  const result = await executeUserTransaction(params.telegramId, params.password, tx);

  if (!result.success) {
    logger.error({ error: result.error }, "Failed to redeem range position");
  } else {
    logger.info({ digest: result.digest }, "Range position redeemed successfully");
  }

  return result;
}

/**
 * Permissionlessly redeem a SETTLED binary position into the owner's manager
 * using a keeper/sponsor keypair. Anyone may call `redeem_permissionless` once
 * the oracle has settled, so the settlement keeper can close winners on behalf
 * of users. Aborts on-chain if the oracle is not yet settled.
 */
export async function redeemPositionPermissionlessWithKeypair(params: {
  signer: Ed25519Keypair;
  predictObjectId: string;
  managerObjectId: string;
  oracleId: string;
  expiryMs: number;
  strikeDollars: number;
  isUp: boolean;
  quantityBase: number;
}): Promise<TransactionResult> {
  const config = getSuiConfig();

  const tx = new Transaction();
  tx.setSender(params.signer.getPublicKey().toSuiAddress());

  const key = buildMarketKey(
    tx,
    config.packageId,
    params.oracleId,
    params.expiryMs,
    params.strikeDollars,
    params.isUp
  );

  tx.moveCall({
    target: `${config.packageId}::predict::redeem_permissionless`,
    typeArguments: [config.dusdcType],
    arguments: [
      tx.object(params.predictObjectId),
      tx.object(params.managerObjectId),
      tx.object(params.oracleId),
      key,
      tx.pure.u64(BigInt(params.quantityBase)),
      tx.object.clock(),
    ],
  });

  return executeTransaction(tx, params.signer);
}

/**
 * Withdraw dUSDC from the user's PredictManager balance back to their wallet
 * (owner-gated `predict_manager::withdraw`). Used to claim realized winnings.
 */
export async function withdrawFromManager(params: {
  telegramId: string;
  password: string;
  managerObjectId: string;
  amountBase: bigint;
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

  const tx = new Transaction();
  tx.setSender(walletAddress);

  const coinOut = tx.moveCall({
    target: `${config.packageId}::predict_manager::withdraw`,
    typeArguments: [config.dusdcType],
    arguments: [tx.object(params.managerObjectId), tx.pure.u64(params.amountBase)],
  });
  tx.transferObjects([coinOut], tx.pure.address(walletAddress));

  return executeUserTransaction(params.telegramId, params.password, tx);
}

export interface ClaimPositionInput {
  kind: "binary" | "range";
  oracleId: string;
  expiryMs: number;
  quantityBase: number;
  // binary
  strikeDollars?: number;
  isUp?: boolean;
  // range
  lowerStrikeDollars?: number;
  upperStrikeDollars?: number;
}

/**
 * Redeem a batch of settled positions and withdraw the resulting balance to the
 * wallet in a single owner-signed PTB. Realizes winnings the keeper could not
 * auto-redeem: ranges (owner-gated) and any binary whose auto-redeem failed.
 * Binaries use the settled `redeem_permissionless` path; ranges use `redeem_range`.
 */
export async function claimSettledPositions(params: {
  telegramId: string;
  password: string;
  managerObjectId: string;
  withdrawAmountBase: bigint;
  positions: ClaimPositionInput[];
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

  const tx = new Transaction();
  tx.setSender(walletAddress);

  for (const pos of params.positions) {
    if (pos.kind === "range") {
      const key = buildRangeKey(
        tx,
        config.packageId,
        pos.oracleId,
        pos.expiryMs,
        pos.lowerStrikeDollars!,
        pos.upperStrikeDollars!
      );
      tx.moveCall({
        target: `${config.packageId}::predict::redeem_range`,
        typeArguments: [config.dusdcType],
        arguments: [
          tx.object(config.predictObjectId),
          tx.object(params.managerObjectId),
          tx.object(pos.oracleId),
          key,
          tx.pure.u64(BigInt(pos.quantityBase)),
          tx.object.clock(),
        ],
      });
    } else {
      const key = buildMarketKey(
        tx,
        config.packageId,
        pos.oracleId,
        pos.expiryMs,
        pos.strikeDollars!,
        pos.isUp!
      );
      tx.moveCall({
        target: `${config.packageId}::predict::redeem_permissionless`,
        typeArguments: [config.dusdcType],
        arguments: [
          tx.object(config.predictObjectId),
          tx.object(params.managerObjectId),
          tx.object(pos.oracleId),
          key,
          tx.pure.u64(BigInt(pos.quantityBase)),
          tx.object.clock(),
        ],
      });
    }
  }

  if (params.withdrawAmountBase > 0n) {
    const coinOut = tx.moveCall({
      target: `${config.packageId}::predict_manager::withdraw`,
      typeArguments: [config.dusdcType],
      arguments: [tx.object(params.managerObjectId), tx.pure.u64(params.withdrawAmountBase)],
    });
    tx.transferObjects([coinOut], tx.pure.address(walletAddress));
  }

  return executeUserTransaction(params.telegramId, params.password, tx);
}

/**
 * Get PredictManager object details.
 */
export async function getPredictManager(managerObjectId: string): Promise<any> {
  const client = getSuiClient();

  try {
    const object = await client.getObject({ objectId: managerObjectId });
    return object;
  } catch (error) {
    logger.error({ error, managerObjectId }, "Failed to get PredictManager");
    throw error;
  }
}
