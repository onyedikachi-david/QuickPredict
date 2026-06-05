import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { getNetworkConfig } from "../config/network";
import { logger } from "../helpers/logger";

// Primary data transport is gRPC (the post-JSON-RPC path). JSON-RPC is retained
// only for transaction execution (pending a funded-wallet validation of the
// gRPC execute path) and for the DeepBook v3 SDK, which predates gRPC.
export type SuiClient = SuiGrpcClient;

let grpcClient: SuiGrpcClient | null = null;
let rpcClient: SuiJsonRpcClient | null = null;

/**
 * Primary client for reads + simulation, over gRPC.
 */
export function getSuiClient(): SuiGrpcClient {
  if (grpcClient) return grpcClient;
  const cfg = getNetworkConfig();
  logger.info({ network: cfg.network, grpc: cfg.endpoints.grpc }, "Initializing Sui gRPC client");
  grpcClient = new SuiGrpcClient({ network: cfg.network, baseUrl: cfg.endpoints.grpc });
  return grpcClient;
}

/**
 * JSON-RPC client — used for transaction execution and the DeepBook v3 SDK.
 * Deprecated by Sui (sunset 2026-07-31); migrate the execute path to gRPC
 * `signAndExecuteTransaction` once it is validated against a funded wallet.
 */
export function getRpcClient(): SuiJsonRpcClient {
  if (rpcClient) return rpcClient;
  const cfg = getNetworkConfig();
  logger.info({ network: cfg.network, rpc: cfg.endpoints.rpc }, "Initializing Sui JSON-RPC client (execute/DeepBook)");
  rpcClient = new SuiJsonRpcClient({ network: cfg.network, url: cfg.endpoints.rpc });
  return rpcClient;
}

/**
 * Check that the gRPC data path is reachable.
 */
export async function checkSuiConnection(): Promise<boolean> {
  try {
    await getSuiClient().getReferenceGasPrice();
    logger.info("Sui gRPC client connected successfully");
    return true;
  } catch (error) {
    logger.error({ error }, "Failed to connect to Sui network");
    return false;
  }
}

/**
 * Clear cached clients (useful for testing / config changes).
 */
export function clearClientCache(): void {
  grpcClient = null;
  rpcClient = null;
}
