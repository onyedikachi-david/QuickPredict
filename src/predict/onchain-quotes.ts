import { Transaction } from "@mysten/sui/transactions";
import { getSuiClient } from "../sui/client";
import { getSuiConfig } from "../sui/config";
import { logger } from "../helpers/logger";
import type { Oracle } from "./types";

export interface OnchainTradeAmounts {
  mintCostDusdc: number;
  redeemPayoutDusdc: number;
}

const PRICE_SCALE = 1_000_000_000n;
const DEV_INSPECT_SENDER =
  process.env.DEV_INSPECT_SENDER ||
  "0x0000000000000000000000000000000000000000000000000000000000000001";

function getPackageId(): string {
  return getSuiConfig().packageId;
}

function getPredictObjectId(): string {
  return getSuiConfig().predictObjectId;
}

function toScaledPrice(value: number): bigint {
  return BigInt(Math.round(value * Number(PRICE_SCALE)));
}

function readU64(bytes: number[]): number {
  let value = 0n;
  for (let index = 0; index < bytes.length; index += 1) {
    value += BigInt(bytes[index]) << BigInt(index * 8);
  }
  return Number(value);
}

async function inspectQuote(tx: Transaction): Promise<OnchainTradeAmounts> {
  const client = getSuiClient();
  tx.setSender(DEV_INSPECT_SENDER);

  // gRPC SimulateTransaction. `include.commandResults` makes the SDK request the
  // `command_outputs` read-mask so the Move return values come back; they arrive
  // as raw BCS bytes under commandResults[].returnValues[].bcs.
  const sim = await client.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
  });

  if (sim.$kind !== "Transaction") {
    throw new Error("On-chain quote simulation failed");
  }

  const last = sim.commandResults?.[sim.commandResults.length - 1];
  const returnValues = last?.returnValues ?? [];
  const mintBcs = returnValues[0]?.bcs;
  const redeemBcs = returnValues[1]?.bcs;
  if (!mintBcs || !redeemBcs) {
    throw new Error("On-chain quote did not return mint and redeem amounts");
  }

  return {
    mintCostDusdc: readU64(Array.from(mintBcs as Uint8Array)),
    redeemPayoutDusdc: readU64(Array.from(redeemBcs as Uint8Array)),
  };
}

export async function quoteBinaryTradeOnchain(params: {
  oracle: Oracle;
  strike: number;
  quantityDusdc: number;
  isUp: boolean;
}): Promise<OnchainTradeAmounts | null> {
  try {
    const packageId = getPackageId();
    const tx = new Transaction();
    const key = tx.moveCall({
      target: `${packageId}::market_key::new`,
      arguments: [
        tx.pure.id(params.oracle.id),
        tx.pure.u64(BigInt(params.oracle.expiry_ts)),
        tx.pure.u64(toScaledPrice(params.strike)),
        tx.pure.bool(params.isUp),
      ],
    });

    tx.moveCall({
      target: `${packageId}::predict::get_trade_amounts`,
      arguments: [
        tx.object(getPredictObjectId()),
        tx.object(params.oracle.id),
        key,
        tx.pure.u64(BigInt(params.quantityDusdc)),
        tx.object.clock(),
      ],
    });

    return await inspectQuote(tx);
  } catch (error) {
    logger.warn({ error, oracleId: params.oracle.id, strike: params.strike }, "Falling back from on-chain binary quote");
    return null;
  }
}

export async function quoteRangeTradeOnchain(params: {
  oracle: Oracle;
  lowerStrike: number;
  upperStrike: number;
  quantityDusdc: number;
}): Promise<OnchainTradeAmounts | null> {
  try {
    const packageId = getPackageId();
    const tx = new Transaction();
    const key = tx.moveCall({
      target: `${packageId}::range_key::new`,
      arguments: [
        tx.pure.id(params.oracle.id),
        tx.pure.u64(BigInt(params.oracle.expiry_ts)),
        tx.pure.u64(toScaledPrice(params.lowerStrike)),
        tx.pure.u64(toScaledPrice(params.upperStrike)),
      ],
    });

    tx.moveCall({
      target: `${packageId}::predict::get_range_trade_amounts`,
      arguments: [
        tx.object(getPredictObjectId()),
        tx.object(params.oracle.id),
        key,
        tx.pure.u64(BigInt(params.quantityDusdc)),
        tx.object.clock(),
      ],
    });

    return await inspectQuote(tx);
  } catch (error) {
    logger.warn(
      { error, oracleId: params.oracle.id, lowerStrike: params.lowerStrike, upperStrike: params.upperStrike },
      "Falling back from on-chain range quote"
    );
    return null;
  }
}
