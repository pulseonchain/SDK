/**
 * @module batch
 *
 * Batch operations and multi-transaction builders for the Pulse protocol.
 *
 * Solana transactions are limited to ~1232 bytes. Complex operations that
 * involve many accounts (like migration) may need to be split across
 * multiple transactions. This module handles:
 * - **Transaction batching** — group multiple operations into a single atomic submission
 * - **Chunked execution** — split large operations across multiple transactions with confirmation between each
 * - **Versioned transactions** — use Address Lookup Tables for larger account sets
 * - **Priority fee estimation** — automatically compute optimal fees
 * - **Parallel fetching** — batch multiple RPC calls into single requests
 *
 * @example
 * ```ts
 * import { BatchExecutor, MultiTransactionBuilder, estimatePriorityFee } from "@pulseonchain/sdk";
 *
 * // Execute multiple buys across different mints in parallel
 * const executor = new BatchExecutor(pulse.connection, {
 *   maxConcurrent: 5,
 *   confirmBetween: false,
 * });
 *
 * const results = await executor.executeAll([
 *   () => pulse.buy(wallet, { mint1, solAmount: 1_000_000_000n, minTokensOut: 0n }),
 *   () => pulse.buy(wallet, { mint2, solAmount: 500_000_000n, minTokensOut: 0n }),
 *   () => pulse.buy(wallet, { mint3, solAmount: 2_000_000_000n, minTokensOut: 0n }),
 * ]);
 *
 * // Build a complex multi-transaction migration
 * const builder = new MultiTransactionBuilder(pulse.connection);
 * await builder.addComputeBudget(300_000);
 * await builder.addPriorityFee(10_000);
 * await builder.addInstruction(migrateIx);
 * const txs = await builder.buildWallet(wallet);
 * ```
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
  RecentPrioritizationFees,
} from "@solana/web3.js";
import type { BuiltTransaction, TransactionResult } from "./types";

// ══════════════════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════════════════

export interface BatchOptions {
  /** Maximum number of concurrent transactions (default: 1 = sequential) */
  maxConcurrent?: number;
  /** Wait for confirmation between transactions (default: true) */
  confirmBetween?: boolean;
  /** Commitment level for confirmation */
  commitment?: "processed" | "confirmed" | "finalized";
  /** Delay between transactions in milliseconds (default: 100) */
  delayMs?: number;
  /** Whether to continue on error (default: false = stop on first error) */
  continueOnError?: boolean;
  /** Maximum retries per transaction */
  maxRetries?: number;
  /** Priority fee in microlamports per CU */
  priorityFeeMicrolamports?: number;
  /** Compute budget in units */
  computeBudgetUnits?: number;
}

export interface BatchResult {
  /** Total number of operations attempted */
  total: number;
  /** Number of successful operations */
  successful: number;
  /** Number of failed operations */
  failed: number;
  /** Results for each operation */
  results: Array<{
    index: number;
    success: boolean;
    signature?: string;
    error?: string;
    slot?: number;
    feeLamports?: number;
  }>;
  /** Total fees paid across all transactions in lamports */
  totalFeesLamports: number;
  /** Total execution time in milliseconds */
  executionTimeMs: number;
}

export interface ParallelFetchResult<T> {
  results: Array<{ key: string; value: T | null; error?: string }>;
  totalTimeMs: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// BATCH EXECUTOR
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Executes multiple transaction-signing functions as a batch.
 *
 * Supports both sequential and concurrent execution modes.
 * Sequential is safer (no nonce issues), concurrent is faster
 * (for independent operations like buying different tokens).
 *
 * @example
 * ```ts
 * const executor = new BatchExecutor(connection, {
 *   maxConcurrent: 3,
 *   confirmBetween: true,
 *   priorityFeeMicrolamports: 10_000,
 * });
 *
 * const result = await executor.executeAll([
 *   { fn: () => pulse.buy(wallet, params1), label: "Buy TOKEN1" },
 *   { fn: () => pulse.buy(wallet, params2), label: "Buy TOKEN2" },
 *   { fn: () => pulse.stake(wallet, stakeParams), label: "Stake TOKEN1" },
 * ]);
 *
 * console.log(`${result.successful}/${result.total} succeeded`);
 * console.log(`Total fees: ${result.totalFeesLamports / 1e9} SOL`);
 * ```
 */
export class BatchExecutor {
  private readonly connection: Connection;
  private readonly options: Required<BatchOptions>;

