import { Connection, PublicKey } from "@solana/web3.js";
import {
  INITIAL_VIRTUAL_SOL,
  INITIAL_VIRTUAL_TOKEN,
  TOTAL_FEE_BPS,
  PLATFORM_SHARE_BPS,
  TOKEN_DECIMALS,
  GRADUATION_SOL_THRESHOLD,
} from "./constants";
import type { PoolState, BuyQuote, SellQuote, MigrationTarget } from "./types";

/**
 * Pure helper functions for off-chain calculations.
 *
 * These replicate the on-chain math locally so you can show quotes,
 * validate slippage, and build UIs without submitting transactions.
 */

/**
 * Calculate fees from a SOL amount.
 * Splits 1% total: 0.75% platform, 0.25% creator.
 */
export function calcFees(solAmount: bigint): {
  totalFee: bigint;
  platformFee: bigint;
  creatorFee: bigint;
} {
  const totalFee = (solAmount * BigInt(TOTAL_FEE_BPS)) / BigInt(10_000);
  const platformFee = (totalFee * BigInt(PLATFORM_SHARE_BPS)) / BigInt(100);
  const creatorFee = totalFee - platformFee;
  return { totalFee, platformFee, creatorFee };
}

/**
 * Simulate a buy against the constant-product curve.
 *
 * Uses the same formula as the on-chain program:
 *   tokens_out = virtual_tokens * net_sol / (virtual_sol + net_sol)
 *
 * Reserve tokens (97M) are only consumed when the buy exceeds
 * remaining bonding supply in a single transaction.
 */
export function simulateBuy(pool: PoolState, solAmount: bigint): BuyQuote {
  const { totalFee, platformFee, creatorFee } = calcFees(solAmount);
  const netSol = solAmount - totalFee;

  const vt = pool.virtualTokenReserves;
  const vs = pool.virtualSolReserves;
  const s = netSol;

  const tokensOut =
    (vt * s) / (vs + s);

  // Determine source
  const available =
    tokensOut <= pool.realTokenReserves
      ? pool.realTokenReserves
      : pool.realTokenReserves + pool.reserveTokensRemaining;

  if (tokensOut > available) {
    throw new Error(
      `Insufficient pool tokens. Requested ${tokensOut}, available ${available}`
    );
  }

  const newVs = vs + netSol;
  const newVt = vt - tokensOut;
  const oldPrice = Number(vs) / Number(vt);
  const newPrice = Number(newVs) / Number(newVt);
  const pricePerToken = Number(netSol) / Number(tokensOut);
  const priceImpact = ((newPrice - oldPrice) / oldPrice) * 100;

  return {
    tokensOut,
    pricePerToken,
    priceImpact,
    platformFee,
    creatorFee,
    netSol,
  };
}

/**
 * Simulate a sell against the constant-product curve.
 *
 * Uses the same formula as the on-chain program:
 *   sol_out = virtual_sol * tokens_in / (virtual_tokens + tokens_in)
 */
export function simulateSell(pool: PoolState, tokenAmount: bigint): SellQuote {
  const vs = pool.virtualSolReserves;
  const vt = pool.virtualTokenReserves;
  const t = tokenAmount;

  const solOutGross = (vs * t) / (vt + t);

  if (solOutGross > pool.realSolReserves) {
    throw new Error(
      `Insufficient SOL in pool. Requested ${solOutGross}, available ${pool.realSolReserves}`
    );
  }

  const { totalFee, platformFee, creatorFee } = calcFees(solOutGross);
  const netSolToUser = solOutGross - totalFee;

  const newVs = vs - solOutGross;
  const newVt = vt + t;
  const oldPrice = Number(vs) / Number(vt);
  const newPrice = Number(newVs) / Number(newVt);
  const pricePerToken = Number(solOutGross) / Number(t);
  const priceImpact = ((oldPrice - newPrice) / oldPrice) * 100;

  return {
    solOut: solOutGross,
    pricePerToken,
    priceImpact,
    platformFee,
    creatorFee,
    netSolToUser,
  };
}

