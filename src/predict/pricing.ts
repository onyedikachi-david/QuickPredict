// Mock pricing engine - simulates SVI-based binary option pricing
// In production, this would compute from GET /oracles/:oracle_id/svi/latest

export interface PricePreview {
  premium_dusdc: number;
  notional_dusdc: number;
  net_if_correct: number;
  implied_prob: number;
}

export function calculatePremium(
  strike: number,
  currentPrice: number,
  minutesToExpiry: number,
  notional: number,
  isUp: boolean
): PricePreview {
  // Simplified Black-Scholes-inspired pricing
  // Real implementation would use SVI parameters from the oracle
  
  const priceDiff = strike - currentPrice;
  const priceDiffPct = priceDiff / currentPrice;
  
  // Base probability from distance to strike
  let baseProbability: number;
  
  if (isUp) {
    // For calls: lower strike = higher probability
    baseProbability = 0.5 - priceDiffPct * 10;
  } else {
    // For puts: higher strike = higher probability
    baseProbability = 0.5 + priceDiffPct * 10;
  }
  
  // Adjust for time decay - shorter time = more extreme probabilities
  const timeDecayFactor = Math.exp(-minutesToExpiry / 30);
  baseProbability = 0.5 + (baseProbability - 0.5) * (1 - timeDecayFactor * 0.3);
  
  // Clamp between 5% and 95%
  const impliedProb = Math.max(0.05, Math.min(0.95, baseProbability));
  
  // Premium is implied probability * notional (in base units)
  const premiumDusdc = Math.floor(impliedProb * notional);
  const netIfCorrect = notional - premiumDusdc;
  
  return {
    premium_dusdc: premiumDusdc,
    notional_dusdc: notional,
    net_if_correct: netIfCorrect,
    implied_prob: impliedProb,
  };
}

export function calculateRangePremium(
  lowerStrike: number,
  upperStrike: number,
  currentPrice: number,
  minutesToExpiry: number,
  notional: number
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
  const impliedProb = Math.max(
    0.05,
    Math.min(0.95, lowerProbability - upperProbability)
  );
  const premiumDusdc = Math.floor(impliedProb * notional);

  return {
    premium_dusdc: premiumDusdc,
    notional_dusdc: notional,
    net_if_correct: notional - premiumDusdc,
    implied_prob: impliedProb,
  };
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
