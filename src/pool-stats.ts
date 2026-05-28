/**
 * @module pool-stats
 *
 * Off-chain pool stats helpers. Wraps the on-chain PoolStats account and
 * provides additional computed metrics useful for frontends and analytics.
 *
 * The PoolStats PDA (seeds: ["pool_stats", mint]) is updated by the program
 * on every buy, sell, and migration. This module parses and enriches it.
 *
 * @example
 * ```ts
 * import { PoolStatsClient } from "@pulseonchain/sdk/pool-stats";
 *
 * const stats = await PoolStatsClient.fetch(connection, programId, mint);
 * console.log(`Volume: ${stats.formatted.totalVolumeSol} SOL`);
 * console.log(`Trades: ${stats.totalTrades}`);
 * console.log(`ATH: ${stats.formatted.peakSolRaised} SOL`);
 * ```
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { PulsePDA } from "./pda";

// ─── Raw On-Chain Layout ──────────────────────────────────────────────────────

export interface RawPoolStats {
  mint: PublicKey;
  totalBuys: bigint;
  totalSells: bigint;
  uniqueBuyers: bigint;
  totalSolVolumeBuy: bigint;
  totalSolVolumeSell: bigint;
  totalTokensBought: bigint;
  totalTokensSold: bigint;
  totalPlatformFeesCollected: bigint;
  totalCreatorFeesCollected: bigint;
  totalLpFeesClaimed: bigint;
  totalStakerRewardsDistributed: bigint;
  peakSolReserves: bigint;
  peakSolTimestamp: number;
  graduatedAt: number;
  solAtGraduation: bigint;
  tokensBurnedAtGraduation: bigint;
  totalStakers: number;
  bump: number;
}

// ─── Enriched Stats ───────────────────────────────────────────────────────────

export interface EnrichedPoolStats extends RawPoolStats {
  /** Total number of trades (buys + sells) */
  totalTrades: bigint;
  /** Net SOL volume (buy volume - sell volume) in lamports */
  netSolVolumelLamports: bigint;
  /** Total fees collected in lamports (platform + creator) */
  totalFeesCollected: bigint;
  /** Buy/sell ratio (1.0 = equal, >1.0 = more buys) */
  buySellRatio: number;
  /** Human-readable formatted values */
  formatted: {
    totalBuys: string;
    totalSells: string;
    totalTrades: string;
    uniqueBuyers: string;
    totalVolumeSol: string;
    totalBuyVolumeSol: string;
    totalSellVolumeSol: string;
    totalPlatformFeesSol: string;
    totalCreatorFeesSol: string;
    peakSolRaised: string;
    peakSolTimestamp: string;    // ISO 8601
    graduatedAt: string | null;  // ISO 8601 or null
    solAtGraduation: string | null;
  };
}

// ─── Client ───────────────────────────────────────────────────────────────────

