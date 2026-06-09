import type { Oracle, ServerAskBounds, ServerOracleSvi } from "./types";

export interface PricePreview {
  premium_dusdc: number;
  notional_dusdc: number;
  net_if_correct: number;
  implied_prob: number;
  pricing_model: "onchain" | "svi" | "fallback";
  ask_bounds_applied: boolean;
  redeem_payout_dusdc?: number;
}

const SVI_SCALE = 1_000_000_000;
const MIN_PROBABILITY = 0.01;
const MAX_PROBABILITY = 0.99;

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(MIN_PROBABILITY, Math.min(MAX_PROBABILITY, value));
}

function normalizeAskBoundValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const probability = value > 1 ? value / SVI_SCALE : value;
  return Math.max(0, Math.min(1, probability));
}

function parseAskBounds(bounds: ServerAskBounds | null): { min?: number; max?: number } | null {
  if (!bounds) return null;

  if (Array.isArray(bounds)) {
    const min = normalizeAskBoundValue(bounds[0]);
    const max = normalizeAskBoundValue(bounds[1]);
    if (min === undefined && max === undefined) return null;
    if (min !== undefined && max !== undefined && min > max) return null;
    return { min, max };
  }

  const min =
    normalizeAskBoundValue(bounds.min_ask_price) ??
    normalizeAskBoundValue(bounds.minAskPrice) ??
    normalizeAskBoundValue(bounds.min_ask) ??
    normalizeAskBoundValue(bounds.minAsk) ??
    normalizeAskBoundValue(bounds.min);
  const max =
    normalizeAskBoundValue(bounds.max_ask_price) ??
    normalizeAskBoundValue(bounds.maxAskPrice) ??
    normalizeAskBoundValue(bounds.max_ask) ??
    normalizeAskBoundValue(bounds.maxAsk) ??
    normalizeAskBoundValue(bounds.max);

  if (min === undefined && max === undefined) return null;
  if (min !== undefined && max !== undefined && min > max) return null;
  return { min, max };
}

function applyAskBounds(probability: number, bounds: ServerAskBounds | null): {
  probability: number;
  applied: boolean;
} {
  const parsed = parseAskBounds(bounds);
  if (!parsed) return { probability, applied: false };

  let bounded = probability;
  if (parsed.min !== undefined) bounded = Math.max(parsed.min, bounded);
  if (parsed.max !== undefined) bounded = Math.min(parsed.max, bounded);

  return {
    probability: bounded,
    applied: bounded !== probability,
  };
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf =
    sign *
    (1 -
      (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
        t *
        Math.exp(-x * x)));

  return 0.5 * (1 + erf);
}

function signedScaled(value: number, negative: boolean): number {
  const scaled = value / SVI_SCALE;
  return negative ? -scaled : scaled;
}

function sviTotalVariance(strike: number, forward: number, svi: ServerOracleSvi): number | null {
  if (strike <= 0 || forward <= 0) return null;

  const logMoneyness = Math.log(strike / forward);
  const a = svi.a / SVI_SCALE;
  const b = svi.b / SVI_SCALE;
  const rho = signedScaled(svi.rho, svi.rho_negative);
  const m = signedScaled(svi.m, svi.m_negative);
  const sigma = svi.sigma / SVI_SCALE;
  const centered = logMoneyness - m;
  const variance = a + b * (rho * centered + Math.sqrt(centered * centered + sigma * sigma));

  if (!Number.isFinite(variance) || variance <= 0) return null;
  return variance;
}

function calculateSviProbability(
  strike: number,
  oracle: Oracle,
  isUp: boolean
): number | null {
  const svi = oracle.latest_svi;
  const forward = oracle.forward_price || oracle.current_price;

  if (!svi || !forward) return null;

  const variance = sviTotalVariance(strike, forward, svi);
  if (!variance) return null;

  const sqrtVariance = Math.sqrt(variance);
  const d2 = (Math.log(forward / strike) - 0.5 * variance) / sqrtVariance;
  const upProbability = normalCdf(d2);

  return clampProbability(isUp ? upProbability : 1 - upProbability);
}