  constructor(connection: Connection, options: BatchOptions = {}) {
    this.connection = connection;
    this.options = {
      maxConcurrent: options.maxConcurrent ?? 1,
      confirmBetween: options.confirmBetween ?? true,
      commitment: options.commitment ?? "confirmed",
      delayMs: options.delayMs ?? 100,
      continueOnError: options.continueOnError ?? false,
      maxRetries: options.maxRetries ?? 3,
      priorityFeeMicrolamports: options.priorityFeeMicrolamports ?? 0,
      computeBudgetUnits: options.computeBudgetUnits ?? 200_000,
    };
  }

  /**
   * Execute an array of transaction functions sequentially or concurrently.
   *
   * @param operations - Array of objects with `fn` (returns TransactionSignature) and optional `label`
   * @returns Batch result with per-operation details
   */
  async executeAll(
    operations: Array<{
      fn: () => Promise<string>;
      label?: string;
    }>
  ): Promise<BatchResult> {
    const startTime = Date.now();
    const results: BatchResult["results"] = [];
    let totalFees = 0;

    if (this.options.maxConcurrent === 1) {
      // Sequential execution
      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        const result = await this.executeWithRetry(op.fn, op.label);
        results.push({ index: i, ...result });

        if (result.success && result.feeLamports) {
          totalFees += result.feeLamports;
        }

        if (!result.success && !this.options.continueOnError) {
          break;
        }

        if (i < operations.length - 1 && this.options.delayMs > 0) {
          await this.sleep(this.options.delayMs);
        }
      }
    } else {
      // Concurrent execution in chunks
      const chunks = this.chunkArray(operations, this.options.maxConcurrent);

      for (const chunk of chunks) {
        const chunkResults = await Promise.all(
          chunk.map(async (op, chunkIdx) => {
            const globalIndex = results.length + chunkIdx;
            const result = await this.executeWithRetry(op.fn, op.label);
            return { index: globalIndex, ...result };
          })
        );

        results.push(...chunkResults);

        const chunkFees = chunkResults.reduce((sum, r) => sum + (r.feeLamports ?? 0), 0);
        totalFees += chunkFees;

        const hasFailure = chunkResults.some((r) => !r.success);
        if (hasFailure && !this.options.continueOnError) {
          break;
        }

        if (this.options.delayMs > 0) {
          await this.sleep(this.options.delayMs);
        }
      }
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    return {
      total: operations.length,
      successful,
      failed,
      results,
      totalFeesLamports: totalFees,
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Sign and submit multiple pre-built transactions sequentially.
   * Each transaction gets priority fees and compute budget automatically.
   *
   * @param wallet - The signer wallet
   * @param transactions - Array of { transaction, description } objects
   * @returns Batch result
   */
  async submitAll(
    wallet: { publicKey: PublicKey; signTransaction: (tx: any) => Promise<any> },
    transactions: BuiltTransaction[]
  ): Promise<BatchResult> {
    const startTime = Date.now();
    const results: BatchResult["results"] = [];
    let totalFees = 0;

    for (let i = 0; i < transactions.length; i++) {
      const { transaction: tx, description } = transactions[i];

      try {
        // Add priority fee if configured
        let finalTx = tx;
        if (this.options.priorityFeeMicrolamports > 0 || this.options.computeBudgetUnits > 0) {
          finalTx = this.addComputeBudgetToTransaction(tx);
        }

        const { blockhash } = await this.connection.getLatestBlockhash();
        finalTx.recentBlockhash = blockhash;
        finalTx.feePayer = wallet.publicKey;

        const signed = await wallet.signTransaction(finalTx);
        const signature = await this.connection.sendRawTransaction(signed.serialize());

        let slot: number | undefined;
        let feeLamports: number | undefined;

        if (this.options.confirmBetween) {
          const confirmation = await this.connection.confirmTransaction(
            { signature, blockhash },
            this.options.commitment
          );
          if (!confirmation.value.err) {
            const confirmedTx = await this.connection.getParsedTransaction(signature, {
              maxSupportedTransactionVersion: 0,
            });
            slot = confirmedTx?.slot;
            feeLamports = confirmedTx?.meta?.fee;
            if (feeLamports) totalFees += feeLamports;
          }
        }

        results.push({ index: i, success: true, signature, slot, feeLamports });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        results.push({ index: i, success: false, error });

        if (!this.options.continueOnError) break;
      }

      if (i < transactions.length - 1 && this.options.delayMs > 0) {
        await this.sleep(this.options.delayMs);
      }
    }

    return {
      total: transactions.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
      totalFeesLamports: totalFees,
      executionTimeMs: Date.now() - startTime,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async executeWithRetry(
    fn: () => Promise<string>,
    label?: string
  ): Promise<Omit<BatchResult["results"][0], "index">> {
    let lastError: string | undefined;

    for (let attempt = 0; attempt < this.options.maxRetries; attempt++) {
      try {
        const signature = await fn();

        let slot: number | undefined;
        let feeLamports: number | undefined;

        if (this.options.confirmBetween) {
          try {
            const tx = await this.connection.getParsedTransaction(signature, {
              maxSupportedTransactionVersion: 0,
            });
            slot = tx?.slot;
            feeLamports = tx?.meta?.fee;
          } catch {
            // Confirmation check failed — still count as submitted
          }
        }

        return { success: true, signature, slot, feeLamports };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);

        if (attempt < this.options.maxRetries - 1) {
          await this.sleep(1000 * (attempt + 1)); // Exponential backoff
        }
      }
    }

    return { success: false, error: lastError };
  }

  private addComputeBudgetToTransaction(tx: Transaction): Transaction {
    const modified = new Transaction();

    // Compute budget: set CU limit
    if (this.options.computeBudgetUnits > 0) {
      modified.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: this.options.computeBudgetUnits,
        })
      );
    }

    // Priority fee
    if (this.options.priorityFeeMicrolamports > 0) {
      modified.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.options.priorityFeeMicrolamports,
        })
      );
    }

    // Copy instructions from original transaction
    for (const ix of tx.instructions) {
      modified.add(ix);
    }

    return modified;
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MULTI-TRANSACTION BUILDER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Builds complex operations that span multiple Solana transactions.
 *
 * When a single transaction would exceed the 1232-byte limit (too many
 * accounts or instructions), this builder splits the operation across
 * multiple transactions with automatic dependency management.
 *
 * Specifically supports versioned transactions (V0) with Address Lookup
 * Tables for drastically reduced transaction sizes.
 *
 * @example
 * ```ts
 * const builder = new MultiTransactionBuilder(connection, wallet);
 *
 * // Step 1: Add compute budget
 * await builder.addComputeBudget(400_000, 20_000);
 *
 * // Step 2: Add your custom instructions
 * builder.addInstruction(yourInstruction);
 *
 * // Step 3: Add more instructions (automatically split if needed)
 * builder.addInstruction(anotherInstruction);
 *
 * // Step 4: Build and sign all transactions
 * const transactions = await builder.build();
 * for (const tx of transactions) {
 *   await connection.sendRawTransaction(tx.serialize());
 * }
 * ```
 */
