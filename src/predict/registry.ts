import {
  fetchLatestOraclePrice,
  fetchLatestOracleSvi,
  fetchOracleAskBounds,
  fetchOracleState,
  fetchPredictOracles,
} from "./client";
import { logger } from "../helpers/logger";
import type {
  Oracle,
  OracleRegistrySnapshot,
  ServerOracle,
  ServerOracleState,
} from "./types";

const CACHE_TTL_MS = 2 * 60 * 1000;
const PRICE_SCALE = 1_000_000_000;

let cachedSnapshot: OracleRegistrySnapshot | null = null;
let refreshPromise: Promise<OracleRegistrySnapshot> | null = null;

function toDisplayPrice(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  return value / PRICE_SCALE;
}

function normalizeOracle(
  serverOracle: ServerOracle,
  state: ServerOracleState | null,
  stale: boolean
): Oracle {
  const latestPrice = state?.latest_price || null;
  const settlementPrice = toDisplayPrice(serverOracle.settlement_price);
  const currentPrice =
    settlementPrice ??
    toDisplayPrice(latestPrice?.spot) ??
    toDisplayPrice(latestPrice?.forward) ??
    toDisplayPrice(serverOracle.min_strike) ??
    0;

  return {
    id: serverOracle.oracle_id,
    predict_id: serverOracle.predict_id,
    asset_symbol: serverOracle.underlying_asset.toUpperCase(),
    current_price: currentPrice,
    forward_price: toDisplayPrice(latestPrice?.forward) ?? null,
    expiry_ts: serverOracle.expiry,
    min_strike: toDisplayPrice(serverOracle.min_strike) ?? 0,
    tick_size: toDisplayPrice(serverOracle.tick_size) ?? 0,
    status: serverOracle.status,
    settlement_price: settlementPrice,
    latest_price: latestPrice,
    latest_svi: state?.latest_svi || null,
    ask_bounds: state?.ask_bounds || null,
    stale,
    fetched_at: Date.now(),
  };
}

async function loadOracleStateWithPricing(oracleId: string): Promise<ServerOracleState> {
  const state = await fetchOracleState(oracleId);
  const [latestPrice, latestSvi, askBounds] = await Promise.allSettled([
    fetchLatestOraclePrice(oracleId),
    fetchLatestOracleSvi(oracleId),
    fetchOracleAskBounds(oracleId),
  ]);

  if (latestPrice.status === "rejected") {
    logger.error({ error: latestPrice.reason, oracleId }, "Failed to fetch latest oracle price");
  }
  if (latestSvi.status === "rejected") {
    logger.error({ error: latestSvi.reason, oracleId }, "Failed to fetch latest oracle SVI");
  }
  if (askBounds.status === "rejected") {
    logger.error({ error: askBounds.reason, oracleId }, "Failed to fetch oracle ask bounds");
  }

  return {
    ...state,
    latest_price: latestPrice.status === "fulfilled" ? latestPrice.value : state.latest_price,
    latest_svi: latestSvi.status === "fulfilled" ? latestSvi.value : state.latest_svi,
    ask_bounds: askBounds.status === "fulfilled" ? askBounds.value : state.ask_bounds,
  };
}

async function loadFreshRegistry(): Promise<OracleRegistrySnapshot> {
  const serverOracles = await fetchPredictOracles();
  const activeOracles = serverOracles.filter((oracle) => oracle.status === "active");
  const normalized = await Promise.all(
    activeOracles.map(async (oracle) => {
      try {
        return normalizeOracle(oracle, await loadOracleStateWithPricing(oracle.oracle_id), false);
      } catch (error) {
        logger.error({ error, oracleId: oracle.oracle_id }, "Failed to fetch oracle state");
        return normalizeOracle(oracle, null, true);
      }
    })
  );

  const snapshot = {
    oracles: normalized.sort((a, b) => a.expiry_ts - b.expiry_ts),
    stale: normalized.some((oracle) => oracle.stale),
    fetchedAt: Date.now(),
  };

  cachedSnapshot = snapshot;
  return snapshot;
}

async function refreshInBackground(): Promise<void> {
  if (refreshPromise) return;

  refreshPromise = loadFreshRegistry()
    .catch((error) => {
      logger.error({ error }, "Failed to refresh Predict oracle registry");
      if (cachedSnapshot) {
        cachedSnapshot = {
          ...cachedSnapshot,
          stale: true,
          oracles: cachedSnapshot.oracles.map((oracle) => ({ ...oracle, stale: true })),
        };
      }
      throw error;
    })
    .finally(() => {
      refreshPromise = null;
    });

  await refreshPromise.catch(() => undefined);
}

export async function refreshOracleRegistry(): Promise<OracleRegistrySnapshot> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = loadFreshRegistry().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export async function getOracleRegistrySnapshot(): Promise<OracleRegistrySnapshot> {
  const now = Date.now();

  if (!cachedSnapshot) {
    try {
      return await refreshOracleRegistry();
    } catch (error) {
      logger.error({ error }, "Initial Predict oracle registry load failed");
      return { oracles: [], stale: true, fetchedAt: now };
    }
  }

  if (now - cachedSnapshot.fetchedAt > CACHE_TTL_MS) {
    void refreshInBackground();
    return {
      ...cachedSnapshot,
      stale: true,
      oracles: cachedSnapshot.oracles.map((oracle) => ({ ...oracle, stale: true })),
    };
  }

  return cachedSnapshot;
}

export async function getActiveOracles(): Promise<Oracle[]> {
  const snapshot = await getOracleRegistrySnapshot();
  return snapshot.oracles.filter((oracle) => oracle.status === "active");
}

export async function getOraclesByAsset(assetSymbol: string): Promise<Oracle[]> {
  const symbol = assetSymbol.toUpperCase();
  const oracles = await getActiveOracles();
  return oracles.filter((oracle) => oracle.asset_symbol === symbol);
}

export async function getAvailableAssets(): Promise<string[]> {
  const oracles = await getActiveOracles();
  return Array.from(new Set(oracles.map((oracle) => oracle.asset_symbol))).sort();
}

export async function findNearestOracle(
  assetSymbol: string,
  targetMinutes: number
): Promise<Oracle | null> {
  const oracles = await getOraclesByAsset(assetSymbol);
  if (oracles.length === 0) return null;

  return oracles.reduce((nearest, current) => {
    const currentMinutes = (current.expiry_ts - Date.now()) / (60 * 1000);
    const nearestMinutes = (nearest.expiry_ts - Date.now()) / (60 * 1000);

    return Math.abs(currentMinutes - targetMinutes) < Math.abs(nearestMinutes - targetMinutes)
      ? current
      : nearest;
  });
}

export async function getOracleById(oracleId: string): Promise<Oracle | null> {
  const snapshot = await getOracleRegistrySnapshot();
  const cachedOracle = snapshot.oracles.find((oracle) => oracle.id === oracleId);
  if (cachedOracle) return cachedOracle;

  try {
    const state = await loadOracleStateWithPricing(oracleId);
    return normalizeOracle(state.oracle, state, false);
  } catch (error) {
    logger.error({ error, oracleId }, "Failed to fetch oracle by id");
    return null;
  }
}

export async function getCurrentPrice(assetSymbol: string): Promise<number | null> {
  const oracles = await getOraclesByAsset(assetSymbol);
  return oracles[0]?.current_price || null;
}

export async function getCurrentPriceForOracle(oracleId: string): Promise<number | null> {
  const oracle = await getOracleById(oracleId);
  return oracle?.settlement_price ?? oracle?.current_price ?? null;
}
