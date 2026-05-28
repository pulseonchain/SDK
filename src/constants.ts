import { PublicKey } from "@solana/web3.js";

// ─── Program IDs ──────────────────────────────────────────────────────────────

/** Devnet program ID */
export const PROGRAM_ID_DEVNET = new PublicKey(
  "5q34BJ3g525q1nfS3cxrw6edrBidaz2RqcwBHRxKK33B"
);

/** Localnet program ID */
export const PROGRAM_ID_LOCALNET = new PublicKey(
  "5NLh9rQPR4EAZZpZfAJ3ujszffKjMJJCEGXxCBf4CRea"
);

/** Mainnet program ID — TODO: update after mainnet deployment */
export const PROGRAM_ID_MAINNET = new PublicKey(
  "5NLh9rQPR4EAZZpZfAJ3ujszffKjMJJCEGXxCBf4CRea"
);

// ─── Platform ─────────────────────────────────────────────────────────────────

export const PLATFORM_WALLET = new PublicKey(
  "EobUZD7H6TQRYfzqKsYEYekpKoFinKW1UWA4TsHidTqj"
);

// ─── Token Supply ─────────────────────────────────────────────────────────────

export const TOKEN_DECIMALS = 6;
export const TOTAL_SUPPLY = 1_097_052_391_304_347;
export const BONDING_SUPPLY = 700_000_000_000_000;
export const RESERVE_SUPPLY = 97_052_391_304_347;
export const LP_RESERVE_SUPPLY = 300_000_000_000_000;

// ─── Bonding Curve ────────────────────────────────────────────────────────────

export const INITIAL_VIRTUAL_SOL = 30_000_000_000;
export const INITIAL_VIRTUAL_TOKEN = 1_073_000_000_000_000;

// ─── Graduation ───────────────────────────────────────────────────────────────

export const GRADUATION_SOL_THRESHOLD = 85_000_000_000;

// ─── Fees ─────────────────────────────────────────────────────────────────────

export const TOTAL_FEE_BPS = 100;
export const PLATFORM_SHARE_BPS = 75;
export const CREATOR_SHARE_BPS = 25;
export const MIN_CREATOR_RESERVE = 5_000_000;

// ─── PDA Seeds ────────────────────────────────────────────────────────────────

export const SEED_GLOBAL_CONFIG = Buffer.from("global_config");
export const SEED_POOL_STATE = Buffer.from("pool_state");
export const SEED_FEE_VAULT = Buffer.from("fee_vault");
export const SEED_FEE_RECIPIENT = Buffer.from("fee_recipient");
export const SEED_POOL_TOKENS = Buffer.from("pool_tokens");
export const SEED_LP_RESERVE = Buffer.from("lp_reserve");
export const SEED_STAKE = Buffer.from("stake");
export const SEED_LP_TOKEN_VAULT = Buffer.from("lp_token_vault");
export const SEED_MIGRATION_VAULT = Buffer.from("migration_vault");
export const SEED_MIGRATION_CONFIG = Buffer.from("migration_config");
export const SEED_STAKER_VAULT = Buffer.from("staker_vault");
export const SEED_STAKE_TOKEN_VAULT = Buffer.from("stake_token_vault");
export const SEED_POOL_STATS = Buffer.from("pool_stats");
export const SEED_WHITELIST_CONFIG = Buffer.from("whitelist_config");
export const SEED_WHITELIST_RECORD = Buffer.from("wl_record");
export const SEED_REFERRAL_CONFIG = Buffer.from("referral_config");
export const SEED_REFERRAL_RECORD = Buffer.from("referral_record");

// ─── External Programs ────────────────────────────────────────────────────────

export const METAPLEX_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);
export const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey(
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"
);
export const METEORA_DAMM_PROGRAM_ID = new PublicKey(
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkSCmrAP"
);
export const METEORA_DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLLjggiJmV1fTTCkUscX"
);
export const PUMP_SWAP_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);
export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
export const SYSTEM_PROGRAM_ID = new PublicKey(
  "11111111111111111111111111111111"
);

// ─── Cluster Configs ──────────────────────────────────────────────────────────

export interface ClusterConfig {
  name: string;
  programId: PublicKey;
  rpcUrl: string;
}

export const CLUSTERS: Record<string, ClusterConfig> = {
  localnet: {
    name: "localnet",
    programId: PROGRAM_ID_LOCALNET,
    rpcUrl: "http://127.0.0.1:8899",
  },
  devnet: {
    name: "devnet",
    programId: PROGRAM_ID_DEVNET,
    rpcUrl: "https://api.devnet.solana.com",
  },
  mainnet: {
    name: "mainnet-beta",
    programId: PROGRAM_ID_MAINNET,
    rpcUrl: "https://api.mainnet-beta.solana.com",
  },
};
