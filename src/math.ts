/**
 * @module math
 *
 * Pure off-chain bonding curve math — mirrors the Rust program's math.rs exactly.
 *
 * All functions are pure: no I/O, no async, no side effects. They operate on
 * bigint values to match the on-chain u64/u128 precision. The only rounding is
 * integer division, same as the Rust program.
 *
 * Use these for:
 *   1. Simulating trades before sending them (quote UI)
 *   2. Computing slippage tolerance (minTokensOut, minSolOut)
 *   3. Building price charts from historical event data
 *   4. Testing — compare against actual on-chain results
 *
 * @example
 * ```ts
 * import { BondingMath } from "@pulseonchain/sdk/math";
 *
 * const tokensOut = BondingMath.calcTokensOut(
 *   1_073_000_000_000_000n, // virtualTokenReserves
 *   30_000_000_000n,        // virtualSolReserves (30 SOL)
 *   990_000_000n,           // netSol (1 SOL - 1% fee)
 * );
 * console.log(`Tokens out: ${tokensOut}`);
 * ```
 */

// ─── Constants (mirrors consts.rs) ───────────────────────────────────────────

export const INITIAL_VIRTUAL_SOL    = 30_000_000_000n;         // 30 SOL
export const INITIAL_VIRTUAL_TOKEN  = 1_073_000_000_000_000n;  // ~1.073B tokens
export const BONDING_SUPPLY         = 700_000_000_000_000n;    // 700M tokens
export const RESERVE_SUPPLY         = 97_052_391_304_347n;     // ~97M tokens
export const LP_RESERVE_SUPPLY      = 300_000_000_000_000n;    // 300M tokens
export const GRADUATION_THRESHOLD   = 85_000_000_000n;         // 85 SOL
export const TOTAL_FEE_BPS          = 100n;                    // 1%
export const PLATFORM_SHARE_BPS     = 75n;                     // 75% of fee → platform
export const CREATOR_SHARE_BPS      = 25n;                     // 25% of fee → creator
export const REWARD_PRECISION       = 1_000_000_000_000n;      // 1e12
export const TOKEN_DECIMALS         = 6;

// ─── Buy / Sell Pricing ───────────────────────────────────────────────────────

