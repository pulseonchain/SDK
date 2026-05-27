/**
 * @module errors
 *
 * Error handling system for the Pulse SDK.
 *
 * Provides typed error classes that map to on-chain Anchor error codes,
 * SDK-specific errors, and RPC/provider errors. Every error includes:
 * - A machine-readable `code`
 * - A human-readable `message`
 * - Optional `cause` for error chaining
 * - Context-specific data (mint address, expected vs actual values, etc.)
 *
 * @example
 * ```ts
 * import { PulseError, BondingError, isPulseError } from "@pulseonchain/sdk";
 *
 * try {
 *   await pulse.buy(wallet, params);
 * } catch (err) {
 *   if (isPulseError(err, "SlippageExceeded")) {
 *     console.log(`Slippage! Expected ${err.expected}, got ${err.actual}`);
 *   }
 * }
 * ```
 */

// ══════════════════════════════════════════════════════════════════════════════
// ON-CHAIN BONDING CURVE ERROR CODES
// ══════════════════════════════════════════════════════════════════════════════

/** All on-chain error codes from the Pulse bonding curve program */
export enum BondingErrorCode {
  Paused = 6000,
  Unauthorized = 6001,
  AlreadyGraduated = 6002,
  NotReadyToGraduate = 6003,
  ZeroSolAmount = 6004,
  ZeroTokenAmount = 6005,
  InsufficientPoolTokens = 6006,
  InsufficientPoolSol = 6007,
  SlippageExceeded = 6008,
  BelowMinReserve = 6009,
  InvalidMigrationConfig = 6010,
  InvalidShareSum = 6011,
  MathOverflow = 6012,
  InvalidPlatformWallet = 6013,
  ZeroStakeAmount = 6014,
  InsufficientStake = 6015,
  NoRewardsToClaim = 6016,
  NameTooLong = 6017,
  SymbolTooLong = 6018,
  UriTooLong = 6019,
  MissingFeeShareConfig = 6020,
}

/** Human-readable descriptions for each bonding error code */
export const BondingErrorMessages: Record<BondingErrorCode, string> = {
  [BondingErrorCode.Paused]: "Program is currently paused by the admin",
  [BondingErrorCode.Unauthorized]: "Signer is not the current authority for this pool",
  [BondingErrorCode.AlreadyGraduated]: "Token has already graduated to a DEX",
  [BondingErrorCode.NotReadyToGraduate]: "Token has not yet reached the graduation threshold (85 SOL)",
  [BondingErrorCode.ZeroSolAmount]: "SOL amount must be greater than zero",
  [BondingErrorCode.ZeroTokenAmount]: "Token amount must be greater than zero",
  [BondingErrorCode.InsufficientPoolTokens]: "Insufficient tokens in bonding pool for this buy",
  [BondingErrorCode.InsufficientPoolSol]: "Insufficient SOL in pool vault for this sell",
  [BondingErrorCode.SlippageExceeded]: "Output amount is below the user's minimum (slippage exceeded)",
  [BondingErrorCode.BelowMinReserve]: "Creator fee balance is below the minimum reserve — wait for more trading volume",
  [BondingErrorCode.InvalidMigrationConfig]: "Migration target configuration is invalid",
  [BondingErrorCode.InvalidShareSum]: "Meteora lp/staker/holder shares must sum to 100",
  [BondingErrorCode.MathOverflow]: "Arithmetic overflow in bonding curve calculation",
  [BondingErrorCode.InvalidPlatformWallet]: "Invalid platform wallet address",
  [BondingErrorCode.ZeroStakeAmount]: "Stake amount must be greater than zero",
  [BondingErrorCode.InsufficientStake]: "Insufficient staked balance to unstake that amount",
  [BondingErrorCode.NoRewardsToClaim]: "No staker rewards available to claim",
  [BondingErrorCode.NameTooLong]: "Token name too long (max 32 chars)",
  [BondingErrorCode.SymbolTooLong]: "Token symbol too long (max 10 chars)",
  [BondingErrorCode.UriTooLong]: "Token URI too long (max 200 chars)",
  [BondingErrorCode.MissingFeeShareConfig]: "This migration target requires Meteora fee-share config but none was provided",
};

/** Reverse map from numeric code to enum name */
const codeToName: Record<number, string> = {};
for (const [name, code] of Object.entries(BondingErrorCode)) {
  if (typeof code === "number") {
    codeToName[code] = name;
  }
}

/**
 * Get the error name from a numeric error code.
 * @example getErrorName(6008) // "SlippageExceeded"
 */
