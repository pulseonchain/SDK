import { PublicKey } from "@solana/web3.js";
import * as constants from "./constants";

/**
 * Derive all Pulse protocol PDAs for a given mint.
 *
 * Every on-chain account in Pulse is a deterministic PDA. This module
 * centralizes all derivation logic so you never have to memorize seed strings.
 *
 * @example
 * ```ts
 * const pdas = PulsePDA.derived(mint);
 * console.log(pdas.poolState.toBase58());
 * ```
 */
export class PulsePDA {
  constructor(
    public readonly programId: PublicKey,
    public readonly globalConfig: PublicKey,
    public readonly poolState: PublicKey,
    public readonly feeVault: PublicKey,
    public readonly feeRecipient: PublicKey,
    public readonly poolTokenAccount: PublicKey,
    public readonly lpReserveAccount: PublicKey,
    public readonly stakeTokenVault: PublicKey,
    public readonly migrationVault: PublicKey,
    public readonly migrationConfig: PublicKey,
    public readonly stakerVault: PublicKey
  ) {}
  /**
   * Derive all PDAs for a given mint against a specific cluster's program ID.
   */
  static derived(
    mint: PublicKey,
    programId: PublicKey = constants.PROGRAM_ID_DEVNET
  ): PulsePDA {
    const [globalConfig] = PublicKey.findProgramAddressSync(
      [constants.SEED_GLOBAL_CONFIG],
      programId
    );

    const [poolState] = PublicKey.findProgramAddressSync(
      [constants.SEED_POOL_STATE, mint.toBuffer()],
      programId
    );

    const [feeVault] = PublicKey.findProgramAddressSync(
      [constants.SEED_FEE_VAULT, mint.toBuffer()],
      programId
    );

    const [feeRecipient] = PublicKey.findProgramAddressSync(
      [constants.SEED_FEE_RECIPIENT, mint.toBuffer()],
      programId
    );

    const [poolTokenAccount] = PublicKey.findProgramAddressSync(
      [constants.SEED_POOL_TOKENS, mint.toBuffer()],
      programId
    );

    const [lpReserveAccount] = PublicKey.findProgramAddressSync(
      [constants.SEED_LP_RESERVE, mint.toBuffer()],
      programId
    );

    const [stakeTokenVault] = PublicKey.findProgramAddressSync(
      [constants.SEED_STAKE_TOKEN_VAULT, mint.toBuffer()],
      programId
    );

    const [migrationVault] = PublicKey.findProgramAddressSync(
      [constants.SEED_MIGRATION_VAULT, mint.toBuffer()],
      programId
    );

    const [migrationConfig] = PublicKey.findProgramAddressSync(
      [constants.SEED_MIGRATION_CONFIG, mint.toBuffer()],
      programId
    );

    const [stakerVault] = PublicKey.findProgramAddressSync(
      [constants.SEED_STAKER_VAULT, mint.toBuffer()],
      programId
    );

    return new PulsePDA(
      programId,
      globalConfig,
      poolState,
      feeVault,
      feeRecipient,
      poolTokenAccount,
      lpReserveAccount,
      stakeTokenVault,
      migrationVault,
      migrationConfig,
      stakerVault
    );
  }

  /**
   * Derive a user-specific StakeAccount PDA.
   */
  static stakeAccount(
    mint: PublicKey,
    user: PublicKey,
    programId: PublicKey = constants.PROGRAM_ID_DEVNET
  ): PublicKey {
    const [stakeAccount] = PublicKey.findProgramAddressSync(
      [constants.SEED_STAKE, mint.toBuffer(), user.toBuffer()],
      programId
    );
    return stakeAccount;
  }

  /**
   * Derive the associated token address (ATA) for any wallet + mint.
   */
  static associatedTokenAddress(
    owner: PublicKey,
    mint: PublicKey
  ): PublicKey {
    const [ata] = PublicKey.findProgramAddressSync(
      [
        owner.toBuffer(),
        constants.TOKEN_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      constants.ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return ata;
  }

  /**
   * Derive the migration vault's ATA for a given mint.
   */
  static migrationVaultATA(
    mint: PublicKey,
    programId: PublicKey = constants.PROGRAM_ID_DEVNET
  ): PublicKey {
    const pdas = PulsePDA.derived(mint, programId);
    return PulsePDA.associatedTokenAddress(pdas.migrationVault, mint);
  }
}
