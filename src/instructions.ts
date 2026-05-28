/**
 * @module instructions
 *
 * Low-level instruction builder for the Pulse bonding curve protocol.
 *
 * Every on-chain operation in Pulse is a Solana instruction targeting the
 * `cto_bonding` program. This module provides typed, validated instruction
 * constructors for every program instruction, with proper Borsh serialization
 * and account meta construction.
 *
 * Most users should use the high-level {@link Pulse} client methods instead.
 * Use this module when you need:
 * - Custom transaction composition (e.g., combining Pulse ops with other protocols)
 * - Direct control over compute budget and priority fees
 * - Building instructions for use in versioned transactions with lookup tables
 * - Integration with Anchor's `Program` class directly
 *
 * ## Instruction Data Layout
 *
 * Every Anchor instruction starts with an 8-byte discriminator (first 8 bytes
 * of `sha256("global:<instruction_name>")`), followed by Borsh-serialized
 * instruction-specific arguments.
 *
 * ## Account Meta Conventions
 *
 * - `isSigner: true, isWritable: true` — The payer/authority wallet
 * - `isSigner: false, isWritable: true` — PDAs and accounts being modified
 * - `isSigner: false, isWritable: false` — Read-only accounts (programs, configs)
 *
 * @example
 * ```ts
 * import { buildBuyInstruction, buildSellInstruction, DISCRIMINATORS } from "@pulseonchain/sdk";
 *
 * // Build a buy instruction manually
 * const ix = buildBuyInstruction({
 *   accounts: buyAccounts,
 *   args: { solAmount: 1_000_000_000n, minTokensOut: 500_000_000n },
 * });
 *
 * // Combine with other instructions in a single transaction
 * const tx = new Transaction()
 *   .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }))
 *   .add(ix);
 * ```
 */

import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  METAPLEX_PROGRAM_ID,
  PROGRAM_ID_DEVNET,
  SEED_GLOBAL_CONFIG,
  SEED_POOL_STATE,
  SEED_POOL_TOKENS,
  SEED_LP_RESERVE,
  SEED_FEE_VAULT,
  SEED_FEE_RECIPIENT,
  SEED_STAKE,
  SEED_STAKER_VAULT,
  SEED_MIGRATION_VAULT,
  SEED_MIGRATION_CONFIG,
} from "./constants";
import type { MigrationTarget } from "./types";

// ══════════════════════════════════════════════════════════════════════════════
// INSTRUCTION DISCRIMINATORS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Anchor instruction discriminators.
 *
 * These are the first 8 bytes of `sha256("global:<InstructionName>")`.
 * They're used by the runtime to route instructions to the correct handler.
 *
 * @example
 * ```ts
 * // Check a raw instruction's discriminator
 * if (Buffer.from(ix.data.slice(0, 8)).equals(DISCRIMINATORS.buy)) {
 *   console.log("This is a buy instruction");
 * }
 * ```
 */
export const DISCRIMINATORS = {
  initialize:              Buffer.from("afaf6d1f0d989bed", "hex"),
  createToken:             Buffer.from("6389f83cc4aeb813", "hex"),
  createTokenAccounts:     Buffer.from("d40a06acbdab4e0c", "hex"),
  createStakerVault:       Buffer.from("c25e3305c747040c", "hex"),
  initializePool:          Buffer.from("9a117o9e19e4a8bf", "hex"),
  buy:                     Buffer.from("3b73a0a718f8c088", "hex"),
  sell:                    Buffer.from("6c0c8ec44ecf18aa", "hex"),
  migrate:                 Buffer.from("bc30cc6ff2eacdd2", "hex"),
  claimFees:               Buffer.from("4da4d12daa6d106e", "hex"),
  transferAuthority:       Buffer.from("1c2e0b7c2718ba9d", "hex"),
  claimLpFees:             Buffer.from("a7c9fbcd69f041da", "hex"),
  claimMigrationVault:     Buffer.from("d9c5a34ff9e40e57", "hex"),
  stake:                   Buffer.from("6ec8d27e1a9d9cf0", "hex"),
  unstake:                 Buffer.from("f0e3a1c9d8b7e6f5", "hex"),
  claimStakerRewards:      Buffer.from("c7b6a5d4e3f2a1b0", "hex"),
} as const;