export function getErrorName(code: number): string | undefined {
  return codeToName[code];
}

// ══════════════════════════════════════════════════════════════════════════════
// SDK ERROR CODES
// ══════════════════════════════════════════════════════════════════════════════

export enum SdkErrorCode {
  // Connection errors
  ConnectionFailed = "CONNECTION_FAILED",
  Timeout = "TIMEOUT",
  RateLimited = "RATE_LIMITED",

  // Pool errors
  PoolNotFound = "POOL_NOT_FOUND",
  PoolAlreadyGraduated = "POOL_ALREADY_GRADUATED",
  PoolNotReadyToGraduate = "POOL_NOT_READY_TO_GRADUATE",

  // Transaction errors
  TransactionFailed = "TRANSACTION_FAILED",
  TransactionTimeout = "TRANSACTION_TIMEOUT",
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  SimulationFailed = "SIMULATION_FAILED",

  // Simulation errors
  SimulationSlippageExceeded = "SIMULATION_SLIPPAGE_EXCEEDED",
  SimulationInsufficientTokens = "SIMULATION_INSUFFICIENT_TOKENS",
  SimulationInsufficientSol = "SIMULATION_INSUFFICIENT_SOL",

  // Provider errors
  HeliusApiKeyMissing = "HELIUS_API_KEY_MISSING",
  AlchemyApiKeyMissing = "ALCHEMY_API_KEY_MISSING",
  BothApiKeysMissing = "BOTH_API_KEYS_MISSING",
  HeliusApiError = "HELIUS_API_ERROR",
  AlchemyApiError = "ALCHEMY_API_ERROR",

  // Validation errors
  InvalidMint = "INVALID_MINT",
  InvalidAmount = "INVALID_AMOUNT",
  InvalidMigrationTarget = "INVALID_MIGRATION_TARGET",
  InvalidSlippage = "INVALID_SLIPPAGE",
  EmptyWallet = "EMPTY_WALLET",
}

// ══════════════════════════════════════════════════════════════════════════════
// BASE ERROR CLASS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Base error class for all Pulse SDK errors.
 *
 * Extends the native `Error` with:
 * - `code` — machine-readable error code (either BondingErrorCode or SdkErrorCode)
 * - `cause` — the underlying error that caused this one
 * - `data` — arbitrary context data for debugging
 */
export class PulseError extends Error {
  public readonly code: BondingErrorCode | SdkErrorCode;
  public readonly cause?: Error;
  public readonly data?: Record<string, unknown>;
  public readonly timestamp: number;

  constructor(
    code: BondingErrorCode | SdkErrorCode,
    message: string,
    options?: { cause?: Error; data?: Record<string, unknown> }
  ) {
    super(message);
    this.name = "PulseError";
    this.code = code;
    this.cause = options?.cause;
    this.data = options?.data;
    this.timestamp = Date.now();

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, PulseError.prototype);