export const BondingMath = {
  /**
   * Calculate tokens out for a buy.
   *
   * Formula: tokensOut = (virtualTokenReserves * netSol) / (virtualSolReserves + netSol)
   *
   * @param virtualTokenReserves - current virtual token reserves (bigint)
   * @param virtualSolReserves   - current virtual SOL reserves (bigint, lamports)
   * @param netSol               - SOL entering the curve after fees (bigint, lamports)
   * @returns tokens the buyer receives (bigint, raw units)
   */
  calcTokensOut(
    virtualTokenReserves: bigint,
    virtualSolReserves: bigint,
    netSol: bigint,
  ): bigint {
    if (netSol <= 0n || virtualTokenReserves <= 0n || virtualSolReserves <= 0n) return 0n;
    return (virtualTokenReserves * netSol) / (virtualSolReserves + netSol);
  },

  /**
   * Calculate gross SOL out for a sell.
   *
   * Formula: solOut = (virtualSolReserves * tokensIn) / (virtualTokenReserves + tokensIn)
   *
   * @param virtualSolReserves   - current virtual SOL reserves (bigint, lamports)
   * @param virtualTokenReserves - current virtual token reserves (bigint)
   * @param tokensIn             - tokens being sold (bigint, raw units)
   * @returns gross SOL output before fees (bigint, lamports)
   */
  calcSolOut(
    virtualSolReserves: bigint,
    virtualTokenReserves: bigint,
    tokensIn: bigint,
  ): bigint {
    if (tokensIn <= 0n || virtualSolReserves <= 0n || virtualTokenReserves <= 0n) return 0n;
    return (virtualSolReserves * tokensIn) / (virtualTokenReserves + tokensIn);
  },

  /**
   * Calculate the fee split from a gross SOL amount.
   *
   * Returns { totalFee, platformFee, creatorFee } all in lamports (bigint).
   */
  calcFees(
    grossSol: bigint,
    feeBps: bigint = TOTAL_FEE_BPS,
    platformShareBps: bigint = PLATFORM_SHARE_BPS,
  ): { totalFee: bigint; platformFee: bigint; creatorFee: bigint } {
    const totalFee = (grossSol * feeBps) / 10_000n;
    const platformFee = (totalFee * platformShareBps) / 100n;
    const creatorFee = totalFee - platformFee;
    return { totalFee, platformFee, creatorFee };
  },

  /**
   * Full buy simulation including fee deduction.
   *
   * Mirrors what happens in the buy() instruction:
   *   1. Deduct fee from solAmount
   *   2. Apply constant-product formula to get tokensOut
   *   3. Update virtual reserves
   *   4. Check graduation
   */
  simulateBuy(
    virtualSolReserves: bigint,
    virtualTokenReserves: bigint,
    realSolReserves: bigint,
    realTokenReserves: bigint,
    reserveTokensRemaining: bigint,
    solAmount: bigint,
    feeBps: bigint = TOTAL_FEE_BPS,
    platformShareBps: bigint = PLATFORM_SHARE_BPS,
    graduationThreshold: bigint = GRADUATION_THRESHOLD,
  ): BuySimResult {
    const { totalFee, platformFee, creatorFee } = BondingMath.calcFees(solAmount, feeBps, platformShareBps);
    const netSol = solAmount - totalFee;
    const tokensOut = BondingMath.calcTokensOut(virtualTokenReserves, virtualSolReserves, netSol);

    const pricePerTokenLamports = tokensOut > 0n
      ? Number(netSol) / Number(tokensOut)
      : 0;

    const spotPriceBefore = Number(virtualSolReserves) / Number(virtualTokenReserves);
    const newVS = virtualSolReserves + netSol;
    const newVT = virtualTokenReserves - tokensOut;
    const spotPriceAfter = newVT > 0n ? Number(newVS) / Number(newVT) : 0;

    const priceImpactPct = spotPriceBefore > 0
      ? ((spotPriceAfter - spotPriceBefore) / spotPriceBefore) * 100
      : 0;

    const newRealSol = realSolReserves + netSol;
    const willGraduate = newRealSol >= graduationThreshold;

    // Determine if reserve tokens need to be tapped
    let fromBonding: bigint;
    let fromReserve: bigint;
    if (tokensOut <= realTokenReserves) {
      fromBonding = tokensOut;
      fromReserve = 0n;
    } else {
      fromBonding = realTokenReserves;
      fromReserve = tokensOut - realTokenReserves;
    }

    return {
      tokensOut,
      pricePerTokenLamports,
      priceImpactPct,
      platformFee,
      creatorFee,
      totalFee,
      netSol,
      willGraduate,
      solToGraduationAfter: willGraduate ? 0n : graduationThreshold - newRealSol,
      newVirtualSolReserves: newVS,
      newVirtualTokenReserves: newVT,
      newSpotPriceSol: spotPriceAfter / 1e9, // convert from lamports
      fromBonding,
      fromReserve,
    };
  },

  /**
   * Full sell simulation including fee deduction.
   *
   * Mirrors what happens in the sell() instruction:
   *   1. Calculate gross SOL from curve
   *   2. Deduct fee from gross SOL
   *   3. Net SOL goes to seller
   */
  simulateSell(
    virtualSolReserves: bigint,
    virtualTokenReserves: bigint,
    realSolReserves: bigint,
    tokenAmount: bigint,
    feeBps: bigint = TOTAL_FEE_BPS,
    platformShareBps: bigint = PLATFORM_SHARE_BPS,
  ): SellSimResult {
    const solOutGross = BondingMath.calcSolOut(virtualSolReserves, virtualTokenReserves, tokenAmount);

    if (solOutGross > realSolReserves) {
      throw new Error(`Insufficient pool SOL: need ${solOutGross} but pool has ${realSolReserves}`);
    }

    const { totalFee, platformFee, creatorFee } = BondingMath.calcFees(solOutGross, feeBps, platformShareBps);
    const netSolToUser = solOutGross - totalFee;

    const spotPriceBefore = Number(virtualSolReserves) / Number(virtualTokenReserves);
    const newVS = virtualSolReserves - solOutGross;
    const newVT = virtualTokenReserves + tokenAmount;
    const spotPriceAfter = Number(newVS) / Number(newVT);

    const priceImpactPct = spotPriceBefore > 0
      ? ((spotPriceBefore - spotPriceAfter) / spotPriceBefore) * 100
      : 0;

    return {
      solOutGross,
      netSolToUser,
      platformFee,
      creatorFee,
      totalFee,
      pricePerTokenLamports: tokenAmount > 0n ? Number(solOutGross) / Number(tokenAmount) : 0,
      priceImpactPct,
      newVirtualSolReserves: newVS,
      newVirtualTokenReserves: newVT,
      newSpotPriceSol: spotPriceAfter / 1e9,
    };
  },

  // ─── Graduation Math ──────────────────────────────────────────────────────

  /** SOL still needed to reach the graduation threshold (lamports). */
  solToGraduation(
    realSolReserves: bigint,
    threshold: bigint = GRADUATION_THRESHOLD,
  ): bigint {
    return realSolReserves >= threshold ? 0n : threshold - realSolReserves;
  },

  /** Graduation progress as a percentage (0.0 – 100.0). */
  graduationProgressPct(
    realSolReserves: bigint,
    threshold: bigint = GRADUATION_THRESHOLD,
  ): number {
    if (threshold === 0n) return 100;
    const bps = (realSolReserves * 10_000n) / threshold;
    return Math.min(Number(bps) / 100, 100);
  },

  // ─── Price ────────────────────────────────────────────────────────────────

  /**
   * Spot price in SOL per token (human-readable, NOT lamports).
   *
   * spot_price_sol = (virtual_sol_reserves / 1e9) / (virtual_token_reserves / 10^decimals)
   */
  spotPriceSol(
    virtualSolReserves: bigint,
    virtualTokenReserves: bigint,
    tokenDecimals: number = TOKEN_DECIMALS,
  ): number {
    if (virtualTokenReserves === 0n) return 0;
    const solFloat = Number(virtualSolReserves) / 1e9;
    const tokFloat = Number(virtualTokenReserves) / Math.pow(10, tokenDecimals);
    return solFloat / tokFloat;
  },

  /**
   * Market cap in SOL based on spot price and total supply.
   */
  marketCapSol(
    virtualSolReserves: bigint,
    virtualTokenReserves: bigint,
    totalSupply: bigint = BONDING_SUPPLY + RESERVE_SUPPLY + LP_RESERVE_SUPPLY,
    tokenDecimals: number = TOKEN_DECIMALS,
  ): number {
    const price = BondingMath.spotPriceSol(virtualSolReserves, virtualTokenReserves, tokenDecimals);
    const supply = Number(totalSupply) / Math.pow(10, tokenDecimals);
    return price * supply;
  },

  // ─── Slippage Helpers ─────────────────────────────────────────────────────

  /**
   * Apply a slippage tolerance to a quote result to get minTokensOut.
   *
   * @param tokensOut - Expected tokens out from simulateBuy
   * @param slippageBps - Tolerance in basis points (100 = 1%)
   * @returns Minimum tokens to accept (pass as minTokensOut to buy())
   */
  applySlippageToBuy(tokensOut: bigint, slippageBps: number): bigint {
    return (tokensOut * BigInt(10_000 - slippageBps)) / 10_000n;
  },

  /**
   * Apply a slippage tolerance to a sell quote to get minSolOut.
   *
   * @param solOut - Expected net SOL out from simulateSell
   * @param slippageBps - Tolerance in basis points (100 = 1%)
   * @returns Minimum SOL to accept (pass as minSolOut to sell())
   */
  applySlippageToSell(solOut: bigint, slippageBps: number): bigint {
    return (solOut * BigInt(10_000 - slippageBps)) / 10_000n;
  },

  // ─── Staker Rewards ───────────────────────────────────────────────────────

  /**
   * Calculate pending SOL rewards for a staker.
   * Matches the Rust pending_rewards() function exactly.
   */
  pendingRewards(
    accumulatedRewardPerToken: bigint,
    rewardDebt: bigint,
    amountStaked: bigint,
  ): bigint {
    return ((accumulatedRewardPerToken - rewardDebt) * amountStaked) / REWARD_PRECISION;
  },

  // ─── Formatting ───────────────────────────────────────────────────────────

  /**
   * Format a raw token amount to human-readable with decimal places.
   */
  formatTokenAmount(rawAmount: bigint, decimals: number = TOKEN_DECIMALS): string {
    const divisor = BigInt(Math.pow(10, decimals));
    const whole = rawAmount / divisor;
    const fraction = rawAmount % divisor;
    const fractionStr = fraction.toString().padStart(decimals, "0");
    return `${whole.toLocaleString()}.${fractionStr}`;
  },

  /**
   * Format lamports as SOL with configurable decimal places.
   */
  formatSol(lamports: bigint, decimals: number = 4): string {
    const sol = Number(lamports) / 1e9;
    return sol.toFixed(decimals);
  },
};

