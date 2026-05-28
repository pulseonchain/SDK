/**
 * @pulseonchain/sdk — Official SDK for the Pulse Bonding Curve Protocol
 *
 * Pulse is a cross-chain bonding curve protocol on Solana. This SDK provides
 * everything you need to integrate: buy/sell, create tokens, migrate, stake,
 * fetch quotes, and analyze portfolios.
 *
 * ## Quick Start
 *
 * ```ts
 * import { Pulse, PulsePDA } from "@pulseonchain/sdk";
 *
 * // Connect to devnet
 * const pulse = Pulse.devnet();
 *
 * // Or mainnet with enhanced providers
 * const pulse = Pulse.mainnet({
 *   alchemyApiKey: "your-alchemy-key",
 *   heliusApiKey: "your-helius-key",
 * });
 *
 * // Derive PDAs for any mint
 * const pdas = PulsePDA.derived(mintPublicKey);
 *
 * // Simulate a trade
 * const quote = await pulse.simulateBuy(mint, BigInt(1_000_000_000));
 * console.log(`You get ${quote.tokensOut} tokens for 1 SOL`);
 *
 * // Execute a buy
 * await pulse.buy(wallet, {
 *   mint: mintPublicKey,
 *   solAmount: BigInt(1_000_000_000),
 *   minTokensOut: quote.tokensOut * 99n / 100n, // 1% slippage
 * });
 * ```
 *
 * ## Provider Features
 *
 * | Feature                        | Standard RPC | Helius    | Alchemy   | Both (Combined) |
 * |--------------------------------|--------------|-----------|-----------|-----------------|
 * | Buy / Sell / Trade             | ✅           | ✅        | ✅        | ✅              |
 * | Fetch pool state               | ✅           | ✅        | ✅        | ✅              |
 * | Simulate quotes                | ✅           | ✅        | ✅        | ✅              |
 * | Token metadata (name, image)   | ❌           | ✅ DAS    | ✅        | ✅              |
 * | Wallet token portfolio         | ❌           | ✅        | ✅        | ✅              |
 * | Transfer history               | ❌           | ❌        | ✅        | ✅              |
 * | Token search                   | ❌           | ✅ DAS    | ❌        | ✅              |
 * | Portfolio analytics (combined) | ❌           | ❌        | ❌        | ✅              |
 *
 * Use `Pulse.mainnet({ alchemyApiKey: "...", heliusApiKey: "..." })` for the full feature set.
 */

export { Pulse } from "./client";
export { PulsePDA } from "./pda";
export * as constants from "./constants";
export * from "./types";
export * from "./utils";

// ─── New Modules ──────────────────────────────────────────────────────────────

// Pure bonding-curve math — mirrors math.rs exactly, usable off-chain
export { BondingMath, INITIAL_VIRTUAL_SOL, INITIAL_VIRTUAL_TOKEN, BONDING_SUPPLY,
         RESERVE_SUPPLY, LP_RESERVE_SUPPLY, GRADUATION_THRESHOLD, TOTAL_FEE_BPS,
         TOKEN_DECIMALS } from "./math";
export type { BuySimResult, SellSimResult } from "./math";

// Migration helpers — DEX pool derivation, readiness diagnosis, auto-migrate watcher
export { MigrationHelper, resolveMigrationAddresses,
         deriveRaydiumCpmmPool, derivePumpSwapPool, deriveMeteoraDammPool } from "./migration";
export type { MigrationReadiness, MigrationDiagnosis, MigrationWatchOptions } from "./migration";

// Pool analytics — parses on-chain PoolStats PDA
export { PoolStatsClient } from "./pool-stats";
export type { RawPoolStats, EnrichedPoolStats } from "./pool-stats";

// Whitelist / presale — Merkle tree build + proof generation + verification
export { WhitelistHelper } from "./whitelist";
export type { MerkleTree, MerkleProof } from "./whitelist";