/**
 * Get the current instantaneous price from virtual reserves.
 * Returns price in lamports per token.
 */
export function getSpotPrice(pool: PoolState): number {
  return Number(pool.virtualSolReserves) / Number(pool.virtualTokenReserves);
}

/**
 * Get the current instantaneous price in SOL per token.
 */
export function getSpotPriceSol(pool: PoolState): number {
  return getSpotPrice(pool) / 1e9;
}

/**
 * Check if a pool is eligible for graduation (≥ 85 SOL raised).
 */
export function isReadyToGraduate(pool: PoolState): boolean {
  return !pool.graduated && pool.realSolReserves >= BigInt(GRADUATION_SOL_THRESHOLD);
}

/**
 * Calculate how much SOL is needed to reach graduation.
 * Returns 0n if already graduated or past threshold.
 */
export function solToGraduation(pool: PoolState): bigint {
  if (pool.graduated) return 0n;
  const threshold = BigInt(GRADUATION_SOL_THRESHOLD);
  return pool.realSolReserves < threshold
    ? threshold - pool.realSolReserves
    : 0n;
}

/**
 * Progress toward graduation as a percentage (0-100).
 */
export function graduationProgress(pool: PoolState): number {
  const threshold = Number(GRADUATION_SOL_THRESHOLD);
  const current = Number(pool.realSolReserves);
  return Math.min(100, (current / threshold) * 100);
}

/**
 * Validate a migration target's share configuration.
 * Meteora targets must have lpShare + stakerShare + holderShare === 100.
 */
export function validateMigrationTarget(target: MigrationTarget): void {
  if ("meteoraDammV1" in target) {
    const t = target.meteoraDammV1;
    if (t.lpShare + t.stakerShare + t.holderShare !== 100) {
      throw new Error(
        `Meteora DAMM v1 shares must sum to 100, got ${t.lpShare + t.stakerShare + t.holderShare}`
      );
    }
  }
  if ("meteoraDlmm" in target) {
    const t = target.meteoraDlmm;
    if (t.lpShare + t.stakerShare + t.holderShare !== 100) {
      throw new Error(
        `Meteora DLMM shares must sum to 100, got ${t.lpShare + t.stakerShare + t.holderShare}`
      );
    }
  }
}

/**
 * Convert a raw lamport amount to SOL with full precision.
 */
export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / 1e9;
}

/**
 * Convert SOL to lamports.
 */
export function solToLamports(sol: number): bigint {
  return BigInt(Math.floor(sol * 1e9));
}

/**
 * Format a raw token amount (with decimals) into a human-readable string.
 */
export function formatTokenAmount(
  raw: bigint,
  decimals: number = TOKEN_DECIMALS
): string {
  const divisor = BigInt(10 ** decimals);
  const whole = raw / divisor;
  const fraction = raw % divisor;
  return `${whole}.${fraction.toString().padStart(decimals, "0")}`;
}

/**
 * Parse a human-readable token amount into raw units.
 */
export function parseTokenAmount(
  formatted: string,
  decimals: number = TOKEN_DECIMALS
): bigint {
  const [whole, fraction = ""] = formatted.split(".");
  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole) * BigInt(10 ** decimals) + BigInt(paddedFraction);
}

/**
 * Calculate pending staker rewards.
 * Replicates the on-chain StakerVault::pending_rewards logic.
 */
export function pendingStakerRewards(
  accumulatedRewardPerToken: bigint,
  rewardDebt: bigint,
  amountStaked: bigint
): bigint {
  const REWARD_PRECISION = 1_000_000_000_000n;
  return (
    (accumulatedRewardPerToken - rewardDebt) * amountStaked / REWARD_PRECISION
  );
}

/**
 * Check a connection is alive and get slot.
 */
export async function checkConnection(connection: Connection): Promise<number> {
  return connection.getSlot();
}
