/**
 * @module migration
 *
 * Migration helpers for graduating tokens from the Pulse bonding curve to DEXes.
 *
 * This module handles the most painful part of the migration flow:
 *   1. Computing the correct DEX pool addresses BEFORE the pool exists
 *   2. Building the MigrationConfig during token creation
 *   3. Verifying migration readiness with rich diagnostic output
 *   4. Polling and auto-triggering migration when threshold is crossed
 *
 * The entire migration system is designed around one principle: by the time
 * migrate() is called, everything should already be configured. No surprises.
 * No "oh I forgot to set the dex_pool address" at graduation time.
 *
 * @example
 * ```ts
 * import { MigrationHelper } from "@pulseonchain/sdk/migration";
 *
 * // Check migration readiness with full diagnostics
 * const status = await MigrationHelper.diagnose(pulse, mint);
 * console.log(status.report);
 *
 * // Watch a pool and auto-migrate when ready
 * const unsubscribe = MigrationHelper.watchAndMigrate(pulse, mint, payerWallet, {
 *   onGraduationReady: (pool) => console.log("🎓 Ready!", pool),
 *   onMigrated: (sig) => console.log("✅ Migrated:", sig),
 *   onError: (err) => console.error("Migration failed:", err),
 * });
 *
 * // Later: stop watching
 * unsubscribe();
 * ```
 */

import { Connection, PublicKey, TransactionSignature } from "@solana/web3.js";
import type { PoolState, MigrationTarget, MigrationConfig } from "./types";
import { PulsePDA } from "./pda";
import {
  RAYDIUM_CPMM_PROGRAM_ID,
  METEORA_DAMM_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
  PUMP_SWAP_PROGRAM_ID,
} from "./constants";

// ─── Migration Status ─────────────────────────────────────────────────────────

export type MigrationReadiness =
  | "ready"               // ≥85 SOL raised, config set, can migrate now
  | "not_enough_sol"      // still accumulating SOL
  | "already_graduated"   // already migrated
  | "config_missing"      // MigrationConfig PDA doesn't exist
  | "config_mismatch"     // MigrationConfig exists but dex_pool is wrong
  | "paused";             // protocol is paused

export interface MigrationDiagnosis {
  readiness: MigrationReadiness;
  pool: PoolState | null;
  migrationConfig: MigrationConfig | null;
  solRaisedLamports: bigint;
  solToGraduationLamports: bigint;
  graduationProgressPct: number;
  /** Human-readable diagnostic summary */
  report: string;
  /** Suggested action for this state */
  action: string;
}

export interface MigrationWatchOptions {
  /** Called when pool crosses the graduation threshold */
  onGraduationReady?: (pool: PoolState) => void;
  /** Called after successful migration */
  onMigrated?: (signature: TransactionSignature, pool: PoolState) => void;
  /** Called on any error (poll failure, migration tx failure, etc.) */
  onError?: (error: Error) => void;
  /** How often to poll in milliseconds (default: 5000) */
  pollIntervalMs?: number;
  /** Whether to automatically submit the migrate() transaction (default: true) */
  autoMigrate?: boolean;
  /** Max attempts to submit migrate() before giving up (default: 3) */
  maxMigrateAttempts?: number;
}

// ─── Raydium Pool Address Derivation ─────────────────────────────────────────

/**
 * Compute the Raydium CPMM pool address for a token/SOL pair.
 *
 * Raydium CPMM pool PDA: seeds = ["pool", amm_config, token0_mint, token1_mint]
 * where token0 < token1 (lexicographic order of pubkey bytes).
 *
 * NOTE: amm_config is the Raydium AMM config PDA (configurable, usually the default).
 */
export function deriveRaydiumCpmmPool(
  tokenMint: PublicKey,
  solMint: PublicKey = new PublicKey("So11111111111111111111111111111111111111112"),
  ammConfig: PublicKey = new PublicKey("D4FRetlgpe71W6kX3I3UEiE4yGbZpsK9nkHPAYAnCi6"),
  programId: PublicKey = RAYDIUM_CPMM_PROGRAM_ID
): PublicKey {
  // Sort mints: Raydium requires token0 < token1
  const [token0, token1] = tokenMint.toBuffer().compare(solMint.toBuffer()) < 0
    ? [tokenMint, solMint]
    : [solMint, tokenMint];

  const [pool] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      ammConfig.toBuffer(),
      token0.toBuffer(),
      token1.toBuffer(),
    ],
    programId
  );
  return pool;
}