function previewFromProbability(
  probability: number,
  notional: number,
  pricingModel: PricePreview["pricing_model"],
  askBounds: ServerAskBounds | null = null
): PricePreview {
  const bounded = applyAskBounds(probability, askBounds);
  const impliedProb = clampProbability(bounded.probability);
  const premiumDusdc = Math.floor(impliedProb * notional);

  return {
    premium_dusdc: premiumDusdc,
    notional_dusdc: notional,
    net_if_correct: notional - premiumDusdc,
    implied_prob: impliedProb,
    pricing_model: pricingModel,
    ask_bounds_applied: bounded.applied,
  };
}

export function previewFromOnchainAmounts(
  mintCostDusdc: number,
  quantityDusdc: number,
  redeemPayoutDusdc: number
): PricePreview {
  return {
    premium_dusdc: mintCostDusdc,
    notional_dusdc: quantityDusdc,
    net_if_correct: quantityDusdc - mintCostDusdc,
    implied_prob: clampProbability(mintCostDusdc / quantityDusdc),
    pricing_model: "onchain",
    ask_bounds_applied: false,
    redeem_payout_dusdc: redeemPayoutDusdc,
  };
}

export function calculatePremium(
  strike: number,
  currentPrice: number,
  minutesToExpiry: number,
  notional: number,
  isUp: boolean,
  askBounds: ServerAskBounds | null = null
): PricePreview {
  const priceDiff = strike - currentPrice;
  const priceDiffPct = priceDiff / currentPrice;

  let baseProbability: number;

  if (isUp) {
    baseProbability = 0.5 - priceDiffPct * 10;
  } else {
    baseProbability = 0.5 + priceDiffPct * 10;
  }

  const timeDecayFactor = Math.exp(-minutesToExpiry / 30);
  baseProbability = 0.5 + (baseProbability - 0.5) * (1 - timeDecayFactor * 0.3);

  return previewFromProbability(baseProbability, notional, "fallback", askBounds);
}

export function calculatePremiumFromOracle(
  strike: number,
  oracle: Oracle,
  minutesToExpiry: number,
  notional: number,
  isUp: boolean
): PricePreview {
  const sviProbability = calculateSviProbability(strike, oracle, isUp);

  if (sviProbability !== null) {
    return previewFromProbability(sviProbability, notional, "svi", oracle.ask_bounds);
  }

  return calculatePremium(
    strike,
    oracle.current_price,
    minutesToExpiry,
    notional,
    isUp,
    oracle.ask_bounds
  );
}

export function calculateRangePremium(
  lowerStrike: number,
  upperStrike: number,
  currentPrice: number,
  minutesToExpiry: number,
  notional: number,
  askBounds: ServerAskBounds | null = null
): PricePreview {
  const lowerProbability = calculatePremium(
    lowerStrike,
    currentPrice,
    minutesToExpiry,
    notional,
    true
  ).implied_prob;
  const upperProbability = calculatePremium(
    upperStrike,
    currentPrice,
    minutesToExpiry,
    notional,
    true
  ).implied_prob;
  const impliedProb = clampProbability(lowerProbability - upperProbability);

  return previewFromProbability(impliedProb, notional, "fallback", askBounds);
}

export function calculateRangePremiumFromOracle(
  lowerStrike: number,
  upperStrike: number,
  oracle: Oracle,
  minutesToExpiry: number,
  notional: number
): PricePreview {
  const lowerProbability = calculateSviProbability(lowerStrike, oracle, true);
  const upperProbability = calculateSviProbability(upperStrike, oracle, true);

  if (lowerProbability !== null && upperProbability !== null) {
    return previewFromProbability(
      lowerProbability - upperProbability,
      notional,
      "svi",
      oracle.ask_bounds
    );
  }

  return calculateRangePremium(
    lowerStrike,
    upperStrike,
    oracle.current_price,
    minutesToExpiry,
    notional,
    oracle.ask_bounds
  );
}

export function formatDusdc(amount: number): string {
  return (amount / 1_000_000).toFixed(2);
}

export function parseDusdc(amount: number): number {
  return Math.floor(amount * 1_000_000);
}

export function formatPrice(price: number): string {
  return price.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatPercentage(value: number): string {
  return (value * 100).toFixed(1);
}

// Human-readable time-to-expiry: minutes under an hour, hours (+min) under a
// day, days (+hours) beyond — capped at two units so it stays compact.
//   45 → "45m" · 90 → "1h 30m" · 1061 → "17h 41m" · 5381 → "3d 18h"
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
  }
  const d = Math.floor(m / 1440);
  const h = Math.round((m % 1440) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}
