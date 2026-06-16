import { getPredictServerUrl, getSuiConfig } from "../sui/config";
import { logger } from "../helpers/logger";
import type {
  ServerAskBounds,
  ServerOracle,
  ServerOraclePrice,
  ServerOracleState,
  ServerOracleSvi,
  PredictState,
  VaultSummary,
} from "./types";

const REQUEST_TIMEOUT_MS = 30_000;

function getBaseUrl(): string {
  return getPredictServerUrl().replace(/\/$/, "");
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Predict server returned ${response.status} for ${path}: ${body.slice(0, 300)}`);
    }

    const body = await response.text();
    if (!body) return null as T;

    try {
      return JSON.parse(body) as T;
    } catch (error) {
      throw new Error(`Predict server returned invalid JSON for ${path}: ${body.slice(0, 300)}`);
    }
  } catch (error) {
    // Stringify: pino renders an Error under a custom key as "{}", which hid
    // real causes (e.g. the server's 500 "missing mark quote results").
    logger.warn(
      { url, error: error instanceof Error ? error.message : String(error) },
      "Predict server request failed"
    );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchPredictOracles(
  predictId: string = getSuiConfig().predictObjectId
): Promise<ServerOracle[]> {
  return fetchJson<ServerOracle[]>(`/predicts/${predictId}/oracles`);
}

export async function fetchOracleState(oracleId: string): Promise<ServerOracleState> {
  return fetchJson<ServerOracleState>(`/oracles/${oracleId}/state`);
}

export async function fetchLatestOraclePrice(oracleId: string): Promise<ServerOraclePrice | null> {
  return fetchJson<ServerOraclePrice | null>(`/oracles/${oracleId}/prices/latest`);
}

export async function fetchLatestOracleSvi(oracleId: string): Promise<ServerOracleSvi | null> {
  return fetchJson<ServerOracleSvi | null>(`/oracles/${oracleId}/svi/latest`);
}

export async function fetchOracleAskBounds(oracleId: string): Promise<ServerAskBounds | null> {
  return fetchJson<ServerAskBounds | null>(`/oracles/${oracleId}/ask-bounds`);
}

export async function fetchPredictState(
  predictId: string = getSuiConfig().predictObjectId
): Promise<PredictState> {
  return fetchJson<PredictState>(`/predicts/${predictId}/state`);
}

export async function fetchVaultSummary(
  predictId: string = getSuiConfig().predictObjectId
): Promise<VaultSummary> {
  return fetchJson<VaultSummary>(`/predicts/${predictId}/vault/summary`);
}

/**
 * Per-user trading account summary from the indexer. All amounts are in dUSDC
 * base units (1e6). `trading_balance` is the withdrawable manager balance;
 * realized/unrealized PnL reflect on-chain position outcomes.
 */
export interface ManagerSummary {
  manager_id: string;
  owner: string;
  balances: Array<{ quote_asset: string; balance: number }>;
  trading_balance: number;
  open_exposure: number;
  redeemable_value: number;
  realized_pnl: number;
  unrealized_pnl: number;
  account_value: number;
  open_positions: number;
  awaiting_settlement_positions: number;
}

/**
 * Fetch a manager summary, returning null instead of throwing when the manager
 * is not yet indexed (e.g. just created) or the server is unavailable.
 */
export async function fetchManagerSummary(managerId: string): Promise<ManagerSummary | null> {
  try {
    return await fetchJson<ManagerSummary | null>(`/managers/${managerId}/summary`);
  } catch (error) {
    logger.warn(
      { managerId, error: error instanceof Error ? error.message : String(error) },
      "Failed to fetch manager summary"
    );
    return null;
  }
}

/**
 * On-chain position open/close events for a manager (from the indexer). Strikes
 * are 1e9-scaled; quantity/cost/payout are dUSDC base units (1e6). Tolerant:
 * returns [] on error.
 */
export interface PositionEvent {
  oracle_id: string;
  strike: number | string;
  is_up: boolean;
  quantity: number;
  cost?: number | null;
  payout?: number | null;
  checkpoint_timestamp_ms: number | string;
  digest?: string;
}

export async function fetchPositionsMinted(managerId: string): Promise<PositionEvent[]> {
  try {
    return (await fetchJson<PositionEvent[]>(`/positions/minted?manager_id=${managerId}`)) ?? [];
  } catch (error) {
    logger.warn(
      { managerId, error: error instanceof Error ? error.message : String(error) },
      "Failed to fetch minted positions"
    );
    return [];
  }
}

export async function fetchPositionsRedeemed(managerId: string): Promise<PositionEvent[]> {
  try {
    return (await fetchJson<PositionEvent[]>(`/positions/redeemed?manager_id=${managerId}`)) ?? [];
  } catch (error) {
    logger.warn(
      { managerId, error: error instanceof Error ? error.message : String(error) },
      "Failed to fetch redeemed positions"
    );
    return [];
  }
}

/**
 * Per-position summary for a manager (open + closed), from the indexer.
 * Strikes 1e9-scaled; quantities/PnL in dUSDC base units (1e6). Tolerant.
 */
export interface ManagerPosition {
  oracle_id: string;
  underlying_asset?: string | null;
  strike: number | string;
  is_up: boolean;
  open_quantity: number;
  unrealized_pnl?: number | null;
  average_entry_price?: number | string | null;
  mark_price?: number | string | null;
}

export async function fetchManagerPositions(managerId: string): Promise<ManagerPosition[]> {
  try {
    return (await fetchJson<ManagerPosition[]>(`/managers/${managerId}/positions/summary`)) ?? [];
  } catch (error) {
    logger.warn(
      { managerId, error: error instanceof Error ? error.message : String(error) },
      "Failed to fetch manager positions"
    );
    return [];
  }
}
