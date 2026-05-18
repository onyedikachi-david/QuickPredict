import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { getSuiRpcUrl } from "./config";
import { logger } from "../helpers/logger";

export type SuiClient = SuiJsonRpcClient;

let cachedClient: SuiClient | null = null;

/**
 * Create and return a singleton SuiClient instance
 */
export function getSuiClient(): SuiClient {
  if (cachedClient) {
    return cachedClient;
  }

  const rpcUrl = getSuiRpcUrl();
  
  // Determine network from RPC URL
  const network = rpcUrl.includes('testnet') ? 'testnet' 
    : rpcUrl.includes('devnet') ? 'devnet'
    : rpcUrl.includes('localnet') ? 'localnet'
    : 'mainnet';
  
  logger.info({ rpcUrl, network }, "Initializing Sui client");

  cachedClient = new SuiJsonRpcClient({
    network,
    url: rpcUrl,
  });

  return cachedClient;
}

/**
 * Check if the Sui client is connected and working
 */
export async function checkSuiConnection(): Promise<boolean> {
  try {
    const client = getSuiClient();
    const rpcApiVersion = await client.getRpcApiVersion();
    logger.info({ rpcApiVersion }, "Sui client connected successfully");
    return true;
  } catch (error) {
    logger.error({ error }, "Failed to connect to Sui network");
    return false;
  }
}

/**
 * Get the current epoch
 */
export async function getCurrentEpoch(): Promise<string> {
  const client = getSuiClient();
  const systemState = await client.getLatestSuiSystemState();
  return systemState.epoch;
}

/**
 * Clear cached client (useful for testing)
 */
export function clearClientCache(): void {
  cachedClient = null;
}
