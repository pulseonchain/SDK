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
 * | Feature                        | Standard RPC | Helius    | Alchemy   |
 * |--------------------------------|--------------|-----------|-----------|
 * | Buy / Sell / Trade             | ✅           | ✅        | ✅        |
 * | Fetch pool state               | ✅           | ✅        | ✅        |
 * | Simulate quotes                | ✅           | ✅        | ✅        |
 * | Token metadata (name, image)   | ❌           | ✅ DAS    | ✅        |
 * | Wallet token portfolio         | ❌           | ✅        | ✅        |
 * | Transfer history               | ❌           | ❌        | ✅        |
 * | Portfolio analytics (combined) | ❌           | ❌        | ❌        |
 *
 * Use `Pulse.mainnet({ alchemyApiKey: "...", heliusApiKey: "..." })` for the full feature set.
 */

export { Pulse } from "./client";
export { PulsePDA } from "./pda";
export * as constants from "./constants";
export * from "./types";
export * from "./utils";