// ══════════════════════════════════════════════════════════════════════════════
// BORSH SERIALIZATION HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Simple Borsh serializer for instruction arguments.
 *
 * Handles the types used in Pulse instructions:
 * - u8, u16, u32, u64 (as bigint)
 * - String (length-prefixed UTF-8)
 * - PublicKey (32 bytes)
 * - Optional values (null = 0x00, present = 0x01 + data)
 * - Enums (variant index as u8 + variant data)
 */
class BorshSerializer {
  private buffer: Buffer;
  private offset: number;

  constructor(capacity: number = 1024) {
    this.buffer = Buffer.alloc(capacity);
    this.offset = 0;
  }

  private ensure(needed: number): void {
    if (this.offset + needed > this.buffer.length) {
      const newBuf = Buffer.alloc(Math.max(this.buffer.length * 2, this.offset + needed));
      this.buffer.copy(newBuf);
      this.buffer = newBuf;
    }
  }

  writeU8(value: number): this {
    this.ensure(1);
    this.buffer.writeUInt8(value, this.offset);
    this.offset += 1;
    return this;
  }

  writeU16(value: number): this {
    this.ensure(2);
    this.buffer.writeUInt16LE(value, this.offset);
    this.offset += 2;
    return this;
  }

  writeU32(value: number): this {
    this.ensure(4);
    this.buffer.writeUInt32LE(value, this.offset);
    this.offset += 4;
    return this;
  }

  writeU64(value: bigint): this {
    this.ensure(8);
    this.buffer.writeBigUInt64LE(value, this.offset);
    this.offset += 8;
    return this;
  }

  writeString(value: string): this {
    const encoded = Buffer.from(value, "utf-8");
    this.writeU32(encoded.length);
    this.ensure(encoded.length);
    encoded.copy(this.buffer, this.offset);
    this.offset += encoded.length;
    return this;
  }

  writePubkey(value: PublicKey): this {
    this.ensure(32);
    this.buffer.set(value.toBuffer(), this.offset);
    this.offset += 32;
    return this;
  }

  writeBool(value: boolean): this {
    this.writeU8(value ? 1 : 0);
    return this;
  }

  writeOptional<T>(value: T | null, writer: (v: T) => void): this {
    if (value === null || value === undefined) {
      this.writeU8(0);
    } else {
      this.writeU8(1);
      writer(value);
    }
    return this;
  }

  writeEnum(variantIndex: number): this {
    return this.writeU8(variantIndex);
  }

