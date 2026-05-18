// Export all Sui modules
export * from "./types";
export * from "./config";
export * from "./client";
export * from "./coins";
export * from "./transactions";
export * from "./predict";
export * from "./wallets";

import { checkSuiConnection, getSuiClient } from "./client";
import { getSuiConfig } from "./config";
import { getPredictManager } from "./predict";
import { logger } from "../helpers/logger";

/**
 * Initialize Sui integration
 * - Validates configuration
 * - Checks network connection
 * - Verifies configured PredictManager when provided
 */
export async function initializeSui(): Promise<{
  success: boolean;
  managerObjectId?: string;
  error?: string;
}> {
  try {
    logger.info("Initializing Sui integration...");

    // 1. Validate configuration
    const config = getSuiConfig();
    logger.info("Sui configuration loaded");

    // 2. Check network connection
    const connected = await checkSuiConnection();
    if (!connected) {
      throw new Error("Failed to connect to Sui network");
    }

    // 3. Verify configured PredictManager
    let managerObjectId = config.managerObjectId;

    if (managerObjectId) {
      logger.info({ managerObjectId }, "Verifying existing PredictManager...");
      await getPredictManager(managerObjectId);
      logger.info({ managerObjectId }, "PredictManager verified");
    } else {
      logger.warn("PREDICT_MANAGER_ID is not set; onchain mint/redeem calls must provide a manager object later");
    }

    logger.info("✅ Sui integration initialized successfully");

    return {
      success: true,
      managerObjectId,
    };
  } catch (error) {
    logger.error({ error }, "Failed to initialize Sui integration");
    
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if Sui integration is properly configured
 * Returns true if all required env vars are set
 */
export function isSuiConfigured(): boolean {
  return !!(
    process.env.PREDICT_PACKAGE_ID &&
    process.env.PREDICT_OBJECT_ID &&
    process.env.PREDICT_REGISTRY_ID &&
    process.env.DUSDC_TYPE &&
    process.env.DUSDC_CURRENCY_ID
  );
}
