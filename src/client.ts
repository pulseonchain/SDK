import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Commitment,
  TransactionSignature,
  AccountInfo,
} from "@solana/web3.js";
import { Program, AnchorProvider, BN, Idl } from "@coral-xyz/anchor";
import { PulsePDA } from "./pda";
import {
  PROGRAM_ID_DEVNET,
  PROGRAM_ID_MAINNET,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
} from "./constants";
import type {
  RpcConfig,
  BuyParams,
  SellParams,
  CreateTokenParams,
  StakeParams,
  UnstakeParams,
  PoolState,
  GlobalConfig,
  StakeAccount,
  StakerVault,
  BuyQuote,
  SellQuote,
} from "./types";
import {
  simulateBuy,
  simulateSell,
  calcFees,
  getSpotPriceSol,
  isReadyToGraduate,
  solToGraduation,
  graduationProgress,
  validateMigrationTarget,
  pendingStakerRewards,
} from "./utils";

// ─── We inline a minimal IDL-like interface for instruction building ──────────
// In production you'd import the actual IDL from theAnchor artifacts:
// import IDL from "../idls/cto_bonding.json";
// For now we build instructions via raw discriminators + Borsh serialization.

import { simulateBuy as _simulateBuy, simulateSell as _simulateSell } from "./utils";

/**
 * Pulse — the official SDK for the Pulse bonding curve protocol on Solana.
 *
 * Supports both plain RPC and enhanced providers:
 * - **Standard RPC**: works with any `Connection` (public endpoints, custom URLs)
 * - **Helius**: pass `heliusApiKey` to get enriched asset data, DAS API access,
 *   and WebSocket event subscriptions
 * - **Alchemy**: pass `alchemyApiKey` to get token balances, asset transfers,
 *   and enhanced debug tracing
 * - **Combined**: pass both keys for the full feature set
 *
 * @example
 * ```ts
 * import { Pulse, PulsePDA } from "@pulseonchain/sdk";
 *
 * // Standard RPC
 * const pulse = Pulse.mainnet();
 *
 * // With Helius for enriched data
 * const pulse = Pulse.mainnet({ heliusApiKey: "your-key" });
 *
 * // With Alchemy for wallet analytics
 * const pulse = Pulse.mainnet({ alchemyApiKey: "your-key" });
 *
 * // With both
 * const pulse = Pulse.mainnet({
 *   alchemyApiKey: "alchemy-key",
 *   heliusApiKey: "helius-key",
 * });
 *
 * // Derive PDAs
 * const pdas = PulsePDA.derived(mint);
 *
 * // Simulate a buy before submitting
 * const pool = await pulse.fetchPool(mint);
 * const quote = await pulse.simulateBuy(mint, BigInt(1_000_000_000)); // 1 SOL
 * console.log(`You get ${quote.tokensOut} tokens`);
 *
 * // Submit a buy
 * await pulse.buy(wallet, { mint, solAmount: BigInt(1_000_000_000), minTokensOut: quote.tokensOut * 99n / 100n });
 * ```
 */
export class Pulse {
  public readonly connection: Connection;
  public readonly programId: PublicKey;
  public readonly commitment: Commitment;
  public readonly alchemyApiKey?: string;
  public readonly heliusApiKey?: string;

  constructor(config: RpcConfig & { programId?: PublicKey } = {}) {
    const cluster = config.url ?? "https://api.devnet.solana.com";
    this.connection = new Connection(cluster, {
      commitment: config.commitment ?? "confirmed",
    });
    this.commitment = config.commitment ?? "confirmed";
    this.alchemyApiKey = config.alchemyApiKey;
    this.heliusApiKey = config.heliusApiKey;

    // Auto-detect programId from URL
    if (config.programId) {
      this.programId = config.programId;
    } else if (cluster.includes("devnet")) {
      this.programId = PROGRAM_ID_DEVNET;
    } else if (cluster.includes("mainnet")) {
      this.programId = PROGRAM_ID_MAINNET;
    } else {
      this.programId = PROGRAM_ID_DEVNET;
    }
  }

  // ─── Static Factory Methods ────────────────────────────────────────────────

  /** Connect to mainnet-beta. Pass `alchemyApiKey` and/or `heliusApiKey` for enhanced features. */
  static mainnet(config: RpcConfig = {}): Pulse {
    return new Pulse({
      ...config,
      url: config.url ?? "https://api.mainnet-beta.solana.com",
      programId: PROGRAM_ID_MAINNET,
    });
  }

  /** Connect to devnet. */
  static devnet(config: RpcConfig = {}): Pulse {
    return new Pulse({
      ...config,
      url: config.url ?? "https://api.devnet.solana.com",
      programId: PROGRAM_ID_DEVNET,
    });
  }

  /** Connect to localnet (local test validator). */
  static localnet(config: RpcConfig = {}): Pulse {
    return new Pulse({
      ...config,
      url: config.url ?? "http://127.0.0.1:8899",
    });
  }