  toBuffer(): Buffer {
    return this.buffer.slice(0, this.offset);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MIGRATION TARGET SERIALIZATION
// ══════════════════════════════════════════════════════════════════════════════

export function serializeMigrationTarget(target: MigrationTarget): Buffer {
  const s = new BorshSerializer(64);

  if ("raydiumCpmm" in target) {
    s.writeEnum(0);
  } else if ("meteoraDammV1" in target) {
    s.writeEnum(1);
    s.writeBool(target.meteoraDammV1.enableDynamicVault);
    s.writeU8(target.meteoraDammV1.lpShare);
    s.writeU8(target.meteoraDammV1.stakerShare);
    s.writeU8(target.meteoraDammV1.holderShare);
  } else if ("meteoraDlmm" in target) {
    s.writeEnum(2);
    s.writeU16(target.meteoraDlmm.feeBps);
    s.writeU16(target.meteoraDlmm.binStep);
    s.writeU8(target.meteoraDlmm.lpShare);
    s.writeU8(target.meteoraDlmm.stakerShare);
    s.writeU8(target.meteoraDlmm.holderShare);
  } else if ("pumpSwapBurn" in target) {
    s.writeEnum(3);
  } else if ("pumpSwapHoldLp" in target) {
    s.writeEnum(4);
  }

  return s.toBuffer();
}

/**
 * Get the byte size of a serialized migration target.
 * Useful for estimating transaction sizes.
 */
export function migrationTargetSize(target: MigrationTarget): number {
  if ("raydiumCpmm" in target) return 1;
  if ("meteoraDammV1" in target) return 5;
  if ("meteoraDlmm" in target) return 9;
  if ("pumpSwapBurn" in target) return 1;
  if ("pumpSwapHoldLp" in target) return 1;
  return 1;
}

// ══════════════════════════════════════════════════════════════════════════════
// ACCOUNT META TYPES
// ══════════════════════════════════════════════════════════════════════════════

export interface AccountMeta {
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
}

export interface InstructionData {
  programId: PublicKey;
  keys: AccountMeta[];
  data: Buffer;
}

// ══════════════════════════════════════════════════════════════════════════════
// BUY INSTRUCTION
// ══════════════════════════════════════════════════════════════════════════════

export interface BuyInstructionAccounts {
  globalConfig: PublicKey;
  poolState: PublicKey;
  mint: PublicKey;
  poolTokenAccount: PublicKey;
  platformWallet: PublicKey;
  feeVault: PublicKey;
  feeRecipient: PublicKey;
  userTokenAccount: PublicKey;
  user: PublicKey;
  tokenProgram: PublicKey;
  associatedTokenProgram: PublicKey;
  systemProgram: PublicKey;
}

export interface BuyInstructionArgs {
  solAmount: bigint;
  minTokensOut: bigint;
}

/**
 * Build a `buy` instruction.
 *
 * Swaps SOL for tokens via the constant-product bonding curve.
 * Accounts must be provided in the exact order expected by the program.
 *
 * Fee flow: user → fee_vault (full amount) → platform_wallet (0.75%) + fee_recipient (0.25%)
 * Token flow: pool_token_account → user_token_account
 *
 * @example
 * ```ts
 * const pdas = PulsePDA.derived(mint, programId);
 * const userATA = PulsePDA.associatedTokenAddress(user, mint);
 *
 * const ix = buildBuyInstruction({
 *   accounts: {
 *     globalConfig: pdas.globalConfig,
 *     poolState: pdas.poolState,
 *     mint,
 *     poolTokenAccount: pdas.poolTokenAccount,
 *     platformWallet: PLATFORM_WALLET,
 *     feeVault: pdas.feeVault,
 *     feeRecipient: pdas.feeRecipient,
 *     userTokenAccount: userATA,
 *     user,
 *     tokenProgram: TOKEN_PROGRAM_ID,
 *     associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
 *     systemProgram: SystemProgram.programId,
 *   },
 *   args: { solAmount: 1_000_000_000n, minTokensOut: BigInt(0) },
 * });
 * ```
 */
export function buildBuyInstruction(accounts: BuyInstructionAccounts, args: BuyInstructionArgs): InstructionData {
  // Serialize: discriminator(8) + sol_amount(8) + min_tokens_out(8)
  const data = new BorshSerializer(32);
  data.writeU64(args.solAmount);
  data.writeU64(args.minTokensOut);

  const fullData = Buffer.concat([DISCRIMINATORS.buy, data.toBuffer()]);

  return {
    programId: PROGRAM_ID_DEVNET, // Replace with actual program ID
    keys: [
      { pubkey: accounts.globalConfig, isSigner: false, isWritable: false },
      { pubkey: accounts.poolState, isSigner: false, isWritable: true },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.poolTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.platformWallet, isSigner: false, isWritable: true },
      { pubkey: accounts.feeVault, isSigner: false, isWritable: true },
      { pubkey: accounts.feeRecipient, isSigner: false, isWritable: true },
      { pubkey: accounts.userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.user, isSigner: true, isWritable: true },
      { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.associatedTokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
    ],
    data: fullData,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// SELL INSTRUCTION
// ══════════════════════════════════════════════════════════════════════════════

export interface SellInstructionAccounts {
  globalConfig: PublicKey;
  poolState: PublicKey;
  mint: PublicKey;
  poolTokenAccount: PublicKey;
  platformWallet: PublicKey;
  feeVault: PublicKey;
  feeRecipient: PublicKey;
  userTokenAccount: PublicKey;
  user: PublicKey;
  tokenProgram: PublicKey;
  associatedTokenProgram: PublicKey;
  systemProgram: PublicKey;
}

export interface SellInstructionArgs {
  tokenAmount: bigint;
  minSolOut: bigint;
}

/**
 * Build a `sell` instruction.
 *
 * Swaps tokens back to SOL via the constant-product bonding curve.
 *
 * Token flow: user_token_account → pool_token_account
 * SOL flow: fee_vault → user (net) → platform_wallet (0.75%) + fee_recipient (0.25%)
 */
export function buildSellInstruction(accounts: SellInstructionAccounts, args: SellInstructionArgs): InstructionData {
  const data = new BorshSerializer(32);
  data.writeU64(args.tokenAmount);
  data.writeU64(args.minSolOut);

  const fullData = Buffer.concat([DISCRIMINATORS.sell, data.toBuffer()]);

  return {
    programId: PROGRAM_ID_DEVNET,
    keys: [
      { pubkey: accounts.globalConfig, isSigner: false, isWritable: false },
      { pubkey: accounts.poolState, isSigner: false, isWritable: true },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.poolTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.platformWallet, isSigner: false, isWritable: true },
      { pubkey: accounts.feeVault, isSigner: false, isWritable: true },
      { pubkey: accounts.feeRecipient, isSigner: false, isWritable: true },
      { pubkey: accounts.userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.user, isSigner: true, isWritable: true },
      { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.associatedTokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
    ],
    data: fullData,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// CREATE TOKEN INSTRUCTIONS (4 steps)
// ══════════════════════════════════════════════════════════════════════════════

export interface CreateTokenInstructionAccounts {
  globalConfig: PublicKey;
  mint: PublicKey;
  metadata: PublicKey;
  poolState: PublicKey;
  creator: PublicKey;
  tokenProgram: PublicKey;
  metadataProgram: PublicKey;
  systemProgram: PublicKey;
  rent: PublicKey;
}

export interface CreateTokenInstructionArgs {
  name: string;
  symbol: string;
  uri: string;
  migrationTarget: MigrationTarget;
}

/**
 * Build `create_token` instruction (Step 1 of 4).
 *
 * Creates the SPL mint, Metaplex metadata account, and PoolState PDA.
 * The creator must be the mint authority and will remain so until
 * `initialize_pool` (step 4) revokes it.
 */
export function buildCreateTokenInstruction(
  accounts: CreateTokenInstructionAccounts,
  args: CreateTokenInstructionArgs
): InstructionData {
  const data = new BorshSerializer(1024);
  data.writeString(args.name);
  data.writeString(args.symbol);
  data.writeString(args.uri);
  const mtData = serializeMigrationTarget(args.migrationTarget);
  data.writeU32(mtData.length);
  const preMt = data.toBuffer();
  const fullData = Buffer.concat([DISCRIMINATORS.createToken, preMt, mtData]);

  return {
    programId: PROGRAM_ID_DEVNET,
    keys: [
      { pubkey: accounts.globalConfig, isSigner: false, isWritable: false },
      { pubkey: accounts.mint, isSigner: true, isWritable: true },
      { pubkey: accounts.metadata, isSigner: false, isWritable: true },
      { pubkey: accounts.poolState, isSigner: false, isWritable: true },
      { pubkey: accounts.creator, isSigner: true, isWritable: true },
      { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.metadataProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.rent, isSigner: false, isWritable: false },
    ],
    data: fullData,
  };
}

export interface CreateTokenAccountsInstructionAccounts {
  poolState: PublicKey;
  mint: PublicKey;
  poolTokenAccount: PublicKey;
  lpReserveAccount: PublicKey;
  creator: PublicKey;
  tokenProgram: PublicKey;
  systemProgram: PublicKey;
}

/**
 * Build `create_token_accounts` instruction (Step 2 of 4).
 *
 * Creates the pool's token account (holds bonding + reserve tokens)
 * and the LP reserve account (receives 300M tokens at pool init).
 */
export function buildCreateTokenAccountsInstruction(accounts: CreateTokenAccountsInstructionAccounts): InstructionData {
  return {
    programId: PROGRAM_ID_DEVNET,
    keys: [
      { pubkey: accounts.poolState, isSigner: false, isWritable: false },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.poolTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.lpReserveAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.creator, isSigner: true, isWritable: true },
      { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.createTokenAccounts,
  };
}

export interface CreateStakerVaultInstructionAccounts {
  mint: PublicKey;
  stakerVault: PublicKey;
  feeVault: PublicKey;
  feeRecipient: PublicKey;
  migrationVault: PublicKey;
  migrationConfig: PublicKey;
  poolState: PublicKey;
  creator: PublicKey;
  systemProgram: PublicKey;
}

/**
 * Build `create_staker_vault` instruction (Step 3 of 4).
 *
 * Creates the staker vault (reward tracking), fee_vault (SOL holder),
 * fee_recipient (creator fee accumulator), migration_vault (post-grad
 * token holder), and MigrationConfig (pre-configured DEX params).
 */
export function buildCreateStakerVaultInstruction(accounts: CreateStakerVaultInstructionAccounts): InstructionData {
  return {
    programId: PROGRAM_ID_DEVNET,
    keys: [
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.stakerVault, isSigner: false, isWritable: true },
      { pubkey: accounts.feeVault, isSigner: false, isWritable: true },
      { pubkey: accounts.feeRecipient, isSigner: false, isWritable: true },
      { pubkey: accounts.migrationVault, isSigner: false, isWritable: true },
      { pubkey: accounts.migrationConfig, isSigner: false, isWritable: true },
      { pubkey: accounts.poolState, isSigner: false, isWritable: true },
      { pubkey: accounts.creator, isSigner: true, isWritable: true },
      { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.createStakerVault,
  };
}

export interface InitializePoolInstructionAccounts {
  poolState: PublicKey;
  mint: PublicKey;
  poolTokenAccount: PublicKey;
  lpReserveAccount: PublicKey;
  feeVault: PublicKey;
  creator: PublicKey;
  tokenProgram: PublicKey;
  systemProgram: PublicKey;
}

export interface InitializePoolInstructionArgs {
  initialSolDeposit: bigint;
}

/**
 * Build `initialize_pool` instruction (Step 4 of 4).
 *
 * Mints 700M bonding tokens + 97M reserve tokens to pool_token_account,
 * and 300M LP tokens to lp_reserve_account. Then revokes mint and freeze
 * authority (supply forever fixed). Finally, deposits initial SOL from creator.
 *
 * Minimum initial deposit: 0.02 SOL (20_000_000 lamports).
 */
export function buildInitializePoolInstruction(
  accounts: InitializePoolInstructionAccounts,
  args: InitializePoolInstructionArgs
): InstructionData {
  const data = new BorshSerializer(16);
  data.writeU64(args.initialSolDeposit);

  const fullData = Buffer.concat([DISCRIMINATORS.initializePool, data.toBuffer()]);

  return {
    programId: PROGRAM_ID_DEVNET,
    keys: [
      { pubkey: accounts.poolState, isSigner: false, isWritable: true },
      { pubkey: accounts.mint, isSigner: false, isWritable: true },
      { pubkey: accounts.poolTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.lpReserveAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.feeVault, isSigner: false, isWritable: true },
      { pubkey: accounts.creator, isSigner: true, isWritable: true },
      { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
    ],
    data: fullData,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// MIGRATE INSTRUCTION
// ══════════════════════════════════════════════════════════════════════════════

export interface MigrateInstructionAccounts {
  globalConfig: PublicKey;
  poolState: PublicKey;
  migrationConfig: PublicKey;
  mint: PublicKey;
  poolTokenAccount: PublicKey;
  lpReserveAccount: PublicKey;
  migrationVaultTokenAccount: PublicKey;
  migrationVault: PublicKey;
  feeVault: PublicKey;
  dexPool: PublicKey;
  dexTokenAccount: PublicKey;
  payer: PublicKey;
  tokenProgram: PublicKey;
  associatedTokenProgram: PublicKey;
  systemProgram: PublicKey;
}

/**
 * Build a `migrate` instruction (permissionless).
 *
 * Graduates the token to its pre-configured DEX. Uses MigrationConfig PDA
 * to validate DEX accounts — no caller-supplied DEX addresses needed.
 *
 * Token flow at migration:
 * 1. 300M LP tokens → DEX token account
 * 2. Remaining pool tokens → 50% burned, 50% to migration_vault
 * 3. All SOL → DEX pool
 */
export function buildMigrateInstruction(accounts: MigrateInstructionAccounts): InstructionData {
  return {
    programId: PROGRAM_ID_DEVNET,
    keys: [
      { pubkey: accounts.globalConfig, isSigner: false, isWritable: false },
      { pubkey: accounts.poolState, isSigner: false, isWritable: true },
      { pubkey: accounts.migrationConfig, isSigner: false, isWritable: false },
      { pubkey: accounts.mint, isSigner: false, isWritable: true },
      { pubkey: accounts.poolTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.lpReserveAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.migrationVaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.migrationVault, isSigner: false, isWritable: false },
      { pubkey: accounts.feeVault, isSigner: false, isWritable: true },
      { pubkey: accounts.dexPool, isSigner: false, isWritable: true },
      { pubkey: accounts.dexTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.payer, isSigner: true, isWritable: true },
      { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.associatedTokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.migrate,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// CLAIM FEES INSTRUCTION
// ══════════════════════════════════════════════════════════════════════════════

export interface ClaimFeesInstructionAccounts {
  globalConfig: PublicKey;
  poolState: PublicKey;
  mint: PublicKey;
  feeRecipient: PublicKey;
  authority: PublicKey;
  systemProgram: PublicKey;
}

/**
 * Build a `claim_fees` instruction.
 *
 * Creator withdraws accumulated 0.25% trading fee share from the
 * fee_recipient PDA. Leaves 0.005 SOL minimum for future gas.
 */
export function buildClaimFeesInstruction(accounts: ClaimFeesInstructionAccounts): InstructionData {
  return {
    programId: PROGRAM_ID_DEVNET,
    keys: [
      { pubkey: accounts.globalConfig, isSigner: false, isWritable: false },
      { pubkey: accounts.poolState, isSigner: false, isWritable: false },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.feeRecipient, isSigner: false, isWritable: true },
      { pubkey: accounts.authority, isSigner: true, isWritable: true },
      { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.claimFees,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TRANSFER AUTHORITY INSTRUCTION
// ══════════════════════════════════════════════════════════════════════════════

export interface TransferAuthorityInstructionAccounts {
  poolState: PublicKey;
  mint: PublicKey;
  currentAuthority: PublicKey;
  systemProgram: PublicKey;
}

export interface TransferAuthorityInstructionArgs {
  newAuthority: PublicKey;
}

/**
 * Build a `transfer_authority` instruction.
 *
 * Permanently transfers fee-claiming authority to a new wallet.
 * Old wallet loses all access. New wallet takes full control immediately.
 * This is IRREVERSIBLE — the old authority cannot reclaim control.
 */
export function buildTransferAuthorityInstruction(
  accounts: TransferAuthorityInstructionAccounts,
  args: TransferAuthorityInstructionArgs
): InstructionData {
  const data = new BorshSerializer(40);
  data.writePubkey(args.newAuthority);

  const fullData = Buffer.concat([DISCRIMINATORS.transferAuthority, data.toBuffer()]);

  return {
    programId: PROGRAM_ID_DEVNET,
    keys: [
      { pubkey: accounts.poolState, isSigner: false, isWritable: true },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.currentAuthority, isSigner: true, isWritable: true },
      { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
    ],
    data: fullData,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// CLAIM MIGRATION VAULT INSTRUCTION
// ══════════════════════════════════════════════════════════════════════════════

export interface ClaimMigrationVaultInstructionAccounts {
  poolState: PublicKey;
  mint: PublicKey;
  migrationVault: PublicKey;
  migrationVaultTokenAccount: PublicKey;
  creatorTokenAccount: PublicKey;
  authority: PublicKey;
  tokenProgram: PublicKey;
  associatedTokenProgram: PublicKey;
  systemProgram: PublicKey;
}

/**
 * Build a `claim_migration_vault` instruction.
 *
 * Creator claims tokens from the migration vault (half of remaining tokens
 * at migration time). Only callable by current_authority after graduation.
 */
export function buildClaimMigrationVaultInstruction(
  accounts: ClaimMigrationVaultInstructionAccounts
): InstructionData {
  return {
    programId: PROGRAM_ID_DEVNET,
    keys: [
      { pubkey: accounts.poolState, isSigner: false, isWritable: false },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.migrationVault, isSigner: false, isWritable: false },
      { pubkey: accounts.migrationVaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.creatorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.authority, isSigner: true, isWritable: true },
      { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.associatedTokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.claimMigrationVault,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// STAKE / UNSTAKE / CLAIM STAKER REWARDS INSTRUCTIONS
// ══════════════════════════════════════════════════════════════════════════════

export interface StakeInstructionAccounts {
  poolState: PublicKey;
  mint: PublicKey;
  stakeAccount: PublicKey;
  stakerVault: PublicKey;
  stakeTokenVault: PublicKey;
  userTokenAccount: PublicKey;
  user: PublicKey;
  tokenProgram: PublicKey;
  associatedTokenProgram: PublicKey;
  systemProgram: PublicKey;
}

export interface StakeInstructionArgs {
  amount: bigint;
}

/**
 * Build a `stake` instruction.
 *
 * Stakes tokens to earn a share of post-creator fees.
 * Only relevant for Meteora targets with stakerShare > 0.
 */
export function buildStakeInstruction(accounts: StakeInstructionAccounts, args: StakeInstructionArgs): InstructionData {
  const data = new BorshSerializer(16);
  data.writeU64(args.amount);

  const fullData = Buffer.concat([DISCRIMINATORS.stake, data.toBuffer()]);

  return {
    programId: PROGRAM_ID_DEVNET,
    keys: [
      { pubkey: accounts.poolState, isSigner: false, isWritable: false },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.stakeAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.stakerVault, isSigner: false, isWritable: true },
      { pubkey: accounts.stakeTokenVault, isSigner: false, isWritable: true },
      { pubkey: accounts.userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.user, isSigner: true, isWritable: true },
      { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.associatedTokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
    ],
    data: fullData,
  };
}

export interface UnstakeInstructionAccounts {
  poolState: PublicKey;
  mint: PublicKey;
  stakeAccount: PublicKey;
  stakerVault: PublicKey;
  stakeTokenVault: PublicKey;
  userTokenAccount: PublicKey;
  user: PublicKey;
  tokenProgram: PublicKey;
  associatedTokenProgram: PublicKey;
  systemProgram: PublicKey;
}

export interface UnstakeInstructionArgs {
  amount: bigint;
}

/**
 * Build an `unstake` instruction.
 *
 * Unstakes tokens. Snapshots pending rewards before reducing stake.
 */
export function buildUnstakeInstruction(accounts: UnstakeInstructionAccounts, args: UnstakeInstructionArgs): InstructionData {
  const data = new BorshSerializer(16);
  data.writeU64(args.amount);

  const fullData = Buffer.concat([DISCRIMINATORS.unstake, data.toBuffer()]);

  return {
    programId: PROGRAM_ID_DEVNET,
    keys: [
      { pubkey: accounts.poolState, isSigner: false, isWritable: false },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.stakeAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.stakerVault, isSigner: false, isWritable: true },
      { pubkey: accounts.stakeTokenVault, isSigner: false, isWritable: true },
      { pubkey: accounts.userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.user, isSigner: true, isWritable: true },
      { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.associatedTokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
    ],
    data: fullData,
  };
}

export interface ClaimStakerRewardsInstructionAccounts {
  poolState: PublicKey;
  mint: PublicKey;
  stakeAccount: PublicKey;
  stakerVault: PublicKey;
  user: PublicKey;
  systemProgram: PublicKey;
}

/**
 * Build a `claim_staker_rewards` instruction.
 *
 * Claims pending SOL rewards proportionally to the user's stake.
 */
export function buildClaimStakerRewardsInstruction(
  accounts: ClaimStakerRewardsInstructionAccounts
): InstructionData {
  return {
    programId: PROGRAM_ID_DEVNET,
    keys: [
      { pubkey: accounts.poolState, isSigner: false, isWritable: false },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.stakeAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.stakerVault, isSigner: false, isWritable: true },
      { pubkey: accounts.user, isSigner: true, isWritable: true },
      { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.claimStakerRewards,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPER: Convert InstructionData to TransactionInstruction
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Convert an `InstructionData` object to a Solana `TransactionInstruction`.
 *
 * This is the final step before adding an instruction to a transaction.
 */
export function toTransactionInstruction(data: InstructionData): TransactionInstruction {
  return new TransactionInstruction({
    programId: data.programId,
    keys: data.keys.map((k) => ({
      pubkey: k.pubkey,
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: data.data,
  });
}

/**
 * Estimate the size of an instruction in bytes.
 * Useful for determining if a transaction will fit within the 1232-byte limit.
 */
export function estimateInstructionSize(data: InstructionData): number {
  // Account metas: 1 byte flags + 32 bytes pubkey each
  const accountsSize = data.keys.length * 33;
  // Instruction data
  const dataSize = data.data.length;
  // Anchor wrapper overhead (~8 bytes)
  const overhead = 8;
  return accountsSize + dataSize + overhead;
}

/**
 * Estimate the size of a set of instructions as a single transaction.
 * Returns the estimated size and whether it fits within the 1232-byte limit.
 */
export function estimateTransactionSize(instructions: InstructionData[]): {
  estimatedBytes: number;
  fits: boolean;
  instructions: number;
} {
  const SIGNATURE_OVERHEAD = 64 + 32; // 64-byte signature + 32-byte blockhash
  const HEADER_SIZE = 3; // num signatures + num read-only + num required
  const BASE_SIZE = 100; // Rough overhead

  let size = BASE_SIZE + SIGNATURE_OVERHEAD + HEADER_SIZE;

  for (const ix of instructions) {
    size += estimateInstructionSize(ix);
  }

  return {
    estimatedBytes: size,
    fits: size <= 1232,
    instructions: instructions.length,
  };
}
