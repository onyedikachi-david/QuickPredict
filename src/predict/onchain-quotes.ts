import { Transaction } from "@mysten/sui/transactions";
import { getSuiClient } from "../sui/client";
import { logger } from "../helpers/logger";
import type { Oracle } from "./types";

export interface OnchainTradeAmounts {
  mintCostDusdc: number;
  redeemPayoutDusdc: number;
}

const PRICE_SCALE = 1_000_000_000n;
const TESTNET_PACKAGE_ID_FALLBACK =
  "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138";
const TESTNET_PREDICT_ID_FALLBACK =
  "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a";
const DEV_INSPECT_SENDER =
  process.env.DEV_INSPECT_SENDER ||
  "0x0000000000000000000000000000000000000000000000000000000000000001";

function getPackageId(): string {
  return process.env.PREDICT_PACKAGE_ID || TESTNET_PACKAGE_ID_FALLBACK;
}

function getPredictObjectId(): string {
  return process.env.PREDICT_OBJECT_ID || TESTNET_PREDICT_ID_FALLBACK;
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

function extractTradeAmounts(result: unknown): OnchainTradeAmounts {
  const results = (result as { results?: Array<{ returnValues?: unknown[] }> }).results || [];
  const tradeResult = [...results].reverse().find((item) => {
    const values = item.returnValues;
    return Array.isArray(values) && values.length >= 2;
  });

  const values = tradeResult?.returnValues as Array<[number[], string]> | undefined;
  if (!values?.[0]?.[0] || !values?.[1]?.[0]) {
    throw new Error("On-chain quote did not return mint and redeem amounts");
  }

  return {
    mintCostDusdc: readU64(values[0][0]),
    redeemPayoutDusdc: readU64(values[1][0]),
  };
}

async function inspectQuote(tx: Transaction): Promise<OnchainTradeAmounts> {
  const client = getSuiClient();
  const result = await client.devInspectTransactionBlock({
    sender: DEV_INSPECT_SENDER,
    transactionBlock: tx,
  });

  if (result.effects?.status?.status !== "success") {
    throw new Error(result.effects?.status?.error || "On-chain quote devInspect failed");
  }

  return extractTradeAmounts(result);
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
