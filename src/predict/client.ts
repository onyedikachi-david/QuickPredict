import { getPredictServerUrl } from "../sui/config";
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
const TESTNET_PREDICT_ID_FALLBACK =
  "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a";

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
    logger.error({ error, url, timeoutMs: REQUEST_TIMEOUT_MS }, "Predict server request failed");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchPredictOracles(
  predictId: string = process.env.PREDICT_OBJECT_ID || TESTNET_PREDICT_ID_FALLBACK
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
  predictId: string = process.env.PREDICT_OBJECT_ID || TESTNET_PREDICT_ID_FALLBACK
): Promise<PredictState> {
  return fetchJson<PredictState>(`/predicts/${predictId}/state`);
}

export async function fetchVaultSummary(
  predictId: string = process.env.PREDICT_OBJECT_ID || TESTNET_PREDICT_ID_FALLBACK
): Promise<VaultSummary> {
  return fetchJson<VaultSummary>(`/predicts/${predictId}/vault/summary`);
}