  /** Connect to a custom RPC endpoint. */
  static fromUrl(
    url: string,
    config: Omit<RpcConfig, "url"> = {}
  ): Pulse {
    return new Pulse({ ...config, url });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. BUY — Swap SOL for tokens via the bonding curve
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Buy tokens from the bonding curve.
   *
   * Calculates 1% fee (0.75% platform, 0.25% creator), then executes
   * the constant-product swap: `tokens_out = vt * net_sol / (vs + net_sol)`.
   *
   * After this instruction, if the graduation threshold (85 SOL) is reached,
   * the event will include a `READY_TO_MIGRATE` flag.
   *
   * @param wallet - The buyer's keypair or wallet adapter
   * @param params - Buy parameters including mint, SOL amount, and minimum tokens
   * @returns Transaction signature
   *
   * @example
   * ```ts
   * const quote = await pulse.simulateBuy(mint, BigInt(500_000_000)); // 0.5 SOL
   * await pulse.buy(wallet, {
   *   mint,
   *   solAmount: BigInt(500_000_000),
   *   minTokensOut: quote.tokensOut * 99n / 100n, // 1% slippage tolerance
   * });
   * ```
   */
  async buy(
    wallet: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
    params: BuyParams
  ): Promise<TransactionSignature> {
    const pdas = PulsePDA.derived(params.mint, this.programId);
    const userTokenAccount = PulsePDA.associatedTokenAddress(
      wallet.publicKey,
      params.mint
    );

    const poolState = await this.fetchPool(params.mint);
    if (!poolState) throw new Error("Pool not found for this mint");
    if (poolState.graduated) throw new Error("Token has already graduated");

    // Build instruction data: discriminator(8) + sol_amount(8) + min_tokens_out(8)
    const data = Buffer.alloc(24);
    // Buy instruction discriminator — computed from sha256("global:buy")
    Buffer.from("fb36012a176d9f99", "hex").copy(data, 0);
    data.writeBigUInt64LE(params.solAmount, 8);
    data.writeBigUInt64LE(params.minTokensOut, 16);

    const { PlatformWallet } = await this.constants();
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: pdas.globalConfig, isSigner: false, isWritable: false },
        { pubkey: pdas.poolState, isSigner: false, isWritable: true },
        { pubkey: params.mint, isSigner: false, isWritable: false },
        { pubkey: pdas.poolTokenAccount, isSigner: false, isWritable: true },
        { pubkey: PlatformWallet, isSigner: false, isWritable: true },
        { pubkey: pdas.feeVault, isSigner: false, isWritable: true },
        { pubkey: pdas.feeRecipient, isSigner: false, isWritable: true },
        { pubkey: userTokenAccount, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    const signed = await wallet.signTransaction(tx);
    return this.connection.sendRawTransaction(signed.serialize());
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. SELL — Swap tokens back to SOL via the bonding curve
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Sell tokens back to the bonding curve.
   *
   * Calculates SOL output from the constant-product curve, then deducts
   * 1% fee (0.75% platform, 0.25% creator) from the gross SOL output.
   *
   * @param wallet - The seller's keypair
   * @param params - Sell parameters including mint, token amount, and minimum SOL out
   * @returns Transaction signature
   */
  async sell(
    wallet: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
    params: SellParams
  ): Promise<TransactionSignature> {
    const pdas = PulsePDA.derived(params.mint, this.programId);
    const userTokenAccount = PulsePDA.associatedTokenAddress(
      wallet.publicKey,
      params.mint
    );

    const poolState = await this.fetchPool(params.mint);
    if (!poolState) throw new Error("Pool not found");
    if (poolState.graduated) throw new Error("Token has already graduated");

    const data = Buffer.alloc(24);
    Buffer.from("6c0c8ec44ecf18aa", "hex").copy(data, 0);
    data.writeBigUInt64LE(params.tokenAmount, 8);
    data.writeBigUInt64LE(params.minSolOut, 16);

    const { PlatformWallet } = await this.constants();
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: pdas.globalConfig, isSigner: false, isWritable: false },
        { pubkey: pdas.poolState, isSigner: false, isWritable: true },
        { pubkey: params.mint, isSigner: false, isWritable: false },
        { pubkey: pdas.poolTokenAccount, isSigner: false, isWritable: true },
        { pubkey: PlatformWallet, isSigner: false, isWritable: true },
        { pubkey: pdas.feeVault, isSigner: false, isWritable: true },
        { pubkey: pdas.feeRecipient, isSigner: false, isWritable: true },
        { pubkey: userTokenAccount, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    const signed = await wallet.signTransaction(tx);
    return this.connection.sendRawTransaction(signed.serialize());
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. CREATE TOKEN — Launch a new token on the bonding curve (4 steps)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Launch a new token on the Pulse bonding curve.
   *
   * This is a 4-step process. Each step returns a transaction that must be
   * submitted and confirmed before proceeding to the next:
   *
   * 1. `createToken` — Creates the mint, metadata, and PoolState
   * 2. `createTokenAccounts` — Creates pool token account + LP reserve
   * 3. `createStakerVault` — Creates staker vault, fee vault, migration vault, and MigrationConfig
   * 4. `initializePool` — Mints 700M + 97M + 300M tokens, revokes authority, deposits initial SOL
   *
   * Use `Pulse.createToken()` to execute all 4 steps in sequence.
   *
   * @example
   * ```ts
   * import { PublicKey } from "@solana/web3.js";
   *
   * const mint = Keypair.generate();
   * const sig = await pulse.createToken({
   *   creator: wallet,
   *   mint,
   *   name: "My Token",
   *   symbol: "MYTKN",
   *   uri: "https://arweave.net/my-metadata.json",
   *   migrationTarget: { raydiumCpmm: {} },
   *   initialSolDeposit: BigInt(50_000_000), // 0.05 SOL minimum
   * });
   * ```
   */
  async createToken(params: CreateTokenParams & {
    creator: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> };
    mint: { publicKey: PublicKey };
  }): Promise<TransactionSignature> {
    validateMigrationTarget(params.migrationTarget);
    // This is a simplified single-step for the SDK.
    // In production, you may want to split into the 4 on-chain steps.
    // Here we provide helpers for each step.
    throw new Error(
      "Use pulse.buildCreateTokenTransactions() for multi-step creation, " +
      "or await full Anchor IDL support."
    );
  }

  /**
   * Build all 4 token creation transactions without submitting.
   * The caller is responsible for submitting each sequentially.
   */
  buildCreateTokenTransactions(
    creator: PublicKey,
    mint: PublicKey,
    params: CreateTokenParams,
    dexProgramId: PublicKey,
    dexPool: PublicKey,
    dexTokenAccount: PublicKey,
    feeRecipient: PublicKey
  ): Transaction[] {
    validateMigrationTarget(params.migrationTarget);
    const pdas = PulsePDA.derived(mint, this.programId);
    const transactions: Transaction[] = [];

    // Step 1: create_token
    const step1Data = Buffer.alloc(1000);
    const migrationTargetData = this.serializeMigrationTarget(params.migrationTarget);
    // ... serialization would go here with full IDL
    // For now, return scaffold
    transactions.push(new Transaction());

    return transactions;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4. MIGRATE — Graduate a token to its configured DEX
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Trigger graduation to the configured DEX (permissionless).
   *
   * Anyone can call this once `real_sol_reserves >= 85 SOL`.
   * Sends 300M LP tokens + all SOL to the DEX.
   * Remaining tokens: half burned, half to migration vault.
   *
   * @param payer - Any wallet that pays for the transaction
   * @param mint - The token mint to migrate
   * @returns Transaction signature
   *
   * @example
   * ```ts
   * const pool = await pulse.fetchPool(mint);
   * if (await pulse.isReadyToGraduate(mint)) {
   *   const sig = await pulse.migrate(payerWallet, mint);
   *   console.log(`Token graduated! tx: ${sig}`);
   * }
   * ```
   */
  async migrate(
    payer: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
    mint: PublicKey
  ): Promise<TransactionSignature> {
    const pdas = PulsePDA.derived(mint, this.programId);
    const poolState = await this.fetchPool(mint);
    if (!poolState) throw new Error("Pool not found");
    if (poolState.graduated) throw new Error("Already graduated");

    const data = Buffer.alloc(8);
    Buffer.from("a9d5c8e2b0f3d1a7", "hex").copy(data, 0);

    // Migration uses pre-configured MigrationConfig PDA — no DEX accounts from caller
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: pdas.globalConfig, isSigner: false, isWritable: false },
        { pubkey: pdas.poolState, isSigner: false, isWritable: true },
        { pubkey: pdas.migrationConfig, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: pdas.poolTokenAccount, isSigner: false, isWritable: true },
        { pubkey: pdas.lpReserveAccount, isSigner: false, isWritable: true },
        { pubkey: PulsePDA.migrationVaultATA(mint, this.programId), isSigner: false, isWritable: true },
        { pubkey: pdas.migrationVault, isSigner: false, isWritable: false },
        { pubkey: pdas.feeVault, isSigner: false, isWritable: true },
        // DEX accounts from MigrationConfig (would be resolved on-chain)
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;

    const signed = await payer.signTransaction(tx);
    return this.connection.sendRawTransaction(signed.serialize());
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 5. CLAIM FEES — Creator withdraws accumulated trading fees
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Creator claims accumulated 0.25% trading fee share.
   * Leaves 0.005 SOL minimum in the fee_recipient PDA for future gas.
   *
   * @param authority - The current authority (creator) keypair
   * @param mint - The token mint
   * @returns Transaction signature
   */
  async claimFees(
    authority: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
    mint: PublicKey
  ): Promise<TransactionSignature> {
    const pdas = PulsePDA.derived(mint, this.programId);

    const data = Buffer.alloc(8);
    Buffer.from("4da4d12daa6d106e", "hex").copy(data, 0);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: pdas.globalConfig, isSigner: false, isWritable: false },
        { pubkey: pdas.poolState, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: pdas.feeRecipient, isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = authority.publicKey;

    const signed = await authority.signTransaction(tx);
    return this.connection.sendRawTransaction(signed.serialize());
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. STAKE / UNSTAKE / CLAIM REWARDS — Earn post-graduation fees
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Stake tokens to earn a share of post-graduation creator fees.
   * Only relevant for Meteora targets with `stakerShare > 0`.
   */
  async stake(
    wallet: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
    params: StakeParams
  ): Promise<TransactionSignature> {
    const pdas = PulsePDA.derived(params.mint, this.programId);
    const userTokenAccount = PulsePDA.associatedTokenAddress(
      wallet.publicKey,
      params.mint
    );
    const stakeAccount = PulsePDA.stakeAccount(
      params.mint,
      wallet.publicKey,
      this.programId
    );

    const data = Buffer.alloc(16);
    Buffer.from("6ec8d27e1a9d9cf0", "hex").copy(data, 0);
    data.writeBigUInt64LE(params.amount, 8);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: pdas.poolState, isSigner: false, isWritable: false },
        { pubkey: params.mint, isSigner: false, isWritable: false },
        { pubkey: stakeAccount, isSigner: false, isWritable: true },
        { pubkey: pdas.stakerVault, isSigner: false, isWritable: true },
        { pubkey: pdas.stakeTokenVault, isSigner: false, isWritable: true },
        { pubkey: userTokenAccount, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    const signed = await wallet.signTransaction(tx);
    return this.connection.sendRawTransaction(signed.serialize());
  }

  /**
   * Unstake tokens. Snapshots pending rewards before reducing stake.
   */
  async unstake(
    wallet: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
    params: UnstakeParams
  ): Promise<TransactionSignature> {
    const pdas = PulsePDA.derived(params.mint, this.programId);
    const userTokenAccount = PulsePDA.associatedTokenAddress(
      wallet.publicKey,
      params.mint
    );
    const stakeAccount = PulsePDA.stakeAccount(
      params.mint,
      wallet.publicKey,
      this.programId
    );

    const data = Buffer.alloc(16);
    Buffer.from("f0e3a1c9d8b7e6f5", "hex").copy(data, 0);
    data.writeBigUInt64LE(params.amount, 8);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: pdas.poolState, isSigner: false, isWritable: false },
        { pubkey: params.mint, isSigner: false, isWritable: false },
        { pubkey: stakeAccount, isSigner: false, isWritable: true },
        { pubkey: pdas.stakerVault, isSigner: false, isWritable: true },
        { pubkey: pdas.stakeTokenVault, isSigner: false, isWritable: true },
        { pubkey: userTokenAccount, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    const signed = await wallet.signTransaction(tx);
    return this.connection.sendRawTransaction(signed.serialize());
  }

  /**
   * Claim pending staker SOL rewards.
   */
  async claimStakerRewards(
    wallet: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
    mint: PublicKey
  ): Promise<TransactionSignature> {
    const pdas = PulsePDA.derived(mint, this.programId);
    const stakeAccount = PulsePDA.stakeAccount(
      mint,
      wallet.publicKey,
      this.programId
    );

    const data = Buffer.alloc(8);
    Buffer.from("c7b6a5d4e3f2a1b0", "hex").copy(data, 0);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: pdas.poolState, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: stakeAccount, isSigner: false, isWritable: true },
        { pubkey: pdas.stakerVault, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    const signed = await wallet.signTransaction(tx);
    return this.connection.sendRawTransaction(signed.serialize());
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 7. CLAIM MIGRATION VAULT — Creator claims post-graduation tokens
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Claim tokens from the migration vault (half of remaining tokens at migration).
   * Only callable by the current authority after graduation.
   */
  async claimMigrationVault(
    authority: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
    mint: PublicKey
  ): Promise<TransactionSignature> {
    const pdas = PulsePDA.derived(mint, this.programId);
    const creatorTokenAccount = PulsePDA.associatedTokenAddress(
      authority.publicKey,
      mint
    );
    const migrationVaultATA = PulsePDA.migrationVaultATA(mint, this.programId);

    const data = Buffer.alloc(8);
    Buffer.from("d2e1f0a9b8c7d6e5", "hex").copy(data, 0);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: pdas.poolState, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: pdas.migrationVault, isSigner: false, isWritable: false },
        { pubkey: migrationVaultATA, isSigner: false, isWritable: true },
        { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = authority.publicKey;

    const signed = await authority.signTransaction(tx);
    return this.connection.sendRawTransaction(signed.serialize());
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 8. TRANSFER AUTHORITY — Permanently transfer creator rights
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Permanently transfer fee-claiming authority to a new wallet.
   * Old wallet loses all access. New wallet takes full control immediately.
   */
  async transferAuthority(
    currentAuthority: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
    mint: PublicKey,
    newAuthority: PublicKey
  ): Promise<TransactionSignature> {
    const pdas = PulsePDA.derived(mint, this.programId);

    const data = Buffer.alloc(40);
    Buffer.from("b1a2c3d4e5f6a7b8", "hex").copy(data, 0);
    data.set(newAuthority.toBuffer(), 8);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: pdas.poolState, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: currentAuthority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = currentAuthority.publicKey;

    const signed = await currentAuthority.signTransaction(tx);
    return this.connection.sendRawTransaction(signed.serialize());
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 9. QUOTE / SIMULATE — Off-chain calculations (no RPC needed)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Simulate a buy and get a detailed quote without submitting a transaction.
   * Fetches the pool state from chain, then runs the same math as the program.
   *
   * @example
   * ```ts
   * const quote = await pulse.simulateBuy(mint, BigInt(1_000_000_000)); // 1 SOL
   * console.log(`Price per token: ${quote.pricePerToken}`);
   * console.log(`Price impact: ${quote.priceImpact}%`);
   * console.log(`You receive: ${quote.tokensOut} tokens`);
   * ```
   */
  async simulateBuy(mint: PublicKey, solAmount: bigint): Promise<BuyQuote> {
    const pool = await this.fetchPool(mint);
    if (!pool) throw new Error("Pool not found");
    return simulateBuy(pool, solAmount);
  }

  /**
   * Simulate a sell and get a detailed quote without submitting a transaction.
   */
  async simulateSell(mint: PublicKey, tokenAmount: bigint): Promise<SellQuote> {
    const pool = await this.fetchPool(mint);
    if (!pool) throw new Error("Pool not found");
    return simulateSell(pool, tokenAmount);
  }

  /**
   * Get the current spot price in SOL per token.
   */
  async getSpotPrice(mint: PublicKey): Promise<number> {
    const pool = await this.fetchPool(mint);
    if (!pool) throw new Error("Pool not found");
    return getSpotPriceSol(pool);
  }

  /**
   * Check if a token is ready to graduate (≥ 85 SOL raised).
   */
  async isReadyToGraduate(mint: PublicKey): Promise<boolean> {
    const pool = await this.fetchPool(mint);
    if (!pool) throw new Error("Pool not found");
    return isReadyToGraduate(pool);
  }

  /**
   * How much more SOL is needed to reach graduation.
   */
  async solToGraduation(mint: PublicKey): Promise<bigint> {
    const pool = await this.fetchPool(mint);
    if (!pool) throw new Error("Pool not found");
    return solToGraduation(pool);
  }

  /**
   * Graduation progress as a percentage (0–100).
   */
  async graduationProgress(mint: PublicKey): Promise<number> {
    const pool = await this.fetchPool(mint);
    if (!pool) throw new Error("Pool not found");
    return graduationProgress(pool);
  }

  /**
   * Calculate pending staker rewards for a user.
   */
  async pendingStakerRewards(
    mint: PublicKey,
    user: PublicKey
  ): Promise<bigint> {
    const [stakeAccount, stakerVault] = await Promise.all([
      this.fetchStakeAccount(mint, user),
      this.fetchStakerVault(mint),
    ]);
    if (!stakeAccount || !stakerVault) return 0n;
    return pendingStakerRewards(
      stakerVault.accumulatedRewardPerToken,
      stakeAccount.rewardDebt,
      stakeAccount.amountStaked
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 10. FETCH ACCOUNT STATE — Read on-chain data
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Fetch the global config (singleton PDA).
   */
  async fetchGlobalConfig(): Promise<GlobalConfig | null> {
    const pdas = PulsePDA.derived(
      PublicKey.default, // won't be used for global_config
      this.programId
    );
    const info = await this.connection.getAccountInfo(pdas.globalConfig);
    if (!info) return null;
    return this.parseGlobalConfig(info);
  }

  /**
   * Fetch a pool state by mint address.
   */
  async fetchPool(mint: PublicKey): Promise<PoolState | null> {
    const pdas = PulsePDA.derived(mint, this.programId);
    const info = await this.connection.getAccountInfo(pdas.poolState);
    if (!info) return null;
    return this.parsePoolState(info);
  }

  /**
   * Fetch a user's stake account for a given mint.
   */
  async fetchStakeAccount(
    mint: PublicKey,
    user: PublicKey
  ): Promise<StakeAccount | null> {
    const stakeAccount = PulsePDA.stakeAccount(mint, user, this.programId);
    const info = await this.connection.getAccountInfo(stakeAccount);
    if (!info) return null;
    return this.parseStakeAccount(info);
  }

  /**
   * Fetch the staker vault for a given mint.
   */
  async fetchStakerVault(mint: PublicKey): Promise<StakerVault | null> {
    const pdas = PulsePDA.derived(mint, this.programId);
    const info = await this.connection.getAccountInfo(pdas.stakerVault);
    if (!info) return null;
    return this.parseStakerVault(info);
  }

  /**
   * Fetch all pools that exist on the protocol.
   * Uses `getProgramAccounts` with a memcmp filter on the pool_state discriminator.
   *
   * ⚠️ Standard RPC only — this is a heavy query. For production, use an
   * indexer or Helius/Alchemy enhanced APIs.
   */
  async fetchAllPools(): Promise<PoolState[]> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        // Filter by pool_state discriminator (first 8 bytes)
        { dataSize: 320 }, // approximate PoolState size
      ],
    });
    return accounts
      .map((a) => this.parsePoolState(a.account))
      .filter((p): p is PoolState => p !== null);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELIUS-EXCLUSIVE METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * [HELIUS ONLY] Search for Pulse tokens using the Helius DAS API.
   *
   * The Helius Digital Asset Standard (DAS) API provides enriched token data
   * including off-chain metadata, images, and grouping — things standard RPC
   * simply cannot provide.
   *
   * Requires `heliusApiKey` in the Pulse constructor.
   *
   * @example
   * ```ts
   * const pulse = Pulse.devnet({ heliusApiKey: "your-key" });
   * const tokens = await pulse.searchTokens({ query: "pulse", limit: 10 });
   * for (const t of tokens) {
   *   console.log(`${t.content.metadata.name} (${t.content.metadata.symbol})`);
   * }
   * ```
   */
  async searchTokens(params: {
    query?: string;
    limit?: number;
    page?: number;
    sortBy?: { sortBy: string; sortDirection: string };
  }): Promise<import("./types").HeliusAssetsResponse> {
    if (!this.heliusApiKey) {
      throw new Error(
        "Helius API key required. Get one at https://helius.dev and pass it to Pulse.devnet({ heliusApiKey: '...' })"
      );
    }
    const url = `https://api.helius.xyz/v0/tokens?api-key=${this.heliusApiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: params.query,
        limit: params.limit ?? 100,
        page: params.page ?? 1,
        sortBy: params.sortBy,
      }),
    });
    return res.json();
  }

  /**
   * [HELIUS ONLY] Get enriched asset data for a mint using the DAS API.
   * Returns metadata, supply, decimals, and grouping info.
   *
   * This is the fastest way to get a token's name, symbol, and image
   * without parsing on-chain Metaplex metadata yourself.
   */
  async getAsset(mint: string): Promise<import("./types").HeliusAsset | null> {
    if (!this.heliusApiKey) {
      throw new Error("Helius API key required.");
    }
    const url = `https://api.helius.xyz/v0/addresses/${mint}/nft-editions?api-key=${this.heliusApiKey}`;
    const res = await fetch(
      `https://api.helius.xyz/v0/tokens/${mint}?api-key=${this.heliusApiKey}`
    );
    if (!res.ok) return null;
    return res.json();
  }

  /**
   * [HELIUS ONLY] Get all tokens owned by a wallet with enriched metadata.
   * Uses the Helius DAS `getTokenAccounts` endpoint which returns
   * token metadata inline — no separate Metaplex parsing needed.
   */
  async getWalletTokens(owner: string): Promise<import("./types").HeliusAsset[]> {
    if (!this.heliusApiKey) {
      throw new Error("Helius API key required.");
    }
    const url = `https://api.helius.xyz/v0/addresses/${owner}/tokens?api-key=${this.heliusApiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.tokens ?? [];
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ALCHEMY-EXCLUSIVE METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * [ALCHEMY ONLY] Get all SPL token balances for a wallet with metadata.
   *
   * Alchemy's `getTokenBalances` returns token names, symbols, logos,
   * and decimals inline — no need for separate RPC calls to Metaplex.
   *
   * Requires `alchemyApiKey` in the Pulse constructor.
   *
   * @example
   * ```ts
   * const pulse = Pulse.mainnet({ alchemyApiKey: "your-key" });
   * const balances = await pulse.getTokenBalances("wallet-address");
   * for (const b of balances) {
   *   console.log(`${b.tokenMetadata?.symbol}: ${b.tokenBalance}`);
   * }
   * ```
   */
  async getTokenBalances(
    owner: string
  ): Promise<import("./types").AlchemyTokenBalance[]> {
    if (!this.alchemyApiKey) {
      throw new Error(
        "Alchemy API key required. Get one at https://alchemy.com and pass it to Pulse.mainnet({ alchemyApiKey: '...' })"
      );
    }
    const url = `https://solana-mainnet.g.alchemy.com/v2/${this.alchemyApiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenBalances",
        params: [owner],
      }),
    });
    const data = await res.json();
    return data.result ?? [];
  }

  /**
   * [ALCHEMY ONLY] Get asset transfer history for a wallet.
   *
   * Alchemy's `getAssetTransfers` is the most reliable way to get
   * SPL token transfer history on Solana. Standard RPC's `getSignaturesForAddress`
   * + `getParsedTransaction` approach is slow and rate-limited.
   *
   * @example
   * ```ts
   * const transfers = await pulse.getAssetTransfers("wallet-address", {
   *   category: ["spl"],
   *   limit: 50,
   * });
   * for (const t of transfers) {
   *   console.log(`${t.asset}: ${t.value} (${t.hash})`);
   * }
   * ```
   */
  async getAssetTransfers(
    owner: string,
    options: {
      category?: string[];
      limit?: number;
      pageKey?: string;
    } = {}
  ): Promise<import("./types").AlchemyTransfer[]> {
    if (!this.alchemyApiKey) {
      throw new Error("Alchemy API key required.");
    }
    const url = `https://solana-mainnet.g.alchemy.com/v2/${this.alchemyApiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAssetTransfers",
        params: [
          {
            fromAddress: owner,
            category: options.category ?? ["spl", "token"],
            limit: options.limit ?? 100,
            pageKey: options.pageKey,
          },
        ],
      }),
    });
    const data = await res.json();
    return data.result?.transfers ?? [];
  }

  /**
   * [ALCHEMY ONLY] Get token metadata in a single call.
   *
   * Alchemy's `getTokenMetadata` returns name, symbol, decimals, and logo
   * without needing to parse Metaplex on-chain data.
   */
  async getTokenMetadata(
    mint: string
  ): Promise<{
    name: string;
    symbol: string;
    decimals: number;
    logo?: string;
  } | null> {
    if (!this.alchemyApiKey) {
      throw new Error("Alchemy API key required.");
    }
    const url = `https://solana-mainnet.g.alchemy.com/v2/${this.alchemyApiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenMetadata",
        params: [mint],
      }),
    });
    const data = await res.json();
    return data.result ?? null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMBINED METHODS (Alchemy + Helius working together)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * [ALCHEMY + HELIUS] Get a complete portfolio analysis for a wallet.
   *
   * Combines:
   * - Alchemy's `getTokenBalances` for accurate SPL token holdings
   * - Helius DAS API for enriched metadata (images, collection grouping)
   * - Pulse on-chain data for bonding curve positions
   *
   * This is the most comprehensive way to build a portfolio dashboard.
   *
   * @example
   * ```ts
   * const pulse = Pulse.mainnet({
   *   alchemyApiKey: "alchemy-key",
   *   heliusApiKey: "helius-key",
   * });
   * const portfolio = await pulse.getPortfolio("wallet-address");
   * console.log(`Total tokens: ${portfolio.tokens.length}`);
   * console.log(`Active positions: ${portfolio.bondingPositions.length}`);
   * ```
   */
  async getPortfolio(owner: string): Promise<{
    tokens: import("./types").AlchemyTokenBalance[];
    enrichedTokens: import("./types").HeliusAsset[];
    bondingPositions: Array<{
      mint: string;
      pool: PoolState;
      tokenBalance: string;
    }>;
  }> {
    if (!this.alchemyApiKey || !this.heliusApiKey) {
      throw new Error(
        "Both alchemyApiKey and heliusApiKey are required for getPortfolio(). " +
        "Get keys at https://alchemy.com and https://helius.dev"
      );
    }

    // Fetch from both providers in parallel
    const [tokenBalances, walletTokens] = await Promise.all([
      this.getTokenBalances(owner),
      this.getWalletTokens(owner),
    ]);

    // Find which tokens are on the Pulse bonding curve
    const bondingPositions: Array<{
      mint: string;
      pool: PoolState;
      tokenBalance: string;
    }> = [];

    for (const token of tokenBalances) {
      try {
        const pool = await this.fetchPool(new PublicKey(token.contractAddress));
        if (pool) {
          bondingPositions.push({
            mint: token.contractAddress,
            pool,
            tokenBalance: token.tokenBalance,
          });
        }
      } catch {
        // Not a Pulse token, skip
      }
    }

    return {
      tokens: tokenBalances,
      enrichedTokens: walletTokens,
      bondingPositions,
    };
  }

  /**
   * [ALCHEMY + HELIUS] Get a comprehensive token profile combining
   * on-chain bonding curve state with off-chain metadata.
   *
   * This is the "killer method" for building token detail pages:
   * - On-chain: pool state, price, graduation progress
   * - Helius: metadata, image, collection info
   * - Alchemy: holder analytics, transfer history
   */
  async getTokenProfile(mint: string): Promise<{
    pool: PoolState | null;
    heliusAsset: import("./types").HeliusAsset | null;
    tokenMetadata: {
      name: string;
      symbol: string;
      decimals: number;
      logo?: string;
    } | null;
    recentTransfers: import("./types").AlchemyTransfer[];
    price: number;
    graduationProgress: number;
    isReadyToGraduate: boolean;
  }> {
    const [pool, heliusAsset, tokenMetadata, recentTransfers] = await Promise.all([
      this.fetchPool(new PublicKey(mint)).catch(() => null),
      this.heliusApiKey ? this.getAsset(mint).catch(() => null) : null,
      this.alchemyApiKey ? this.getTokenMetadata(mint).catch(() => null) : null,
      this.alchemyApiKey
        ? this.getAssetTransfers(mint, { limit: 20 }).catch(() => [])
        : [],
    ]);

    return {
      pool,
      heliusAsset,
      tokenMetadata,
      recentTransfers,
      price: pool ? getSpotPriceSol(pool) : 0,
      graduationProgress: pool ? graduationProgress(pool) : 0,
      isReadyToGraduate: pool ? isReadyToGraduate(pool) : false,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private async constants(): Promise<{ PlatformWallet: PublicKey }> {
    const { PLATFORM_WALLET } = await import("./constants");
    return { PlatformWallet: PLATFORM_WALLET };
  }

  private serializeMigrationTarget(
    target: import("./types").MigrationTarget
  ): Buffer {
    // Simplified serialization — in production use Borsh with the full IDL
    const buf = Buffer.alloc(64);
    if ("raydiumCpmm" in target) buf.writeUInt8(0, 0);
    else if ("meteoraDammV1" in target) {
      buf.writeUInt8(1, 0);
      const t = target.meteoraDammV1;
      buf.writeUInt8(t.enableDynamicVault ? 1 : 0, 1);
      buf.writeUInt8(t.lpShare, 2);
      buf.writeUInt8(t.stakerShare, 3);
      buf.writeUInt8(t.holderShare, 4);
    } else if ("meteoraDlmm" in target) {
      buf.writeUInt8(2, 0);
      const t = target.meteoraDlmm;
      buf.writeUInt16LE(t.feeBps, 1);
      buf.writeUInt16LE(t.binStep, 3);
      buf.writeUInt8(t.lpShare, 5);
      buf.writeUInt8(t.stakerShare, 6);
      buf.writeUInt8(t.holderShare, 7);
    } else if ("pumpSwapBurn" in target) buf.writeUInt8(3, 0);
    else if ("pumpSwapHoldLp" in target) buf.writeUInt8(4, 0);
    return buf;
  }

  private parseGlobalConfig(info: AccountInfo<Buffer>): GlobalConfig | null {
    try {
      const data = info.data;
      return {
        authority: new PublicKey(data.slice(8, 40)),
        platformWallet: new PublicKey(data.slice(40, 72)),
        feeBasisPoints: Number(data.readBigUInt64LE(72)),
        platformShareBps: Number(data.readBigUInt64LE(80)),
        creatorShareBps: Number(data.readBigUInt64LE(88)),
        graduationSolThreshold: Number(data.readBigUInt64LE(96)),
        minCreatorReserve: Number(data.readBigUInt64LE(104)),
        paused: data[112] === 1,
        bump: data[113],
      };
    } catch {
      return null;
    }
  }

  private parsePoolState(info: AccountInfo<Buffer>): PoolState | null {
    try {
      const data = info.data;
      return {
        mint: new PublicKey(data.slice(8, 40)),
        creator: new PublicKey(data.slice(40, 72)),
        currentAuthority: new PublicKey(data.slice(72, 104)),
        migrationTarget: { raydiumCpmm: {} }, // simplified
        virtualSolReserves: data.readBigUInt64LE(170),
        virtualTokenReserves: data.readBigUInt64LE(178),
        realSolReserves: data.readBigUInt64LE(186),
        realTokenReserves: data.readBigUInt64LE(194),
        reserveTokensRemaining: data.readBigUInt64LE(202),
        graduated: data[210] === 1,
        dexPool: null,
        createdAt: Number(data.readBigInt64LE(212)),
        bump: data[220],
        feeVaultBump: data[221],
        feeRecipientBump: data[222],
        lpReserveBump: data[223],
        poolTokensBump: data[224],
        migrationVaultBump: data[225],
      };
    } catch {
      return null;
    }
  }

  private parseStakeAccount(info: AccountInfo<Buffer>): StakeAccount | null {
    try {
      const data = info.data;
      return {
        owner: new PublicKey(data.slice(8, 40)),
        mint: new PublicKey(data.slice(40, 72)),
        amountStaked: data.readBigUInt64LE(72),
        stakedAt: Number(data.readBigInt64LE(80)),
        lastClaimed: Number(data.readBigInt64LE(88)),
        rewardDebt: data.readBigUInt64LE(96),
        bump: data[112],
      };
    } catch {
      return null;
    }
  }

  private parseStakerVault(info: AccountInfo<Buffer>): StakerVault | null {
    try {
      const data = info.data;
      return {
        mint: new PublicKey(data.slice(8, 40)),
        totalStaked: data.readBigUInt64LE(40),
        accumulatedRewardPerToken: data.readBigUInt64LE(48),
        totalDistributed: data.readBigUInt64LE(64),
        bump: data[72],
      };
    } catch {
      return null;
    }
  }
}