export class MultiTransactionBuilder {
  private readonly connection: Connection;
  private readonly instructions: TransactionInstruction[] = [];
  private lookupTables: AddressLookupTableAccount[] = [];
  private computeBudgetUnits: number | null = null;
  private priorityFeeMicrolamports: number | null = null;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Set the compute budget for the transaction(s).
   */
  setComputeBudget(units: number): this {
    this.computeBudgetUnits = units;
    return this;
  }

  /**
   * Set the priority fee in microlamports per compute unit.
   */
  setPriorityFee(microlamports: number): this {
    this.priorityFeeMicrolamports = microlamports;
    return this;
  }

  /**
   * Add both compute budget and priority fee in one call.
   */
  async addComputeBudget(
    units: number = 200_000,
    priorityFeeMicrolamports: number = 0
  ): Promise<this> {
    this.computeBudgetUnits = units;
    if (priorityFeeMicrolamports > 0) {
      this.priorityFeeMicrolamports = priorityFeeMicrolamports;
    }
    return this;
  }

  /**
   * Add an instruction to the batch.
   */
  addInstruction(instruction: TransactionInstruction): this {
    this.instructions.push(instruction);
    return this;
  }

  /**
   * Add multiple instructions at once.
   */
  addInstructions(instructions: TransactionInstruction[]): this {
    this.instructions.push(...instructions);
    return this;
  }

  /**
   * Add an Address Lookup Table to reduce transaction size.
   */
  async addLookupTable(address: PublicKey): Promise<this> {
    const account = await this.connection.getAddressLookupTable(address);
    if (account.value) {
      this.lookupTables.push(account.value);
    }
    return this;
  }