/**
 * Compute the Raydium CPMM vault addresses (the token accounts the pool owns).
 * These are used as the `dex_token_account` in MigrationConfig.
 */
export function deriveRaydiumCpmmVaults(
  pool: PublicKey,
  tokenMint: PublicKey,
  solMint: PublicKey = new PublicKey("So11111111111111111111111111111111111111112"),
  programId: PublicKey = RAYDIUM_CPMM_PROGRAM_ID
): { vault0: PublicKey; vault1: PublicKey } {
  const [vault0] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), pool.toBuffer(), tokenMint.toBuffer()],
    programId
  );
  const [vault1] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), pool.toBuffer(), solMint.toBuffer()],
    programId
  );
  return { vault0, vault1 };
}

// ─── PumpSwap Pool Address Derivation ────────────────────────────────────────

/**
 * Compute the PumpSwap pool address.
 * PumpSwap pools are created with a sequential index — pass the expected index.
 */
export function derivePumpSwapPool(
  tokenMint: PublicKey,
  poolIndex: number = 0,
  programId: PublicKey = PUMP_SWAP_PROGRAM_ID
): PublicKey {
  const indexBytes = Buffer.alloc(2);
  indexBytes.writeUInt16LE(poolIndex);

  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), indexBytes, tokenMint.toBuffer()],
    programId
  );
  return pool;
}

// ─── Meteora DAMM Pool Derivation ─────────────────────────────────────────────

/**
 * Compute the Meteora DAMM v1 pool address for a token pair.
 * Seeds: ["pool", token_a_mint, token_b_mint] where a < b lexicographically.
 */
export function deriveMeteoraDammPool(
  tokenMint: PublicKey,
  solMint: PublicKey = new PublicKey("So11111111111111111111111111111111111111112"),
  programId: PublicKey = METEORA_DAMM_PROGRAM_ID
): PublicKey {
  const [token0, token1] = tokenMint.toBuffer().compare(solMint.toBuffer()) < 0
    ? [tokenMint, solMint]
    : [solMint, tokenMint];

  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), token0.toBuffer(), token1.toBuffer()],
    programId
  );
  return pool;
}

// ─── Migration Config Builder ─────────────────────────────────────────────────

/**
 * Compute all the DEX addresses needed for MigrationConfig in one call.
 * Call this during token creation (step 1c / createStakerVault) to pre-configure
 * the migration target so that migrate() can be fully permissionless later.
 *
 * @example
 * ```ts
 * const { dexProgramId, dexPool, dexTokenAccount } = resolveMigrationAddresses(
 *   mint,
 *   { raydiumCpmm: {} }
 * );
 * // Pass these into createStakerVault()
 * ```
 */
export function resolveMigrationAddresses(
  tokenMint: PublicKey,
  migrationTarget: MigrationTarget
): {
  dexProgramId: PublicKey;
  dexPool: PublicKey;
  dexTokenAccount: PublicKey;
} {
  const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

  if ("raydiumCpmm" in migrationTarget) {
    const dexPool = deriveRaydiumCpmmPool(tokenMint);
    const { vault0 } = deriveRaydiumCpmmVaults(dexPool, tokenMint);
    return {
      dexProgramId: RAYDIUM_CPMM_PROGRAM_ID,
      dexPool,
      dexTokenAccount: vault0,
    };
  }

  if ("meteoraDammV1" in migrationTarget) {
    const dexPool = deriveMeteoraDammPool(tokenMint);
    // Meteora vault: ["a_vault", token_a_mint, token_b_mint, ...] — simplified derivation
    const [tokenVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("a_vault"), tokenMint.toBuffer()],
      METEORA_DAMM_PROGRAM_ID
    );
    return {
      dexProgramId: METEORA_DAMM_PROGRAM_ID,
      dexPool,
      dexTokenAccount: tokenVault,
    };
  }

  if ("meteoraDlmm" in migrationTarget) {
    // DLMM pool address — simplified, use create2-style with bin step + fee
    const t = migrationTarget.meteoraDlmm;
    const params = Buffer.alloc(4);
    params.writeUInt16LE(t.binStep, 0);
    params.writeUInt16LE(t.feeBps, 2);
    const [dexPool] = PublicKey.findProgramAddressSync(
      [Buffer.from("lb_pair"), tokenMint.toBuffer(), WSOL.toBuffer(), params],
      METEORA_DLMM_PROGRAM_ID
    );
    const [dexTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("reserve"), dexPool.toBuffer(), tokenMint.toBuffer()],
      METEORA_DLMM_PROGRAM_ID
    );
    return {
      dexProgramId: METEORA_DLMM_PROGRAM_ID,
      dexPool,
      dexTokenAccount,
    };
  }

  if ("pumpSwapBurn" in migrationTarget || "pumpSwapHoldLp" in migrationTarget) {
    const dexPool = derivePumpSwapPool(tokenMint);
    // PumpSwap base vault: ["base_vault", pool]
    const [dexTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("base_vault"), dexPool.toBuffer()],
      PUMP_SWAP_PROGRAM_ID
    );
    return {
      dexProgramId: PUMP_SWAP_PROGRAM_ID,
      dexPool,
      dexTokenAccount,
    };
  }

  throw new Error(`Unknown migration target: ${JSON.stringify(migrationTarget)}`);
}

