/**
 * @module types
 *
 * Complete type system for the Pulse bonding curve protocol.
 *
 * This module defines every data structure used across the SDK:
 * - **Account state types** — on-chain account layouts (PoolState, GlobalConfig, etc.)
 * - **Instruction parameter types** — inputs for buy, sell, create, stake, etc.
 * - **Quote types** — off-chain simulation results
 * - **Event types** — Anchor event structures emitted by the program
 * - **Provider types** — Helius DAS API and Alchemy API response shapes
 * - **Utility types** — pagination, sorting, filtering, wallet interfaces
 *
 * @example
 * ```ts
 * import type { PoolState, BuyQuote, BuyParams, MigrationTarget } from "@pulseonchain/sdk";
 *
 * const target: MigrationTarget = { raydiumCpmm: {} };
 * const params: BuyParams = { mint, solAmount: 1_000_000_000n, minTokensOut: 0n };
 * ```
 */

import { PublicKey } from "@solana/web3.js";

// ══════════════════════════════════════════════════════════════════════════════
// MIGRATION TARGET
// ══════════════════════════════════════════════════════════════════════════════

/**
 * The DEX destination for a token after graduation.
 *
 * Each variant maps to a specific DEX program and configuration:
 * - `RaydiumCpmm` — Raydium Constant Product Market Maker
 * - `MeteoraDammV1` — Meteora Dynamic AMM v1 with configurable fee sharing
 * - `MeteoraDlmm` — Meteora Dynamic Liquidity Market Maker with bin-based pricing
 * - `PumpSwapBurn` — PumpSwap where LP tokens are burned (no ongoing fees)
 * - `PumpSwapHoldLp` — PumpSwap where LP tokens are held for fee claiming
 *
 * Meteora variants require `lpShare + stakerShare + holderShare === 100`.
 * Use {@link validateMigrationTarget} to check this at runtime.
 *
 * @example
 * ```ts
 * // Simple Raydium migration
 * const target: MigrationTarget = { raydiumCpmm: {} };
 *
 * // Meteora DLMM with 50% LP, 30% stakers, 20% holders
 * const meteora: MigrationTarget = {
 *   meteoraDlmm: { feeBps: 25, binStep: 10, lpShare: 50, stakerShare: 30, holderShare: 20 }
 * };
 * ```
 */
export type MigrationTarget =
  | { raydiumCpmm: Record<string, never> }
  | {
      meteoraDammV1: {
        /** Whether to enable Meteora's dynamic vault for fee reinvestment */
        enableDynamicVault: boolean;
        /** LP holders' share of protocol fees (0-100) */
        lpShare: number;
        /** Stakers' share of protocol fees (0-100) */
        stakerShare: number;
        /** Airdrop holders' share of protocol fees (0-100) */
        holderShare: number;
      };
    }
  | {
      meteoraDlmm: {
        /** Trading fee in basis points (e.g. 25 = 0.25%) */
        feeBps: number;
        /** Bin step for the DLMM pool (determines price granularity) */
        binStep: number;
        /** LP holders' share of protocol fees (0-100) */
        lpShare: number;
        /** Stakers' share of protocol fees (0-100) */
        stakerShare: number;
        /** Airdrop holders' share of protocol fees (0-100) */
        holderShare: number;
      };
    }
  | { pumpSwapBurn: Record<string, never> }
  | { pumpSwapHoldLp: Record<string, never> };

// ══════════════════════════════════════════════════════════════════════════════
// ON-CHAIN ACCOUNT STATE TYPES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Global protocol configuration — singleton PDA seeded with `["global_config"]`.
 *
 * Created once by the platform admin via `initialize()`. Controls protocol-wide
 * parameters: fee structure, graduation threshold, pause state.
 *
 * @example
 * ```ts
 * const config = await pulse.fetchGlobalConfig();
 * console.log(`Fee: ${config.feeBasisPoints} bps`);
 * console.log(`Graduation: ${config.graduationSolThreshold / 1e9} SOL`);
 * console.log(`Paused: ${config.paused}`);
 * ```
 */