// ─── Simulation Result Types ──────────────────────────────────────────────────

export interface BuySimResult {
  /** Tokens the buyer will receive */
  tokensOut: bigint;
  /** Price per token in lamports */
  pricePerTokenLamports: number;
  /** Price impact as a percentage */
  priceImpactPct: number;
  /** Platform fee (0.75% of solAmount) */
  platformFee: bigint;
  /** Creator fee (0.25% of solAmount) */
  creatorFee: bigint;
  /** Total fee */
  totalFee: bigint;
  /** Net SOL entering the curve (solAmount - totalFee) */
  netSol: bigint;
  /** Whether this buy graduates the token */
  willGraduate: boolean;
  /** SOL still needed after this buy (0n if graduating) */
  solToGraduationAfter: bigint;
  /** New virtual SOL reserves */
  newVirtualSolReserves: bigint;
  /** New virtual token reserves */
  newVirtualTokenReserves: bigint;
  /** New spot price in SOL per token */
  newSpotPriceSol: number;
  /** Tokens filled from bonding supply */
  fromBonding: bigint;
  /** Tokens filled from reserve (only when bonding exhausted) */
  fromReserve: bigint;
}

export interface SellSimResult {
  /** Gross SOL from the curve before fees */
  solOutGross: bigint;
  /** Net SOL the seller receives after fees */
  netSolToUser: bigint;
  /** Platform fee */
  platformFee: bigint;
  /** Creator fee */
  creatorFee: bigint;
  /** Total fee */
  totalFee: bigint;
  /** Price per token in lamports */
  pricePerTokenLamports: number;
  /** Price impact as a percentage */
  priceImpactPct: number;
  /** New virtual SOL reserves */
  newVirtualSolReserves: bigint;
  /** New virtual token reserves */
  newVirtualTokenReserves: bigint;
  /** New spot price in SOL per token */
  newSpotPriceSol: number;
}
