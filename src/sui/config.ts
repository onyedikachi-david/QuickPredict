import type { PredictConfig } from "./types";
import { getNetworkConfig } from "../config/network";

// Thin adapter over the network seam (src/config/network.ts), preserving the
// PredictConfig shape consumers expect. All network-specific values — and the
// testnet/mainnet decision + fail-fast guard — live in the seam, not here.

export function getSuiConfig(): PredictConfig {
  const c = getNetworkConfig();
  return {
    packageId: c.predict.packageId,
    predictObjectId: c.predict.objectId,
    registryId: c.predict.registryId,
    dusdcType: c.dusdc.type,
    dusdcCurrencyId: c.dusdc.currencyId,
    dusdcDecimals: c.dusdc.decimals,
    // Legacy global manager (unused now — managers are per-user). Kept optional.
    managerObjectId: process.env.PREDICT_MANAGER_ID,
  };
}

export function getSuiRpcUrl(): string {
  return getNetworkConfig().endpoints.rpc;
}

export function getPredictServerUrl(): string {
  return getNetworkConfig().endpoints.predictServer;
}