export interface GlobalConfig {
  /** The admin authority that can pause/unpause the protocol */
  authority: PublicKey;
  /** Platform treasury wallet that receives 0.75% of every trade */
  platformWallet: PublicKey;
  /** Total fee in basis points (100 = 1%) */
  feeBasisPoints: number;
  /** Platform's share of the total fee in basis points (75 = 0.75%) */
  platformShareBps: number;
  /** Creator's share of the total fee in basis points (25 = 0.25%) */
  creatorShareBps: number;
  /** SOL threshold (in lamports) required for graduation (85 SOL = 85_000_000_000) */
  graduationSolThreshold: number;
  /** Minimum lamports to keep in fee_recipient PDA for gas (5_000_000 = 0.005 SOL) */
  minCreatorReserve: number;
  /** Whether the protocol is paused (no buys/sells allowed) */
  paused: boolean;
  /** PDA bump seed */
  bump: number;
}

/**
 * Per-token pool state — PDA seeded with `["pool_state", mint]`.
 *
 * This is the core account for every token on Pulse. It tracks the bonding
 * curve reserves, graduation status, and all PDA bumps for the token.
 *
 * **Reserve model:**
 * - `virtualSolReserves` / `virtualTokenReserves` — Constant-product AMM virtual reserves
 * - `realSolReserves` — Actual SOL lamports held in the fee_vault
 * - `realTokenReserves` — Tokens remaining from the 700M bonding supply
 * - `reserveTokensRemaining` — Tokens from the 97M reserve (only used for large buys)
 *
 * @example
 * ```ts
 * const pool = await pulse.fetchPool(mint);
 * console.log(`Price: ${Number(pool.virtualSolReserves) / Number(pool.virtualTokenReserves)} lamports/token`);
 * console.log(`SOL raised: ${Number(pool.realSolReserves) / 1e9} SOL`);
 * console.log(`Graduated: ${pool.graduated}`);
 * ```
 */
export interface PoolState {
  /** The token mint address */
  mint: PublicKey;
  /** The creator who launched this token */
  creator: PublicKey;
  /** Current authority that can claim fees and migration vault tokens */
  currentAuthority: PublicKey;
  /** The DEX this token will migrate to at graduation */
  migrationTarget: MigrationTarget;
  /** Virtual SOL reserves for constant-product pricing (starts at 30 SOL) */
  virtualSolReserves: bigint;
  /** Virtual token reserves for constant-product pricing (starts at ~1.073B) */
  virtualTokenReserves: bigint;
  /** Actual SOL lamports in the fee_vault */
  realSolReserves: bigint;
  /** Remaining tokens from the 700M bonding supply */
  realTokenReserves: bigint;
  /** Remaining tokens from the 97M reserve supply */
  reserveTokensRemaining: bigint;
  /** Whether this token has graduated to a DEX */
  graduated: boolean;
  /** The DEX pool address (set after migration) */
  dexPool: PublicKey | null;
  /** Unix timestamp of pool creation */
  createdAt: number;
  /** PDA bump for pool_state */
  bump: number;
  /** PDA bump for fee_vault */
  feeVaultBump: number;
  /** PDA bump for fee_recipient */
  feeRecipientBump: number;
  /** PDA bump for lp_reserve */
  lpReserveBump: number;
  /** PDA bump for pool_tokens */
  poolTokensBump: number;
  /** PDA bump for migration_vault */
  migrationVaultBump: number;
}

/**
 * Per-user staking account — PDA seeded with `["stake", mint, user]`.
 *
 * Tracks a user's staked token amount and reward checkpoint. Rewards are
 * proportional to `amountStaked / totalStaked` in the StakerVault.
 *
 * The `rewardDebt` field is a checkpoint: it stores the
 * `accumulatedRewardPerToken` value at the last stake/unstake/claim,
 * enabling O(1) pending reward calculation.
 */
export interface StakeAccount {
  /** The staker's wallet address */
  owner: PublicKey;
  /** The token mint being staked */
  mint: PublicKey;
  /** Amount of tokens staked (raw units with decimals) */
  amountStaked: bigint;
  /** Unix timestamp of first stake */
  stakedAt: number;
  /** Unix timestamp of last reward claim */
  lastClaimed: number;
  /** Reward checkpoint — accumulatedRewardPerToken at last snapshot */
  rewardDebt: bigint;
  /** PDA bump */
  bump: number;
}

