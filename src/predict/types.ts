export type OracleStatus = "active" | "pending_settlement" | "settled";

export interface ServerOracle {
  predict_id: string;
  oracle_id: string;
  oracle_cap_id: string;
  underlying_asset: string;
  expiry: number;
  min_strike: number;
  tick_size: number;
  status: OracleStatus;
  activated_at: number | null;
  settlement_price: number | null;
  settled_at: number | null;
  created_checkpoint: number;
}

export interface ServerOraclePrice {
  event_digest: string;
  digest: string;
  sender: string;
  checkpoint: number;
  checkpoint_timestamp_ms: number;
  tx_index: number;
  event_index: number;
  package: string;
  oracle_id: string;
  spot: number;
  forward: number;
  onchain_timestamp: number;
}

export interface ServerOracleSvi {
  event_digest: string;
  digest: string;
  sender: string;
  checkpoint: number;
  checkpoint_timestamp_ms: number;
  tx_index: number;
  event_index: number;
  package: string;
  oracle_id: string;
  a: number;
  b: number;
  rho: number;
  rho_negative: boolean;
  m: number;
  m_negative: boolean;
  sigma: number;
  onchain_timestamp: number;
}

export type ServerAskBounds =
  | {
      min?: number;
      max?: number;
      min_ask?: number;
      max_ask?: number;
      min_ask_price?: number;
      max_ask_price?: number;
      minAsk?: number;
      maxAsk?: number;
      minAskPrice?: number;
      maxAskPrice?: number;
      [key: string]: unknown;
    }
  | [number, number];

export interface ServerOracleState {
  oracle: ServerOracle;
  latest_price: ServerOraclePrice | null;
  latest_svi: ServerOracleSvi | null;
  ask_bounds: ServerAskBounds | null;
}

export interface Oracle {
  id: string;
  predict_id: string;
  asset_symbol: string;
  current_price: number;
  forward_price: number | null;
  expiry_ts: number;
  min_strike: number;
  tick_size: number;
  status: OracleStatus;
  settlement_price?: number;
  latest_price: ServerOraclePrice | null;
  latest_svi: ServerOracleSvi | null;
  ask_bounds: ServerAskBounds | null;
  stale: boolean;
  fetched_at: number;
}

export interface OracleRegistrySnapshot {
  oracles: Oracle[];
  stale: boolean;
  fetchedAt: number;
}

export interface PredictState {
  predict_id: string;
  pricing: any;
  risk: {
    max_total_exposure_pct?: number;
    [key: string]: any;
  } | null;
  trading_paused: boolean | null;
  quote_assets: string[];
}

export interface VaultSummary {
  predict_id: string;
  quote_assets: string[];
  vault_balance: number;
  vault_value: number;
  total_mtm: number;
  total_max_payout: number;
  available_liquidity: number;
  available_withdrawal: number;
  plp_total_supply: number;
  plp_share_price: number;
  utilization: number;
  max_payout_utilization: number;
  net_deposits: number;
  total_supplied: number;
  total_withdrawn: number;
}

