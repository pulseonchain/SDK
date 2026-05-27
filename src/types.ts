import { PublicKey } from "@solana/web3.js";

// ─── Migration Target ─────────────────────────────────────────────────────────

export type MigrationTarget =
  | { raydiumCpmm: {} }
  | {
      meteoraDammV1: {
        enableDynamicVault: boolean;
        lpShare: number;
        stakerShare: number;
        holderShare: number;
      };
    }
  | {
      meteoraDlmm: {
        feeBps: number;
        binStep: number;
        lpShare: number;
        stakerShare: number;
        holderShare: number;
      };
    }
  | { pumpSwapBurn: {} }
  | { pumpSwapHoldLp: {} };

// ─── Account State Types ──────────────────────────────────────────────────────

export interface GlobalConfig {
  authority: PublicKey;
  platformWallet: PublicKey;
  feeBasisPoints: number;
  platformShareBps: number;
  creatorShareBps: number;
  graduationSolThreshold: number;
  minCreatorReserve: number;
  paused: boolean;
  bump: number;
}

export interface PoolState {
  mint: PublicKey;
  creator: PublicKey;
  currentAuthority: PublicKey;
  migrationTarget: MigrationTarget;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  reserveTokensRemaining: bigint;
  graduated: boolean;
  dexPool: PublicKey | null;
  createdAt: number;
  bump: number;
  feeVaultBump: number;
  feeRecipientBump: number;
  lpReserveBump: number;
  poolTokensBump: number;
  migrationVaultBump: number;
}

export interface StakeAccount {
  owner: PublicKey;
  mint: PublicKey;
  amountStaked: bigint;
  stakedAt: number;
  lastClaimed: number;
  rewardDebt: bigint;
  bump: number;
}

export interface StakerVault {
  mint: PublicKey;
  totalStaked: bigint;
  accumulatedRewardPerToken: bigint;
  totalDistributed: bigint;
  bump: number;
}

export interface MigrationConfig {
  mint: PublicKey;
  migrationTarget: MigrationTarget;
  dexProgramId: PublicKey;
  feeShareConfig: PublicKey | null;
  dexPool: PublicKey;
  dexTokenAccount: PublicKey;
  feeRecipient: PublicKey;
  bump: number;
}

// ─── Event Types ──────────────────────────────────────────────────────────────

export interface TokenCreatedEvent {
  mint: PublicKey;
  creator: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  migrationTarget: MigrationTarget;
  timestamp: number;
}

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

// ─── SDK Options ──────────────────────────────────────────────────────────────

export interface RpcConfig {
  /** RPC endpoint URL. Defaults to public devnet/mainnet. */
  url?: string;
  /** Commitment level */
  commitment?: "processed" | "confirmed" | "finalized";
  /** Alchemy API key — enables Alchemy-specific methods (see README) */
  alchemyApiKey?: string;
  /** Helius API key — enables Helius-specific methods (see README) */
  heliusApiKey?: string;
}

export interface BuyParams {
  mint: PublicKey;
  solAmount: bigint;
  minTokensOut: bigint;
}

export interface SellParams {
  mint: PublicKey;
  tokenAmount: bigint;
  minSolOut: bigint;
}

export interface CreateTokenParams {
  name: string;
  symbol: string;
  uri: string;
  migrationTarget: MigrationTarget;
  /** Initial SOL deposit (lamports). Minimum 0.02 SOL. */
  initialSolDeposit?: bigint;
}

export interface StakeParams {
  mint: PublicKey;
  amount: bigint;
}

export interface UnstakeParams {
  mint: PublicKey;
  amount: bigint;
}

// ─── Quote Types ──────────────────────────────────────────────────────────────

export interface BuyQuote {
  tokensOut: bigint;
  pricePerToken: number;
  priceImpact: number;
  platformFee: bigint;
  creatorFee: bigint;
  netSol: bigint;
}

export interface SellQuote {
  solOut: bigint;
  pricePerToken: number;
  priceImpact: number;
  platformFee: bigint;
  creatorFee: bigint;
  netSolToUser: bigint;
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginatedResult<T> {
  items: T[];
  total: number;
}

// ─── Helius Types ─────────────────────────────────────────────────────────────

export interface HeliusAsset {
  id: string;
  content: {
    metadata: {
      name: string;
      symbol: string;
    };
    links?: {
      image?: string;
    };
  };
  token_info?: {
    price_info?: {
      price_per_token: number;
      total_price: number;
    };
    supply: number;
    decimals: number;
  };
  grouping?: Array<{
    group_key: string;
    group_value: string;
  }>;
}

export interface HeliusAssetsResponse {
  total: number;
  limit: number;
  page: number;
  items: HeliusAsset[];
}

// ─── Alchemy Types ────────────────────────────────────────────────────────────

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
