import { logger } from "../helpers/logger";
import type { PredictConfig } from "./types";
import { isValidSuiAddress, isValidSuiObjectId } from "@mysten/sui/utils";

// Validate required environment variables
function validateEnvVar(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function validateOptionalEnvVar(name: string, value: string | undefined): string | undefined {
  return value;
}

function validateObjectId(name: string, value: string): string {
  if (!isValidSuiObjectId(value)) {
    throw new Error(`Invalid ${name} format: ${value}`);
  }

  return value;
}

function validateStructTag(name: string, value: string): string {
  if (!/^0x[a-fA-F0-9]+::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid ${name} format: ${value}`);
  }

  return value;
}

// Parse and validate Sui configuration from environment
export function getSuiConfig(): PredictConfig {
  const config: PredictConfig = {
    packageId: validateObjectId("PREDICT_PACKAGE_ID", validateEnvVar("PREDICT_PACKAGE_ID", process.env.PREDICT_PACKAGE_ID)),
    predictObjectId: validateObjectId("PREDICT_OBJECT_ID", validateEnvVar("PREDICT_OBJECT_ID", process.env.PREDICT_OBJECT_ID)),
    registryId: validateObjectId("PREDICT_REGISTRY_ID", validateEnvVar("PREDICT_REGISTRY_ID", process.env.PREDICT_REGISTRY_ID)),
    dusdcType: validateStructTag("DUSDC_TYPE", validateEnvVar("DUSDC_TYPE", process.env.DUSDC_TYPE)),
    dusdcCurrencyId: validateObjectId("DUSDC_CURRENCY_ID", validateEnvVar("DUSDC_CURRENCY_ID", process.env.DUSDC_CURRENCY_ID)),
    dusdcDecimals: parseInt(process.env.DUSDC_DECIMALS || "6", 10),
    managerObjectId: validateOptionalEnvVar("PREDICT_MANAGER_ID", process.env.PREDICT_MANAGER_ID),
  };

  if (!isValidSuiAddress(config.packageId)) {
    throw new Error(`Invalid PREDICT_PACKAGE_ID format: ${config.packageId}`);
  }

  if (!Number.isInteger(config.dusdcDecimals) || config.dusdcDecimals < 0) {
    throw new Error(`Invalid DUSDC_DECIMALS value: ${config.dusdcDecimals}`);
  }

  if (config.managerObjectId && !isValidSuiObjectId(config.managerObjectId)) {
    throw new Error(`Invalid PREDICT_MANAGER_ID format: ${config.managerObjectId}`);
  }

  logger.info("Sui configuration validated successfully");
  
  return config;
}

// Get RPC URL with fallback to testnet
export function getSuiRpcUrl(): string {
  const rpcUrl = validateEnvVar("SUI_RPC_URL", process.env.SUI_RPC_URL);

  try {
    new URL(rpcUrl);
  } catch {
    throw new Error(`Invalid SUI_RPC_URL format: ${rpcUrl}`);
  }

  return rpcUrl;
}

// Get predict server URL
export function getPredictServerUrl(): string {
  return process.env.PREDICT_SERVER_URL || "https://predict-server.testnet.mystenlabs.com";
}
