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

/**
 * Mint a binary (UP/DOWN) position.
 *
 * Mirrors the on-chain flow `predict_manager::deposit` -> `market_key::new` ->
 * `predict::mint`. Collateral is pulled from the PredictManager's balance, so
 * `depositBase` is topped up from the wallet first. `quantityBase` is the face
 * value (notional) in dUSDC base units; the contract charges the premium itself.
 */
export interface MintPositionParams {
  telegramId: string;
  password: string;
  predictObjectId: string;
  managerObjectId: string;
  oracleId: string;
  expiryMs: number;
  strikeDollars: number;
  isUp: boolean;
  quantityBase: number;
  depositBase: bigint;
  feeBase?: bigint; // optional broker fee, split to treasury in the same PTB
  treasuryAddress?: string;
}

export interface MintRangePositionParams {
  telegramId: string;
  password: string;
  predictObjectId: string;
  managerObjectId: string;
  oracleId: string;
  expiryMs: number;
  lowerStrikeDollars: number;
  upperStrikeDollars: number;
  quantityBase: number;
  depositBase: bigint;
  feeBase?: bigint; // optional broker fee, split to treasury in the same PTB
  treasuryAddress?: string;
}

/**
 * Redeem a binary position back into the PredictManager balance. When `settled`
 * is true the protocol's permissionless redeem path is used.
 */
export interface RedeemPositionParams {
  telegramId: string;
  password: string;
  predictObjectId: string;
  managerObjectId: string;
  oracleId: string;
  expiryMs: number;
  strikeDollars: number;
  isUp: boolean;
  quantityBase: number;
  settled: boolean;
}

export interface RedeemRangePositionParams {
  telegramId: string;
  password: string;
  predictObjectId: string;
  managerObjectId: string;
  oracleId: string;
  expiryMs: number;
  lowerStrikeDollars: number;
  upperStrikeDollars: number;
  quantityBase: number;
}

export interface CreateManagerResult {
  digest: string;
  success: boolean;
  managerId?: string;
  error?: string;
}

export interface TransactionResult {
  digest: string;
  success: boolean;
  effects?: any;
  objectChanges?: any;
  error?: string;
}

export interface ExplorerLink {
  transaction: string;
  object: string;
  address: string;
}