/**
 * Per-token staking vault — PDA seeded with `["staker_vault", mint]`.
 *
 * Tracks global staking state for a token. Holds both the on-chain data
 * (reward accumulator) and the actual SOL lamports distributed as staker rewards.
 *
 * The `accumulatedRewardPerToken` is a running accumulator incremented
 * whenever new SOL rewards arrive. It uses a precision multiplier of 1e12
 * to avoid floating-point math.
 */
export interface StakerVault {
  /** The token mint */
  mint: PublicKey;
  /** Total tokens staked across all users */
  totalStaked: bigint;
  /** Running reward accumulator (per token, scaled by 1e12) */
  accumulatedRewardPerToken: bigint;
  /** Total SOL lamports distributed as staker rewards */
  totalDistributed: bigint;
  /** PDA bump */
  bump: number;
}

/**
 * Pre-configured migration parameters — PDA seeded with `["migration_config", mint]`.
 *
 * Created during token creation (step 1c) so that `migrate()` is fully
 * permissionless — no caller-supplied DEX accounts needed.
 */
export interface MigrationConfig {
  /** The token mint */
  mint: PublicKey;
  /** The migration target (same as in PoolState) */
  migrationTarget: MigrationTarget;
  /** DEX program ID (Raydium / Meteora / PumpSwap) */
  dexProgramId: PublicKey;
  /** Optional Meteora fee-sharing config account */
  feeShareConfig: PublicKey | null;
  /** Pre-computed DEX pool address */
  dexPool: PublicKey;
  /** DEX token account to receive LP tokens */
  dexTokenAccount: PublicKey;
  /** Creator fee_recipient for post-migration LP fees */
  feeRecipient: PublicKey;
  /** PDA bump */
  bump: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// INSTRUCTION PARAMETER TYPES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Parameters for buying tokens from the bonding curve.
 *
 * @example
 * ```ts
 * const params: BuyParams = {
 *   mint: new PublicKey("..."),
 *   solAmount: BigInt(1_000_000_000),  // 1 SOL
 *   minTokensOut: BigInt(500_000_000), // minimum tokens to accept
 * };
 * ```
 */
export interface BuyParams {
  /** The token mint to buy */
  mint: PublicKey;
  /** SOL amount in lamports to spend */
  solAmount: bigint;
  /** Minimum tokens to receive (slippage protection) */
  minTokensOut: bigint;
}

/**
 * Parameters for selling tokens back to the bonding curve.
 */
export interface SellParams {
  /** The token mint to sell */
  mint: PublicKey;
  /** Token amount in raw units to sell */
  tokenAmount: bigint;
  /** Minimum SOL to receive (slippage protection) */
  minSolOut: bigint;
}

/**
 * Parameters for creating a new token on the bonding curve.
 *
 * The token creation process is 4 on-chain steps:
 * 1. `createToken` — mint + metadata + PoolState
 * 2. `createTokenAccounts` — pool token account + LP reserve
 * 3. `createStakerVault` — staker vault + fee vaults + MigrationConfig
 * 4. `initializePool` — mint 700M+97M+300M tokens, revoke authority, deposit SOL
 */
export interface CreateTokenParams {
  /** Token name (max 32 chars) */
  name: string;
  /** Token symbol (max 10 chars) */
  symbol: string;
  /** Metadata URI pointing to off-chain JSON (max 200 chars) */
  uri: string;
  /** DEX destination for graduation */
  migrationTarget: MigrationTarget;
  /** Initial SOL deposit in lamports (minimum 20_000_000 = 0.02 SOL) */
  initialSolDeposit?: bigint;
}

/**
 * Full token creation parameters including creator and mint keypairs.
 * Used by the high-level `createToken()` convenience method.
 */
export interface CreateTokenFullParams extends CreateTokenParams {
  /** The creator's keypair (must sign all 4 steps) */
  creator: { publicKey: PublicKey; signTransaction: (tx: any) => Promise<any> };
  /** The mint keypair (generated randomly or provided) */
  mint: { publicKey: PublicKey };
  /** DEX program ID for the migration target */
  dexProgramId: PublicKey;
  /** Pre-created DEX pool address (can be a placeholder on localnet) */
  dexPool: PublicKey;
  /** DEX token account (can be a placeholder on localnet) */
  dexTokenAccount: PublicKey;
  /** Fee recipient wallet for creator's share */
  feeRecipient: PublicKey;
}

/**
 * Parameters for staking tokens to earn post-graduation fee share.
 */
export interface StakeParams {
  /** The token mint to stake */
  mint: PublicKey;
  /** Amount to stake in raw token units */
  amount: bigint;
}

/**
 * Parameters for unstaking tokens.
 */
export interface UnstakeParams {
  /** The token mint to unstake */
  mint: PublicKey;
  /** Amount to unstake in raw token units */
  amount: bigint;
}

/**
 * Parameters for claiming creator trading fees.
 */
export interface ClaimFeesParams {
  /** The token mint */
  mint: PublicKey;
}

/**
 * Parameters for claiming tokens from the migration vault.
 */
export interface ClaimMigrationVaultParams {
  /** The token mint */
  mint: PublicKey;
}

/**
 * Parameters for transferring creator authority to a new wallet.
 */
export interface TransferAuthorityParams {
  /** The token mint */
  mint: PublicKey;
  /** The new authority wallet address */
  newAuthority: PublicKey;
}

/**
 * Parameters for claiming post-graduation LP fees.
 * Permissionless — anyone can call this to trigger the crank.
 */
export interface ClaimLpFeesParams {
  /** The token mint */
  mint: PublicKey;
}

// ══════════════════════════════════════════════════════════════════════════════
// QUOTE / SIMULATION TYPES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Result of a buy simulation. Contains all the information needed to
 * display a quote to the user and submit the transaction.
 *
 * @example
 * ```ts
 * const quote: BuyQuote = await pulse.simulateBuy(mint, BigInt(1_000_000_000));
 * console.log(`
 *   You spend:     1.0000 SOL
 *   You receive:   ${formatTokenAmount(quote.tokensOut)} tokens
 *   Price/token:   ${quote.pricePerToken} lamports
 *   Price impact:  ${quote.priceImpact.toFixed(2)}%
 *   Platform fee:  ${Number(quote.platformFee) / 1e9} SOL
 *   Creator fee:   ${Number(quote.creatorFee) / 1e9} SOL
 *   Net to curve:  ${Number(quote.netSol) / 1e9} SOL
 *   Will graduate: ${quote.willGraduate}
 * `);
 * ```
 */
export interface BuyQuote {
  /** Tokens the buyer will receive (raw units) */
  tokensOut: bigint;
  /** Price per token in lamports (netSol / tokensOut) */
  pricePerToken: number;
  /** Price impact as a percentage (how much this trade moves the price) */
  priceImpact: number;
  /** Platform fee in lamports (0.75% of solAmount) */
  platformFee: bigint;
  /** Creator fee in lamports (0.25% of solAmount) */
  creatorFee: bigint;
  /** Net SOL entering the bonding curve (solAmount - totalFee) */
  netSol: bigint;
  /** Whether this buy will push the pool past the graduation threshold */
  willGraduate: boolean;
  /** SOL needed to reach graduation after this buy (0n if willGraduate) */
  solToGraduationAfter: bigint;
  /** New virtual SOL reserves after this buy */
  newVirtualSolReserves: bigint;
  /** New virtual token reserves after this buy */
  newVirtualTokenReserves: bigint;
  /** New spot price in SOL per token after this buy */
  newSpotPriceSol: number;
  /** Tokens drawn from the 700M bonding supply */
  fromBonding: bigint;
  /** Tokens drawn from the 97M reserve (0n unless bonding is exhausted) */
  fromReserve: bigint;
}

/**
 * Result of a sell simulation.
 */
export interface SellQuote {
  /** Gross SOL output from the curve (before fees) */
  solOut: bigint;
  /** Price per token in lamports (solOutGross / tokenAmount) */
  pricePerToken: number;
  /** Price impact as a percentage */
  priceImpact: number;
  /** Platform fee in lamports (0.75% of solOutGross) */
  platformFee: bigint;
  /** Creator fee in lamports (0.25% of solOutGross) */
  creatorFee: bigint;
  /** Net SOL the seller receives (solOutGross - totalFee) */
  netSolToUser: bigint;
  /** New virtual SOL reserves after this sell */
  newVirtualSolReserves: bigint;
  /** New virtual token reserves after this sell */
  newVirtualTokenReserves: bigint;
  /** New spot price in SOL per token after this sell */
  newSpotPriceSol: number;
}

/**
 * Comprehensive token analysis combining on-chain state, quotes, and metadata.
 * Returned by `pulse.getTokenProfile()`.
 */
export interface TokenProfile {
  /** On-chain pool state */
  pool: PoolState | null;
  /** Current spot price in SOL */
  price: number;
  /** Graduation progress (0-100) */
  graduationProgress: number;
  /** Whether the token is ready to graduate */
  isReadyToGraduate: boolean;
  /** SOL needed to reach graduation */
  solToGraduation: bigint;
  /** Buy quote for 0.1 SOL */
  quoteSmall: BuyQuote | null;
  /** Buy quote for 1 SOL */
  quoteMedium: BuyQuote | null;
  /** Buy quote for 10 SOL */
  quoteLarge: BuyQuote | null;
  /** Total SOL raised (real_sol_reserves) */
  totalSolRaised: bigint;
  /** Tokens remaining in bonding supply */
  bondingSupplyRemaining: bigint;
  /** Tokens remaining in reserve supply */
  reserveSupplyRemaining: bigint;
  /** Percentage of bonding supply sold */
  percentBonded: number;
  /** Time since pool creation in seconds */
  ageSeconds: number;
  /** Human-readable age string */
  ageFormatted: string;
}

// ══════════════════════════════════════════════════════════════════════════════
// EVENT TYPES (Anchor events emitted by the program)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Emitted when a new token is created via `create_token`.
 */
export interface TokenCreatedEvent {
  mint: PublicKey;
  creator: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  migrationTarget: MigrationTarget;
  timestamp: number;
}

/**
 * Emitted on every buy trade.
 */
export interface BuyEvent {
  mint: PublicKey;
  buyer: PublicKey;
  solAmount: bigint;
  tokensOut: bigint;
  fromBonding: bigint;
  fromReserve: bigint;
  platformFee: bigint;
  creatorFee: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  timestamp: number;
}

/**
 * Emitted on every sell trade.
 */
export interface SellEvent {
  mint: PublicKey;
  seller: PublicKey;
  tokenAmount: bigint;
  solOut: bigint;
  platformFee: bigint;
  creatorFee: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  timestamp: number;
}

/**
 * Emitted when a token graduates to a DEX.
 */
export interface MigrateEvent {
  mint: PublicKey;
  migrationTarget: MigrationTarget;
  solDeposited: bigint;
  tokensDeposited: bigint;
  tokensBurned: bigint;
  tokensToMigrationVault: bigint;
  dexPool: PublicKey;
  timestamp: number;
}

/**
 * Emitted when a creator claims their fee share.
 */
export interface FeeClaimedEvent {
  mint: PublicKey;
  authority: PublicKey;
  amount: bigint;
  timestamp: number;
}

/**
 * Emitted when creator authority is transferred.
 */
export interface AuthorityTransferredEvent {
  mint: PublicKey;
  oldAuthority: PublicKey;
  newAuthority: PublicKey;
  timestamp: number;
}

/**
 * Emitted when LP fees are claimed post-graduation.
 */
export interface LpFeeClaimedEvent {
  mint: PublicKey;
  platformAmount: bigint;
  creatorAmount: bigint;
  timestamp: number;
}

/**
 * Emitted when a user stakes tokens.
 */
export interface StakeEvent {
  mint: PublicKey;
  staker: PublicKey;
  amount: bigint;
  timestamp: number;
}

/**
 * Emitted when a user unstakes tokens.
 */
export interface UnstakeEvent {
  mint: PublicKey;
  staker: PublicKey;
  amount: bigint;
  timestamp: number;
}

/**
 * Emitted when a user claims staker rewards.
 */
export interface StakeRewardClaimedEvent {
  mint: PublicKey;
  staker: PublicKey;
  amount: bigint;
  timestamp: number;
}

/**
 * Emitted when the graduation threshold is reached.
 */
export interface GraduationReadyEvent {
  mint: PublicKey;
  realSolReserves: bigint;
  threshold: bigint;
  timestamp: number;
}

/**
 * Union type of all Pulse protocol events.
 */
export type PulseEvent =
  | { type: "TokenCreated"; data: TokenCreatedEvent }
  | { type: "Buy"; data: BuyEvent }
  | { type: "Sell"; data: SellEvent }
  | { type: "Migrate"; data: MigrateEvent }
  | { type: "FeeClaimed"; data: FeeClaimedEvent }
  | { type: "AuthorityTransferred"; data: AuthorityTransferredEvent }
  | { type: "LpFeeClaimed"; data: LpFeeClaimedEvent }
  | { type: "Stake"; data: StakeEvent }
  | { type: "Unstake"; data: UnstakeEvent }
  | { type: "StakeRewardClaimed"; data: StakeRewardClaimedEvent }
  | { type: "GraduationReady"; data: GraduationReadyEvent };

// ══════════════════════════════════════════════════════════════════════════════
// SDK CONFIGURATION TYPES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Configuration for the Pulse SDK client.
 *
 * @example
 * ```ts
 * // Basic devnet connection
 * const pulse = Pulse.devnet();
 *
 * // Mainnet with enhanced providers
 * const pulse = Pulse.mainnet({
 *   url: "https://your-custom-rpc.com",
 *   commitment: "confirmed",
 *   alchemyApiKey: "alchemy-key",
 *   heliusApiKey: "helius-key",
 *   priorityFee: { microlamports: 10_000 },
 *   maxRetries: 3,
 * });
 * ```
 */
export interface RpcConfig {
  /** Custom RPC endpoint URL. Defaults to public Solana endpoints. */
  url?: string;
  /** Commitment level for RPC calls */
  commitment?: "processed" | "confirmed" | "finalized";
  /** Alchemy API key — enables wallet analytics methods */
  alchemyApiKey?: string;
  /** Helius API key — enables DAS API methods */
  heliusApiKey?: string;
  /** Default priority fee in microlamports per compute unit */
  priorityFee?: {
    /** Microlamports per compute unit (1_000_000 = 1 lamport/CU) */
    microlamports: number;
    /** Maximum total priority fee in lamports */
    maxLamports?: number;
  };
  /** Maximum retry count for failed RPC calls */
  maxRetries?: number;
  /** Retry delay in milliseconds */
  retryDelayMs?: number;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Wallet interface compatible with both raw keypairs and wallet adapters
(Phantom, Solflare, Backpack, etc.).
 */
export interface PulseWallet {
  /** The wallet's public key */
  publicKey: PublicKey;
  /** Sign a single transaction */
  signTransaction: (tx: any) => Promise<any>;
  /** Sign multiple transactions (optional — falls back to sequential signTransaction) */
  signAllTransactions?: (txs: any[]) => Promise<any[]>;
}

// ══════════════════════════════════════════════════════════════════════════════
// PAGINATION & SORTING
// ══════════════════════════════════════════════════════════════════════════════

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export type PoolSortField =
  | "createdAt"
  | "realSolReserves"
  | "virtualSolReserves"
  | "graduated";

export type SortDirection = "asc" | "desc";

export interface PoolFilter {
  /** Only return graduated pools */
  graduated?: boolean;
  /** Only return pools with this creator */
  creator?: PublicKey;
  /** Only return pools targeting this DEX */
  migrationTarget?: "raydiumCpmm" | "meteoraDammV1" | "meteoraDlmm" | "pumpSwapBurn" | "pumpSwapHoldLp";
  /** Minimum SOL raised */
  minSolRaised?: bigint;
  /** Maximum SOL raised */
  maxSolRaised?: bigint;
}

// ══════════════════════════════════════════════════════════════════════════════
// HELIUS DAS API TYPES
// ══════════════════════════════════════════════════════════════════════════════

export interface HeliusAsset {
  id: string;
  interface: string;
  content: {
    $schema: string;
    json_uri: string;
    metadata: {
      name: string;
      symbol: string;
      description?: string;
    };
    links?: {
      image?: string;
      external_url?: string;
    };
  };
  authorities?: Array<{
    address: string;
    scopes: string[];
  }>;
  compression?: {
    eligible: boolean;
    compressed: boolean;
    data_hash?: string;
    creator_hash?: string;
    asset_hash?: string;
    tree?: string;
    seq?: number;
    leaf_id?: number;
  };
  grouping?: Array<{
    group_key: string;
    group_value: string;
  }>;
  royalty?: {
    royalty_model: string;
    percent: number;
    basis_points: number;
    primary_sale_happened: boolean;
    locked: boolean;
  };
  creators?: Array<{
    address: string;
    share: number;
    verified: boolean;
  }>;
  ownership: {
    frozen: boolean;
    delegated: boolean;
    delegate?: string;
    ownership_model: string;
    owner: string;
  };
  supply?: {
    print_max_supply?: number;
    print_current_supply?: number;
    edition_nonce?: number;
  };
  mutable: boolean;
  burnt: boolean;
  token_info?: {
    symbol: string;
    balance: number;
    supply: number;
    decimals: number;
    token_program: string;
    associated_token_address?: string;
    price_info?: {
      price_per_token: number;
      total_price: number;
      currency: string;
    };
  };
}

export interface HeliusAssetsResponse {
  total: number;
  limit: number;
  page: number;
  items: HeliusAsset[];
}

export interface HeliusPriorityFeeEstimate {
  /** Recommended priority fee in microlamports */
  priorityFeeEstimate: number;
  /** Fee estimates by percentile */
  priorityFeeLevels: {
    min: number;
    low: number;
    medium: number;
    high: number;
    veryHigh: number;
    unsafeMax: number;
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// ALCHEMY API TYPES
// ══════════════════════════════════════════════════════════════════════════════

export interface AlchemyTokenBalance {
  contractAddress: string;
  tokenBalance: string;
  error: string | null;
  tokenMetadata?: {
    name?: string;
    symbol?: string;
    decimals?: number;
    logo?: string;
  };
}

export interface AlchemyAssetTransfersResponse {
  result: {
    transfers: AlchemyTransfer[];
    pageKey?: string;
  };
}

export interface AlchemyTransfer {
  hash: string;
  from: string;
  to: string;
  value: number;
  asset: string;
  category: string;
  blockNum: string;
  rawContract: {
    address: string;
    value: string;
  };
}

export interface AlchemyTokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  logo?: string;
}

// ══════════════════════════════════════════════════════════════════════════════
// TRANSACTION TYPES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Result of building a transaction without submitting it.
 * Useful for displaying transaction details to the user before signing.
 */
export interface BuiltTransaction {
  /** The transaction ready to be signed and submitted */
  transaction: any; // Transaction from @solana/web3.js
  /** Human-readable description of what this transaction does */
  description: string;
  /** Estimated compute units required */
  estimatedComputeUnits?: number;
  /** Estimated fee in lamports */
  estimatedFeeLamports?: number;
  /** Accounts that will be modified */
  affectedAccounts: PublicKey[];
  /** Whether this transaction creates new accounts (requires additional rent) */
  createsAccounts: boolean;
  /** Estimated rent cost in lamports (if createsAccounts) */
  estimatedRentLamports?: bigint;
}

/**
 * Result of submitting a transaction.
 */
export interface TransactionResult {
  /** The transaction signature */
  signature: string;
  /** The slot in which the transaction was confirmed */
  slot?: number;
  /** Whether the transaction succeeded */
  success: boolean;
  /** Error message if the transaction failed */
  error?: string;
  /** Compute units consumed */
  computeUnitsConsumed?: number;
  /** Fee paid in lamports */
  feeLamports?: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO TYPES
// ══════════════════════════════════════════════════════════════════════════════

export interface Portfolio {
  /** All SPL token balances from Alchemy */
  tokens: AlchemyTokenBalance[];
  /** Enriched token data from Helius */
  enrichedTokens: HeliusAsset[];
  /** Pulse bonding curve positions */
  bondingPositions: BondingPosition[];
  /** Total portfolio value in SOL (approximate) */
  totalValueSol: number;
  /** Total value in staked positions */
  totalStakedSol: number;
}

export interface BondingPosition {
  mint: string;
  pool: PoolState;
  tokenBalance: string;
  tokenBalanceRaw: bigint;
  /** Current value of the position in SOL (if sold immediately) */
  valueSol: number;
  /** Unrealized P&L in SOL (valueSol - costBasisSol) */
  unrealizedPnlSol: number;
  /** Whether this position is in a graduated pool */
  isGraduated: boolean;
  /** Staked amount (if any) */
  stakedAmount?: bigint;
  /** Pending staker rewards (if any) */
  pendingRewards?: bigint;
}
