// Sui type definitions for DeepBook Predict

export interface PredictConfig {
  packageId: string;
  predictObjectId: string;
  registryId: string;
  dusdcType: string;
  dusdcCurrencyId: string;
  dusdcDecimals: number;
  managerObjectId?: string;
}

export interface OracleSVI {
  id: string;
  asset_symbol: string;
  expiry_ts: number;
  status: "active" | "pending_settlement" | "settled";
  settlement_price?: number;
}

export interface MintPositionParams {
  telegramId: string;
  password: string;
  managerObjectId: string;
  predictObjectId: string;
  oracleId: string;
  strike: number;
  isUp: boolean;
  coinAmount: number;
}

export interface RedeemPositionParams {
  telegramId: string;
  password: string;
  managerObjectId: string;
  predictObjectId: string;
  settledOracleId: string;
}

export interface TransactionResult {
  digest: string;
  success: boolean;
  effects?: any;
  error?: string;
}

export interface ExplorerLink {
  transaction: string;
  object: string;
  address: string;
}
