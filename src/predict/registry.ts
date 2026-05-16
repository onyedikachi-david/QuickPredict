// Mock oracle registry - will be replaced with real predict-server API calls
export interface Oracle {
  id: string;
  asset_symbol: string;
  current_price: number;
  expiry_ts: number;
  status: "active" | "pending_settlement" | "settled";
  settlement_price?: number;
}

// Mock data - simulates multiple active oracles
const mockOracles: Oracle[] = [
  {
    id: "oracle_btc_5min",
    asset_symbol: "BTC",
    current_price: 70234,
    expiry_ts: Date.now() + 5 * 60 * 1000,
    status: "active",
  },
  {
    id: "oracle_btc_10min",
    asset_symbol: "BTC",
    current_price: 70234,
    expiry_ts: Date.now() + 10 * 60 * 1000,
    status: "active",
  },
  {
    id: "oracle_btc_30min",
    asset_symbol: "BTC",
    current_price: 70234,
    expiry_ts: Date.now() + 30 * 60 * 1000,
    status: "active",
  },
  {
    id: "oracle_btc_60min",
    asset_symbol: "BTC",
    current_price: 70234,
    expiry_ts: Date.now() + 60 * 60 * 1000,
    status: "active",
  },
  {
    id: "oracle_eth_5min",
    asset_symbol: "ETH",
    current_price: 3456,
    expiry_ts: Date.now() + 5 * 60 * 1000,
    status: "active",
  },
  {
    id: "oracle_eth_10min",
    asset_symbol: "ETH",
    current_price: 3456,
    expiry_ts: Date.now() + 10 * 60 * 1000,
    status: "active",
  },
  {
    id: "oracle_sol_10min",
    asset_symbol: "SOL",
    current_price: 145.67,
    expiry_ts: Date.now() + 10 * 60 * 1000,
    status: "active",
  },
];

let oracleRegistry: Oracle[] = [...mockOracles];

export function refreshOracleRegistry(): void {
  // In production, this would call:
  // GET https://predict-server.testnet.mystenlabs.com/predicts/:predict_id/oracles
  
  // For now, update mock data with fresh expiry times
  oracleRegistry = mockOracles.map((oracle) => ({
    ...oracle,
    expiry_ts: Date.now() + getMinutesFromOracleId(oracle.id) * 60 * 1000,
    current_price: oracle.current_price + (Math.random() - 0.5) * 100, // Simulate price movement
  }));
}

function getMinutesFromOracleId(oracleId: string): number {
  const match = oracleId.match(/(\d+)min/);
  return match ? parseInt(match[1]) : 10;
}

export function getActiveOracles(): Oracle[] {
  return oracleRegistry.filter((o) => o.status === "active");
}

export function getOraclesByAsset(assetSymbol: string): Oracle[] {
  return oracleRegistry.filter(
    (o) => o.asset_symbol === assetSymbol && o.status === "active"
  );
}

export function getAvailableAssets(): string[] {
  const assets = new Set(
    oracleRegistry
      .filter((o) => o.status === "active")
      .map((o) => o.asset_symbol)
  );
  return Array.from(assets);
}

export function findNearestOracle(
  assetSymbol: string,
  targetMinutes: number
): Oracle | null {
  const oracles = getOraclesByAsset(assetSymbol);
  if (oracles.length === 0) return null;

  // Find oracle with expiry closest to target
  return oracles.reduce((nearest, current) => {
    const currentMinutes = (current.expiry_ts - Date.now()) / (60 * 1000);
    const nearestMinutes = (nearest.expiry_ts - Date.now()) / (60 * 1000);

    return Math.abs(currentMinutes - targetMinutes) <
      Math.abs(nearestMinutes - targetMinutes)
      ? current
      : nearest;
  });
}

export function getOracleById(oracleId: string): Oracle | null {
  return oracleRegistry.find((o) => o.id === oracleId) || null;
}

export function getCurrentPrice(assetSymbol: string): number | null {
  const oracle = oracleRegistry.find((o) => o.asset_symbol === assetSymbol);
  return oracle?.current_price || null;
}

// Initialize registry
refreshOracleRegistry();

// Refresh every 2 minutes as per PRD
setInterval(refreshOracleRegistry, 2 * 60 * 1000);