export const PoolStatsClient = {
  /**
   * Fetch and parse the PoolStats PDA for a mint.
   * Returns null if the account doesn't exist (stats not yet initialized).
   */
  async fetch(
    connection: Connection,
    programId: PublicKey,
    mint: PublicKey
  ): Promise<EnrichedPoolStats | null> {
    const [statsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_stats"), mint.toBuffer()],
      programId
    );

    const info = await connection.getAccountInfo(statsPda);
    if (!info) return null;

    const raw = PoolStatsClient.parse(info.data, mint);
    if (!raw) return null;

    return PoolStatsClient.enrich(raw);
  },

  /**
   * Fetch stats for multiple pools in a single batched RPC call.
   */
  async fetchMultiple(
    connection: Connection,
    programId: PublicKey,
    mints: PublicKey[]
  ): Promise<Map<string, EnrichedPoolStats>> {
    const pdas = mints.map(mint => {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool_stats"), mint.toBuffer()],
        programId
      );
      return pda;
    });

    const accounts = await connection.getMultipleAccountsInfo(pdas);
    const results = new Map<string, EnrichedPoolStats>();

    for (let i = 0; i < mints.length; i++) {
      const info = accounts[i];
      if (!info) continue;
      const raw = PoolStatsClient.parse(info.data, mints[i]);
      if (raw) {
        results.set(mints[i].toBase58(), PoolStatsClient.enrich(raw));
      }
    }

    return results;
  },

  /**
   * Parse raw account data into RawPoolStats.
   * Offset layout matches the Rust PoolStats struct exactly.
   */
  parse(data: Buffer, mint: PublicKey): RawPoolStats | null {
    try {
      let offset = 8; // skip discriminator

      const readU32 = () => { const v = data.readUInt32LE(offset); offset += 4; return v; };
      const readU64 = () => { const v = data.readBigUInt64LE(offset); offset += 8; return v; };
      const readI64 = () => { const v = data.readBigInt64LE(offset); offset += 8; return v; };
      const readU8  = () => { const v = data[offset]; offset += 1; return v; };

      return {
        mint,
        totalBuys:                       readU64(),
        totalSells:                      readU64(),
        uniqueBuyers:                    readU64(),
        totalSolVolumeBuy:               readU64(),
        totalSolVolumeSell:              readU64(),
        totalTokensBought:               readU64(),
        totalTokensSold:                 readU64(),
        totalPlatformFeesCollected:      readU64(),
        totalCreatorFeesCollected:       readU64(),
        totalLpFeesClaimed:              readU64(),
        totalStakerRewardsDistributed:   readU64(),
        peakSolReserves:                 readU64(),
        peakSolTimestamp:                Number(readI64()),
        graduatedAt:                     Number(readI64()),
        solAtGraduation:                 readU64(),
        tokensBurnedAtGraduation:        readU64(),
        totalStakers:                    readU32(),
        bump:                            readU8(),
      };
    } catch {
      return null;
    }
  },

  /**
   * Enrich raw stats with computed fields and formatted strings.
   */
  enrich(raw: RawPoolStats): EnrichedPoolStats {
    const totalTrades = raw.totalBuys + raw.totalSells;
    const netSolVolumelLamports = raw.totalSolVolumeBuy - raw.totalSolVolumeSell;
    const totalFeesCollected = raw.totalPlatformFeesCollected + raw.totalCreatorFeesCollected;
    const buySellRatio = raw.totalSells > 0n
      ? Number(raw.totalBuys) / Number(raw.totalSells)
      : Number(raw.totalBuys);

    const fmtSol = (l: bigint) => (Number(l) / 1e9).toFixed(4) + " SOL";
    const fmtNum = (n: bigint) => n.toLocaleString();
    const fmtTs  = (ts: number) => ts > 0 ? new Date(ts * 1000).toISOString() : null;

    return {
      ...raw,
      totalTrades,
      netSolVolumelLamports,
      totalFeesCollected,
      buySellRatio,
      formatted: {
        totalBuys:             fmtNum(raw.totalBuys),
        totalSells:            fmtNum(raw.totalSells),
        totalTrades:           fmtNum(totalTrades),
        uniqueBuyers:          fmtNum(raw.uniqueBuyers),
        totalVolumeSol:        fmtSol(raw.totalSolVolumeBuy + raw.totalSolVolumeSell),
        totalBuyVolumeSol:     fmtSol(raw.totalSolVolumeBuy),
        totalSellVolumeSol:    fmtSol(raw.totalSolVolumeSell),
        totalPlatformFeesSol:  fmtSol(raw.totalPlatformFeesCollected),
        totalCreatorFeesSol:   fmtSol(raw.totalCreatorFeesCollected),
        peakSolRaised:         fmtSol(raw.peakSolReserves),
        peakSolTimestamp:      fmtTs(raw.peakSolTimestamp) ?? "never",
        graduatedAt:           fmtTs(raw.graduatedAt),
        solAtGraduation:       raw.graduatedAt > 0 ? fmtSol(raw.solAtGraduation) : null,
      },
    };
  },
};
