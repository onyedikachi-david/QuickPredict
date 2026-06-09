// Single source of truth for network-specific configuration.
//
// Everything that differs between testnet and mainnet — RPC/gRPC endpoints,
// Predict package/object IDs, the dUSDC asset, the DeepBook pool, the explorer —
// is resolved here, keyed by one NETWORK env. No network assumptions are baked
// in anywhere else. Moving to mainnet (when DeepBook Predict deploys there)
// becomes: populate the mainnet block + flip NETWORK — a config change, not code.

export type Network = "testnet" | "mainnet";

export interface NetworkConfig {
  network: Network;
  endpoints: {
    rpc: string; // JSON-RPC (execute + DeepBook SDK; deprecated, sunset 2026-07-31)
    grpc: string; // gRPC (reads + simulation; the post-JSON-RPC path)
    predictServer: string; // Predict indexer REST
    explorerBase: string; // SuiScan base, network-scoped
  };
  predict: { packageId: string; objectId: string; registryId: string };
  dusdc: { type: string; currencyId: string; decimals: number };
  deepbook: { suiUsdcPoolKey: string };
  fee: { bps: number; treasury: string };
}

const env = (name: string): string | undefined => process.env[name];

// Frontend trade fee — a broker commission on the premium, routed to a treasury
// wallet inside the mint PTB (our Polymarket-taker-fee analog). OFF by default
// (bps = 0): enable by setting BOTH TRADE_FEE_BPS (>0, basis points) and
// TREASURY_ADDRESS. Capped at 500 bps (5%) as a fat-finger guard, and ignored
// entirely if no treasury is configured — so a stray bps can never charge a fee
// with nowhere to send it.
function readFeeConfig(): { bps: number; treasury: string } {
  const treasury = (env("TREASURY_ADDRESS") || "").trim();
  let bps = parseInt(env("TRADE_FEE_BPS") || "0", 10);
  if (!Number.isFinite(bps) || bps < 0) bps = 0;
  if (bps > 500) bps = 500;
  if (!treasury) bps = 0;
  return { bps, treasury };
}

const TESTNET: NetworkConfig = {
  network: "testnet",
  endpoints: {
    rpc: env("SUI_RPC_URL") || "https://fullnode.testnet.sui.io:443",
    grpc: env("SUI_GRPC_URL") || "https://fullnode.testnet.sui.io:443",
    predictServer: env("PREDICT_SERVER_URL") || "https://predict-server.testnet.mystenlabs.com",
    explorerBase: "https://suiscan.xyz/testnet",
  },
  predict: {
    packageId: env("PREDICT_PACKAGE_ID") || "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138",
    objectId: env("PREDICT_OBJECT_ID") || "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a",
    registryId: env("PREDICT_REGISTRY_ID") || "0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64",
  },
  dusdc: {
    type: env("DUSDC_TYPE") || "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC",
    currencyId: env("DUSDC_CURRENCY_ID") || "0xf3000dff421833d4bb8ed58fac146d691a3aaba2785aa1989af65a7089ca3e9c",
    decimals: parseInt(env("DUSDC_DECIMALS") || "6", 10),
  },
  deepbook: { suiUsdcPoolKey: "SUI_DBUSDC" },
  fee: readFeeConfig(),
};

// DeepBook Predict is NOT on mainnet yet (IDs unknown). This is a guarded
// placeholder so the eventual move is config-only. Values come from env.
const MAINNET: NetworkConfig = {
  network: "mainnet",
  endpoints: {
    rpc: env("SUI_RPC_URL") || "https://fullnode.mainnet.sui.io:443",
    grpc: env("SUI_GRPC_URL") || "https://fullnode.mainnet.sui.io:443",
    predictServer: env("PREDICT_SERVER_URL") || "",
    explorerBase: "https://suiscan.xyz/mainnet",
  },
  predict: {
    packageId: env("PREDICT_PACKAGE_ID") || "",
    objectId: env("PREDICT_OBJECT_ID") || "",
    registryId: env("PREDICT_REGISTRY_ID") || "",
  },
  dusdc: {
    type: env("DUSDC_TYPE") || "",
    currencyId: env("DUSDC_CURRENCY_ID") || "",
    decimals: parseInt(env("DUSDC_DECIMALS") || "6", 10),
  },
  deepbook: { suiUsdcPoolKey: "SUI_USDC" },
  fee: readFeeConfig(),
};

export function getNetwork(): Network {
  const n = (env("NETWORK") || "testnet").toLowerCase();
  if (n !== "testnet" && n !== "mainnet") {
    throw new Error(`Unsupported NETWORK '${n}' — use 'testnet' or 'mainnet'`);
  }
  return n;
}

let cached: NetworkConfig | null = null;

export function getNetworkConfig(): NetworkConfig {
  if (cached) return cached;
  const network = getNetwork();
  const cfg = network === "mainnet" ? MAINNET : TESTNET;

  // Fail-fast: DeepBook Predict is testnet-only today. Refuse to run a
  // half-configured mainnet rather than silently misbehave.
  if (network === "mainnet" && (!cfg.predict.packageId || !cfg.predict.objectId)) {
    throw new Error(
      "DeepBook Predict is not yet deployed on mainnet. Set PREDICT_* mainnet IDs when it launches, or run with NETWORK=testnet."
    );
  }

  cached = cfg;
  return cfg;
}

// Capitalized network name for user-facing messages ("Testnet" / "Mainnet").
export function networkLabel(): string {
  return getNetworkConfig().network === "mainnet" ? "Mainnet" : "Testnet";
}

// Test/util escape hatch.
export function clearNetworkConfigCache(): void {
  cached = null;
}