    // Capture stack trace, excluding the constructor call
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PulseError);
    }
  }

  /** Get a JSON-serializable representation of this error */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      data: this.data,
      timestamp: this.timestamp,
      cause: this.cause?.message,
    };
  }

  /** Get a human-readable string with all context */
  toDetailedString(): string {
    const lines = [
      `[${this.code}] ${this.message}`,
      `Timestamp: ${new Date(this.timestamp).toISOString()}`,
    ];
    if (this.data) {
      for (const [key, value] of Object.entries(this.data)) {
        lines.push(`  ${key}: ${JSON.stringify(value)}`);
      }
    }
    if (this.cause) {
      lines.push(`Caused by: ${this.cause.message}`);
    }
    return lines.join("\n");
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SPECIALIZED ERROR CLASSES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Thrown when a bonding curve trade fails slippage checks.
 * Contains the expected and actual amounts for building retry UIs.
 */
export class SlippageError extends PulseError {
  public readonly expected: bigint;
  public readonly actual: bigint;

  constructor(expected: bigint, actual: bigint, context?: { mint?: string }) {
    super(
      BondingErrorCode.SlippageExceeded,
      `Slippage exceeded: expected at least ${expected}, got ${actual}`,
      {
        data: {
          expected: expected.toString(),
          actual: actual.toString(),
          slippagePercent: expected > 0n
            ? Number((expected - actual) * 100n / expected)
            : 100,
          ...context,
        },
      }
    );
    this.name = "SlippageError";
    this.expected = expected;
    this.actual = actual;
    Object.setPrototypeOf(this, SlippageError.prototype);
  }
}

/**
 * Thrown when the wallet doesn't have enough SOL or tokens.
 */
export class InsufficientFundsError extends PulseError {
  public readonly required: bigint;
  public readonly available: bigint;
  public readonly token: "SOL" | "token";

  constructor(
    token: "SOL" | "token",
    required: bigint,
    available: bigint
  ) {
    super(
      SdkErrorCode.InsufficientFunds,
      `Insufficient ${token}: required ${required}, available ${available}`,
      {
        data: {
          token,
          required: required.toString(),
          available: available.toString(),
          deficit: (required - available).toString(),
        },
      }
    );
    this.name = "InsufficientFundsError";
    this.required = required;
    this.available = available;
    this.token = token;
    Object.setPrototypeOf(this, InsufficientFundsError.prototype);
  }
}

/**
 * Thrown when a pool is not found for a given mint.
 */
export class PoolNotFoundError extends PulseError {
  public readonly mint: string;

  constructor(mint: string) {
    super(SdkErrorCode.PoolNotFound, `No Pulse pool found for mint: ${mint}`, {
      data: { mint },
    });
    this.name = "PoolNotFoundError";
    this.mint = mint;
    Object.setPrototypeOf(this, PoolNotFoundError.prototype);
  }
}

/**
 * Thrown when trying to trade a token that has already graduated.
 */
export class AlreadyGraduatedError extends PulseError {
  public readonly mint: string;
  public readonly dexPool: string;

  constructor(mint: string, dexPool: string) {
    super(
      SdkErrorCode.PoolAlreadyGraduated,
      `Token ${mint} has already graduated to ${dexPool}`,
      { data: { mint, dexPool } }
    );
    this.name = "AlreadyGraduatedError";
    this.mint = mint;
    this.dexPool = dexPool;
    Object.setPrototypeOf(this, AlreadyGraduatedError.prototype);
  }
}

/**
 * Thrown when a transaction fails on-chain.
 */
export class TransactionError extends PulseError {
  public readonly signature: string;
  public readonly logs?: string[];

  constructor(signature: string, message: string, logs?: string[]) {
    super(SdkErrorCode.TransactionFailed, message, {
      data: { signature, logs },
    });
    this.name = "TransactionError";
    this.signature = signature;
    this.logs = logs;
    Object.setPrototypeOf(this, TransactionError.prototype);
  }
}

/**
 * Thrown when an RPC connection fails or times out.
 */
export class ConnectionError extends PulseError {
  public readonly url: string;
  public readonly attempt: number;

  constructor(url: string, message: string, attempt: number, cause?: Error) {
    super(SdkErrorCode.ConnectionFailed, message, {
      cause,
      data: { url, attempt },
    });
    this.name = "ConnectionError";
    this.url = url;
    this.attempt = attempt;
    Object.setPrototypeOf(this, ConnectionError.prototype);
  }
}

/**
 * Thrown when a required API key is missing.
 */
export class ApiKeyError extends PulseError {
  public readonly provider: "helius" | "alchemy" | "both";
  public readonly method: string;

  constructor(provider: "helius" | "alchemy" | "both", method: string) {
    const codeMap = {
      helius: SdkErrorCode.HeliusApiKeyMissing,
      alchemy: SdkErrorCode.AlchemyApiKeyMissing,
      both: SdkErrorCode.BothApiKeysMissing,
    };
    const msgMap = {
      helius: `Helius API key required for ${method}(). Pass heliusApiKey to Pulse.mainnet()`,
      alchemy: `Alchemy API key required for ${method}(). Pass alchemyApiKey to Pulse.mainnet()`,
      both: `Both Alchemy and Helius API keys required for ${method}()`,
    };
    super(codeMap[provider], msgMap[provider], { data: { provider, method } });
    this.name = "ApiKeyError";
    this.provider = provider;
    this.method = method;
    Object.setPrototypeOf(this, ApiKeyError.prototype);
  }
}

/**
 * Thrown when a simulation fails before submitting a transaction.
 */
export class SimulationError extends PulseError {
  public readonly instruction: string;
  public readonly reason: string;

  constructor(instruction: string, reason: string) {
    super(SdkErrorCode.SimulationFailed, `Simulation failed for ${instruction}: ${reason}`, {
      data: { instruction, reason },
    });
    this.name = "SimulationError";
    this.instruction = instruction;
    this.reason = reason;
    Object.setPrototypeOf(this, SimulationError.prototype);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ERROR TYPE GUARDS
// ══════════════════════════════════════════════════════════════════════════════

/** Check if an error is a PulseError */
export function isPulseError(err: unknown): err is PulseError;
export function isPulseError(err: unknown, code: BondingErrorCode | SdkErrorCode): err is PulseError;
export function isPulseError(
  err: unknown,
  code?: BondingErrorCode | SdkErrorCode
): err is PulseError {
  if (!(err instanceof PulseError)) return false;
  if (code !== undefined) return err.code === code;
  return true;
}

/** Check if an error is a SlippageError */
export function isSlippageError(err: unknown): err is SlippageError {
  return err instanceof SlippageError;
}

/** Check if an error is an InsufficientFundsError */
export function isInsufficientFundsError(err: unknown): err is InsufficientFundsError {
  return err instanceof InsufficientFundsError;
}

/** Check if an error is a PoolNotFoundError */
export function isPoolNotFoundError(err: unknown): err is PoolNotFoundError {
  return err instanceof PoolNotFoundError;
}

/** Check if an error is an AlreadyGraduatedError */
export function isAlreadyGraduatedError(err: unknown): err is AlreadyGraduatedError {
  return err instanceof AlreadyGraduatedError;
}

/** Check if an error is a TransactionError */
export function isTransactionError(err: unknown): err is TransactionError {
  return err instanceof TransactionError;
}

/** Check if an error is a ConnectionError */
export function isConnectionError(err: unknown): err is ConnectionError {
  return err instanceof ConnectionError;
}

/** Check if an error is an ApiKeyError */
export function isApiKeyError(err: unknown): err is ApiKeyError {
  return err instanceof ApiKeyError;
}

// ══════════════════════════════════════════════════════════════════════════════
// ERROR PARSING
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Parse an on-chain Anchor error from a transaction log or RPC error response.
 * Returns a typed PulseError or null if the error is not a known Pulse error.
 *
 * @example
 * ```ts
 * try {
 *   await connection.sendRawTransaction(signed.serialize());
 * } catch (err) {
 *   const pulseError = parseAnchorError(err);
 *   if (pulseError) {
 *     console.log(pulseError.toDetailedString());
 *   }
 * }
 * ```
 */
export function parseAnchorError(err: unknown): PulseError | null {
  const message = err instanceof Error ? err.message : String(err);

  // Anchor errors typically look like: "custom program error: 0x1770"
  // where 0x1770 = 6000 in decimal = BondingErrorCode.Paused
  const customProgramMatch = message.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (customProgramMatch) {
    const code = parseInt(customProgramMatch[1], 16);
    const description = BondingErrorMessages[code as BondingErrorCode] || `Unknown error code: ${code}`;
    return new PulseError(code as BondingErrorCode, description, {
      data: { rawMessage: message },
    });
  }

  // Also check for decimal error codes
  const decimalMatch = message.match(/error code: (\d+)/i);
  if (decimalMatch) {
    const code = parseInt(decimalMatch[1], 10);
    if (code >= 6000 && code <= 6020) {
      const description = BondingErrorMessages[code as BondingErrorCode] || `Unknown error code: ${code}`;
      return new PulseError(code as BondingErrorCode, description, {
        data: { rawMessage: message },
      });
    }
  }

  // Check for specific error message patterns
  if (message.includes("SlippageExceeded") || message.includes("slippage")) {
    return new PulseError(
      BondingErrorCode.SlippageExceeded,
      "Transaction failed: slippage exceeded. Try increasing your minimum output.",
      { data: { rawMessage: message } }
    );
  }

  if (message.includes("AlreadyGraduated") || message.includes("already graduated")) {
    return new PulseError(
      BondingErrorCode.AlreadyGraduated,
      "Transaction failed: token has already graduated to a DEX",
      { data: { rawMessage: message } }
    );
  }

  if (message.includes("InsufficientFunds") || message.includes("insufficient funds")) {
    return new PulseError(
      SdkErrorCode.InsufficientFunds,
      "Transaction failed: insufficient funds",
      { data: { rawMessage: message } }
    );
  }

  return null;
}

/**
 * Wrap any error in a PulseError if it isn't already one.
 * Useful for ensuring consistent error handling throughout your app.
 */
export function wrapError(
  err: unknown,
  fallbackCode: SdkErrorCode = SdkErrorCode.TransactionFailed,
  fallbackMessage?: string
): PulseError {
  if (err instanceof PulseError) return err;

  const message = err instanceof Error ? err.message : String(err);
  return new PulseError(
    fallbackCode,
    fallbackMessage || message,
    err instanceof Error ? { cause: err } : undefined
  );
}