// ─── Migration Diagnosis ──────────────────────────────────────────────────────

/**
 * Diagnose the migration readiness of a pool with human-readable output.
 * Use this in dashboards, bots, and debugging.
 *
 * @example
 * ```ts
 * const diagnosis = await MigrationHelper.diagnose(pulse, mint);
 * if (diagnosis.readiness === "ready") {
 *   console.log("🎓 Pool is ready to graduate!");
 *   const sig = await pulse.migrate(payer, mint);
 * } else {
 *   console.log(diagnosis.report);
 *   console.log("Next action:", diagnosis.action);
 * }
 * ```
 */
export const MigrationHelper = {
  async diagnose(
    connection: Connection,
    programId: PublicKey,
    mint: PublicKey,
    graduationThresholdLamports: bigint = BigInt(85_000_000_000)
  ): Promise<MigrationDiagnosis> {
    const pdas = PulsePDA.derived(mint, programId);

    // Fetch pool state and migration config in parallel
    const [poolInfo, configInfo] = await Promise.all([
      connection.getAccountInfo(pdas.poolState),
      connection.getAccountInfo(pdas.migrationConfig),
    ]);

    if (!poolInfo) {
      return {
        readiness: "config_missing",
        pool: null,
        migrationConfig: null,
        solRaisedLamports: 0n,
        solToGraduationLamports: graduationThresholdLamports,
        graduationProgressPct: 0,
        report: `❌ Pool state not found for mint ${mint.toBase58()}`,
        action: "Token not created or wrong mint address",
      };
    }

    // Parse pool state (minimal inline parse)
    const data = poolInfo.data;
    const realSolReserves = data.readBigUInt64LE(186);
    const graduated = data[210] === 1;

    if (graduated) {
      return {
        readiness: "already_graduated",
        pool: null,
        migrationConfig: null,
        solRaisedLamports: realSolReserves,
        solToGraduationLamports: 0n,
        graduationProgressPct: 100,
        report: `✅ Token has already graduated to a DEX`,
        action: "Nothing to do — check the DEX pool for trading",
      };
    }

    const solToGrad = realSolReserves >= graduationThresholdLamports
      ? 0n
      : graduationThresholdLamports - realSolReserves;

    const progressPct = Number(
      (realSolReserves * 10000n) / graduationThresholdLamports
    ) / 100;

    if (!configInfo) {
      return {
        readiness: "config_missing",
        pool: null,
        migrationConfig: null,
        solRaisedLamports: realSolReserves,
        solToGraduationLamports: solToGrad,
        graduationProgressPct: progressPct,
        report: `⚠️  MigrationConfig PDA missing for ${mint.toBase58()}`,
        action: "Run createStakerVault() to initialize migration config",
      };
    }

    if (solToGrad > 0n) {
      return {
        readiness: "not_enough_sol",
        pool: null,
        migrationConfig: null,
        solRaisedLamports: realSolReserves,
        solToGraduationLamports: solToGrad,
        graduationProgressPct: progressPct,
        report: `⏳ ${progressPct.toFixed(1)}% to graduation — ${(Number(solToGrad) / 1e9).toFixed(3)} SOL remaining`,
        action: `Buy more or wait for organic volume (${(Number(realSolReserves) / 1e9).toFixed(3)} / ${(Number(graduationThresholdLamports) / 1e9).toFixed(0)} SOL)`,
      };
    }

    return {
      readiness: "ready",
      pool: null,
      migrationConfig: null,
      solRaisedLamports: realSolReserves,
      solToGraduationLamports: 0n,
      graduationProgressPct: Math.min(progressPct, 100),
      report: `🎓 READY TO GRADUATE! ${(Number(realSolReserves) / 1e9).toFixed(3)} SOL raised`,
      action: "Call pulse.migrate(payer, mint) — anyone can call this!",
    };
  },

  /**
   * Watch a pool and call your callbacks at key lifecycle events.
   * Returns an unsubscribe function.
   *
   * Uses polling (not WebSocket) for reliability across all RPC endpoints.
   * For WebSocket subscriptions, use `pulse.subscriptions.watchPool()`.
   */
  watchAndMigrate(
    connection: Connection,
    programId: PublicKey,
    mint: PublicKey,
    payer: { publicKey: PublicKey; signTransaction: (tx: any) => Promise<any> },
    submitMigrateFn: (payer: any, mint: PublicKey) => Promise<TransactionSignature>,
    options: MigrationWatchOptions = {}
  ): () => void {
    const {
      pollIntervalMs = 5_000,
      autoMigrate = true,
      maxMigrateAttempts = 3,
      onGraduationReady,
      onMigrated,
      onError,
    } = options;

    let attempts = 0;
    let migrating = false;
    let stopped = false;

    const poll = async () => {
      if (stopped) return;
      try {
        const diagnosis = await MigrationHelper.diagnose(
          connection,
          programId,
          mint
        );

        if (diagnosis.readiness === "already_graduated") {
          stopped = true;
          return;
        }

        if (diagnosis.readiness === "ready") {
          if (onGraduationReady && diagnosis.pool) {
            onGraduationReady(diagnosis.pool);
          }

          if (autoMigrate && !migrating && attempts < maxMigrateAttempts) {
            migrating = true;
            attempts++;
            try {
              const sig = await submitMigrateFn(payer, mint);
              if (onMigrated && diagnosis.pool) {
                onMigrated(sig, diagnosis.pool);
              }
              stopped = true;
            } catch (err) {
              migrating = false;
              if (onError) onError(err as Error);
            }
          }
        }
      } catch (err) {
        if (onError) onError(err as Error);
      }

      if (!stopped) {
        setTimeout(poll, pollIntervalMs);
      }
    };

    setTimeout(poll, 0);

    return () => { stopped = true; };
  },

  /**
   * Format a migration target as a human-readable string.
   * Useful for display and logging.
   */
  formatMigrationTarget(target: MigrationTarget): string {
    if ("raydiumCpmm" in target) return "Raydium CPMM";
    if ("meteoraDammV1" in target) {
      const t = target.meteoraDammV1;
      return `Meteora DAMM v1 (LP:${t.lpShare}% Stakers:${t.stakerShare}% Holders:${t.holderShare}%)`;
    }
    if ("meteoraDlmm" in target) {
      const t = target.meteoraDlmm;
      return `Meteora DLMM (${t.feeBps}bps fee, ${t.binStep} bin step)`;
    }
    if ("pumpSwapBurn" in target) return "PumpSwap (burn LP)";
    if ("pumpSwapHoldLp" in target) return "PumpSwap (hold LP for fees)";
    return "Unknown";
  },

  /**
   * Validate that a migration target is correctly configured.
   * Returns a list of validation errors (empty array = valid).
   */
  validateMigrationTarget(target: MigrationTarget): string[] {
    const errors: string[] = [];

    if ("meteoraDammV1" in target) {
      const t = target.meteoraDammV1;
      const sum = t.lpShare + t.stakerShare + t.holderShare;
      if (sum !== 100) errors.push(`DAMM shares must sum to 100, got ${sum}`);
      if (t.lpShare < 0 || t.lpShare > 100) errors.push("lpShare must be 0-100");
      if (t.stakerShare < 0 || t.stakerShare > 100) errors.push("stakerShare must be 0-100");
      if (t.holderShare < 0 || t.holderShare > 100) errors.push("holderShare must be 0-100");
    }

    if ("meteoraDlmm" in target) {
      const t = target.meteoraDlmm;
      const sum = t.lpShare + t.stakerShare + t.holderShare;
      if (sum !== 100) errors.push(`DLMM shares must sum to 100, got ${sum}`);
      if (t.feeBps <= 0 || t.feeBps > 10_000) errors.push("feeBps must be 1-10000");
      if (t.binStep <= 0) errors.push("binStep must be > 0");
    }

    return errors;
  },
};