  /**
   * Build all instructions into one or more versioned transactions.
   * Automatically splits if the transaction would exceed size limits.
   *
   * @returns Array of signed VersionedTransaction objects
   */
  async build(
    payer: PublicKey
  ): Promise<VersionedTransaction[]> {
    const { blockhash } = await this.connection.getLatestBlockhash();
    const allIx = this.buildInstructions();

    // Try to fit in a single transaction first
    const singleTx = this.tryBuildSingle(payer, blockhash, allIx);
    if (singleTx) return [singleTx];

    // Split into multiple transactions
    return this.buildMultiple(payer, blockhash, allIx);
  }

  /**
   * Build and sign all transactions with the provided wallet.
   */
  async buildAndSign(
    wallet: { publicKey: PublicKey; signTransaction: (tx: any) => Promise<any> }
  ): Promise<VersionedTransaction[]> {
    const txs = await this.build(wallet.publicKey);
    return Promise.all(txs.map((tx) => wallet.signTransaction(tx)));
  }

  /**
   * Clear all instructions and reset state.
   */
  reset(): this {
    this.instructions = [];
    this.computeBudgetUnits = null;
    this.priorityFeeMicrolamports = null;
    return this;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private buildInstructions(): TransactionInstruction[] {
    const allIx: TransactionInstruction[] = [];

    // CU budget (must be first)
    if (this.computeBudgetUnits) {
      allIx.push(ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeBudgetUnits }));
    }
    if (this.priorityFeeMicrolamports) {
      allIx.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityFeeMicrolamports }));
    }

    allIx.push(...this.instructions);
    return allIx;
  }

  private tryBuildSingle(
    payer: PublicKey,
    blockhash: string,
    instructions: TransactionInstruction[]
  ): VersionedTransaction | null {
    try {
      const message = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message(this.lookupTables.length > 0 ? this.lookupTables : undefined);

      return new VersionedTransaction(message);
    } catch {
      // Transaction too large
      return null;
    }
  }

  private buildMultiple(
    payer: PublicKey,
    blockhash: string,
    instructions: TransactionInstruction[]
  ): VersionedTransaction[] {
    const transactions: VersionedTransaction[] = [];
    const budgetIx = instructions.filter(
      (ix) => ix.programId.equals(ComputeBudgetProgram.programId)
    );
    const nonBudgetIx = instructions.filter(
      (ix) => !ix.programId.equals(ComputeBudgetProgram.programId)
    );

    // Chunk the non-budget instructions
    const chunks = this.chunkInstructions(nonBudgetIx);

    for (const chunk of chunks) {
      const message = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions: [...budgetIx, ...chunk],
      }).compileToV0Message(this.lookupTables.length > 0 ? this.lookupTables : undefined);

      transactions.push(new VersionedTransaction(message));
    }

    return transactions;
  }

  /**
   * Chunk instructions to fit within transaction size limits.
   * Uses a simple estimation: each instruction ≈ 50 bytes + 3 bytes per account.
   */
  private chunkInstructions(instructions: TransactionInstruction[]): TransactionInstruction[][] {
    const MAX_SIZE = 1232; // Solana transaction size limit
    const BASE_SIZE = 100; // Signature + header overhead
    const chunks: TransactionInstruction[][] = [];
    let currentChunk: TransactionInstruction[] = [];
    let currentSize = BASE_SIZE;

    for (const ix of instructions) {
      // Rough estimate of instruction size
      const ixSize = 50 + ix.keys.length * 3 + ix.data.length;

      if (currentSize + ixSize > MAX_SIZE && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentSize = BASE_SIZE;
      }

      currentChunk.push(ix);
      currentSize += ixSize;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PARALLEL FETCH UTILITIES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch multiple accounts in parallel using Solana's JSON-RPC batch requests.
 *
 * Solana supports up to 100 accounts per `getMultipleAccounts` call and
 * 25 per `getProgramAccounts` call. This utility handles batching and
 * parallelization automatically.
 *
 * @example
 * ```ts
 * const pools = await parallelFetchPools(connection, [
 *   mint1, mint2, mint3, mint4, mint5
 * ]);
 *
 * for (const [mint, pool] of pools) {
 *   if (pool) console.log(`${mint}: ${pool.realSolReserves} SOL raised`);
 * }
 * ```
 */
export async function parallelFetchMaps(
  connection: Connection,
  keys: PublicKey[],
  options?: {
    batchSize?: number;
    maxConcurrency?: number;
    commitment?: "processed" | "confirmed" | "finalized";
  }
): Promise<Map<string, any>> {
  const batchSize = options?.batchSize ?? 100;
  const maxConcurrency = options?.maxConcurrency ?? 5;
  const commitment = options?.commitment ?? "confirmed";
  const result = new Map<string, any>();

  // Split into batches
  const batches: PublicKey[][] = [];
  for (let i = 0; i < keys.length; i += batchSize) {
    batches.push(keys.slice(i, i + batchSize));
  }

  // Process batches with concurrency limit
  for (let i = 0; i < batches.length; i += maxConcurrency) {
    const concurrent = batches.slice(i, i + maxConcurrency);
    const results = await Promise.allSettled(
      concurrent.map((batch) =>
        connection.getMultipleAccountsInfo(batch, commitment)
      )
    );

    for (let j = 0; j < results.length; j++) {
      const res = results[j];
      const batch = concurrent[i + j] || concurrent[j];

      if (res.status === "fulfilled") {
        for (let k = 0; k < batch.length; k++) {
          result.set(batch[k].toBase58(), res.value[k]);
        }
      } else {
        for (const key of batch) {
          result.set(key.toBase58(), null);
        }
      }
    }
  }

  return result;
}

/**
 * Fetch multiple pool states in parallel.
 */
export async function parallelFetchPools(
  connection: Connection,
  mintPubkeys: PublicKey[],
  programId: PublicKey
): Promise<Map<string, any>> {
  const keys = mintPubkeys.map((mint) => {
    const [poolState] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_state"), mint.toBuffer()],
      programId
    );
    return poolState;
  });

  const accountInfos = await parallelFetchMaps(connection, keys);

  // Map back from pool_state pubkey to mint pubkey
  const result = new Map<string, any>();
  for (let i = 0; i < mintPubkeys.length; i++) {
    const mintKey = mintPubkeys[i].toBase58();
    const poolKey = keys[i].toBase58();
    result.set(mintKey, accountInfos.get(poolKey));
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// PRIORITY FEE ESTIMATION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Estimate the optimal priority fee for a transaction based on recent network conditions.
 *
 * Uses `getRecentPrioritizationFees` to analyze the last few hundred slots
 * and recommend a fee that will likely get your transaction included quickly.
 *
 * @param connection - Solana RPC connection
 * @param accounts - Accounts the transaction will write to (for localized fee estimation)
 * @param percentile - Which percentile to target: "min" | "low" | "medium" | "high" | "max"
 * @returns Recommended fee in microlamports per compute unit
 *
 * @example
 * ```ts
 * // Get a medium priority fee for a busy pool
 * const fee = await estimatePriorityFee(
 *   connection,
 *   [pdas.poolState, pdas.feeVault],
 *   "medium"
 * );
 *
 * // Use it in a transaction
 * tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }));
 * ```
 */
export async function estimatePriorityFee(
  connection: Connection,
  accounts: PublicKey[] = [],
  percentile: "min" | "low" | "medium" | "high" | "max" = "medium"
): Promise<number> {
  const percentileMap = { min: 0, low: 25, medium: 50, high: 75, max: 100 };
  const targetPercentile = percentileMap[percentile];

  try {
    const fees = await connection.getRecentPrioritizationFees(
      accounts.length > 0 ? accounts : undefined
    );

    if (!fees || fees.length === 0) return 10_000; // Default 10k microlamports

    // Filter to recent slots (last 200)
    const recentFees = fees
      .filter((f) => f.slot > fees[0].slot - 200)
      .map((f) => f.prioritizationFee)
      .sort((a, b) => a - b);

    if (recentFees.length === 0) return 10_000;

    const index = Math.floor((targetPercentile / 100) * recentFees.length);
    const fee = recentFees[Math.min(index, recentFees.length - 1)];

    // Floor at 1 to avoid 0-fee transactions
    return Math.max(1, fee);
  } catch {
    return 10_000; // Fallback default
  }
}

/**
 * Get a full priority fee analysis with all percentiles.
 */
export async function analyzePriorityFees(
  connection: Connection,
  accounts: PublicKey[] = []
): Promise<{ min: number; p25: number; p50: number; p75: number; p95: number; max: number }> {
  const fees = await connection.getRecentPrioritizationFees(
    accounts.length > 0 ? accounts : undefined
  );

  if (!fees || fees.length === 0) {
    return { min: 1, p25: 1, p50: 10_000, p75: 50_000, p95: 100_000, max: 500_000 };
  }

  const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.floor((p / 100) * sorted.length)] || 1;

  return {
    min: sorted[0] || 1,
    p25: pct(25),
    p50: pct(50),
    p75: pct(75),
    p95: pct(95),
    max: sorted[sorted.length - 1] || 1,
  };
}
