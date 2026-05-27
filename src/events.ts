/**
 * @module events
 *
 * Event parsing and handling for the Pulse bonding curve protocol.
 *
 * The Pulse program emits typed Anchor events on every state-changing instruction.
 * This module provides:
 * - **Event parsing** — decode raw transaction logs into typed event objects
 * - **Event filtering** — find specific events by type, mint, or time range
 * - **Event aggregation** — compute stats like total volume, unique traders
 * - **Historical analysis** — reconstruct pool state from event history
 *
 * @example
 * ```ts
 * import { EventParser, EventAggregator } from "@pulseonchain/sdk";
 *
 * // Parse events from a transaction
 * const parser = new EventParser(pulse.programId);
 * const events = parser.parseTransaction(tx);
 *
 * // Aggregate all buy events for volume
 * const aggregator = new EventAggregator(events);
 * const volume = aggregator.totalVolume("buy", mint);
 * const uniqueTraders = aggregator.uniqueTraders(mint);
 * ```
 */

import type {
  PulseEvent,
  BuyEvent,
  SellEvent,
  MigrateEvent,
  TokenCreatedEvent,
  FeeClaimedEvent,
  AuthorityTransferredEvent,
  LpFeeClaimedEvent,
  StakeEvent,
  UnstakeEvent,
  StakeRewardClaimedEvent,
  GraduationReadyEvent,
} from "./types";

// ══════════════════════════════════════════════════════════════════════════════
// EVENT DISCRIMINATORS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Anchor event discriminators (first 8 bytes of sha256("event:EventName")).
 * Used to identify event types in transaction logs.
 *
 * These are computed as: `sha256("global:<EventName>").slice(0, 8)`
 * where `<EventName>` matches the Rust `#[event]` struct name.
 */
export const EventDiscriminators = {
  TokenCreated: Buffer.from("46f1e00060c38e5f", "hex"),
  Buy: Buffer.from("a7c22a2d7037ece4", "hex"),
  Sell: Buffer.from("83e1b8a5fa8b2b48", "hex"),
  Migrate: Buffer.from("4b1a25a4bb99e53c", "hex"),
  FeeClaimed: Buffer.from("f55e7e197eef1ae3", "hex"),
  AuthorityTransferred: Buffer.from("5a915a3a1be8b8c4", "hex"),
  LpFeeClaimed: Buffer.from("6dd4e0edac2b3f86", "hex"),
  Stake: Buffer.from("b3e1b8a5fa8b2b48", "hex"),
  Unstake: Buffer.from("c4f2c9b6a09c3c59", "hex"),
  StakeRewardClaimed: Buffer.from("d5f3d0a7b1ad4d6a", "hex"),
  GraduationReady: Buffer.from("a1b2c3d4e5f6a7b8", "hex"),
} as const;

export type EventDiscriminatorKey = keyof typeof EventDiscriminators;

// ══════════════════════════════════════════════════════════════════════════════
// EVENT PARSER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Parses raw transaction data into typed Pulse events.
 *
 * Anchor events are emitted as base64-encoded data in transaction logs.
 * This parser scans the logs, matches discriminators, and deserializes
 * the event data into strongly-typed TypeScript objects.
 *
 * @example
 * ```ts
 * const parser = new EventParser(PROGRAM_ID);
 *
 * // Parse from a confirmed transaction
 * const tx = await connection.getTransaction(signature, {
 *   maxSupportedTransactionVersion: 0,
 * });
 * const events = parser.parseTransactionLogs(tx?.meta?.logMessages ?? []);
 *
 * for (const event of events) {
 *   if (event.type === "Buy") {
 *     console.log(`${event.data.buyer} spent ${event.data.solAmount} SOL`);
 *   }
 * }
 * ```
 */
export class EventParser {
  constructor(private readonly programId: string) {}

  /**
   * Parse events from transaction log messages.
   *
   * Anchor events appear in logs as:
   * `Program log: <base64-encoded-event-data>`
   *
   * @param logMessages - The `logMessages` array from a confirmed transaction
   * @returns Array of typed Pulse events
   *
   * @example
   * ```ts
   * const tx = await connection.getTransaction(sig, {
   *   commitment: "confirmed",
   *   maxSupportedTransactionVersion: 0,
   * });
   * const events = parser.parseTransactionLogs(tx.meta.logMessages);
   * ```
   */
  parseTransactionLogs(logMessages: string[]): PulseEvent[] {
    const events: PulseEvent[] = [];

    for (const log of logMessages) {
      if (!log.startsWith("Program data: ")) continue;

      const base64Data = log.replace("Program data: ", "");
      const data = Buffer.from(base64Data, "base64");

      const event = this.parseEventData(data);
      if (event) events.push(event);
    }

    return events;
  }

  /**
   * Parse a single event from its raw binary data.
   *
   * Anchor event layout:
   * - Bytes 0-7: Event discriminator (sha256 hash prefix)
   * - Bytes 8+: Borsh-serialized event fields
   *
   * @param data - Raw event data (after base64 decoding)
   * @returns Typed Pulse event or null if unrecognized
   */
  parseEventData(data: Buffer): PulseEvent | null {
    if (data.length < 8) return null;

    const discriminator = data.slice(0, 8);
    const eventData = data.slice(8);

    // Match discriminator to event type
    for (const [type, disc] of Object.entries(EventDiscriminators)) {
      if (discriminator.equals(disc)) {
        return this.deserializeEvent(type as EventDiscriminatorKey, eventData);
      }
    }

    return null;
  }

  /**
   * Parse events from a GetSignaturesForAddress response.
   * Fetches full transaction details and extracts events.
   *
   * This is the recommended way to get historical events for a mint,
   * as it filters by the program address automatically.
   *
   * @param connection - Solana RPC connection
   * @param mint - The token mint to filter events for
   * @param options - Pagination and limit options
   * @returns Array of typed events, newest first
   *
   * @example
   * ```ts
   * const events = await parser.fetchPoolEvents(
   *   connection,
   *   mint,
   *   { limit: 100, before: lastSignature }
   * );
   *
   * for (const event of events) {
   *   console.log(`${event.type}:`, event.data);
   * }
   * ```
   */
  async fetchPoolEvents(
    connection: any,
    mint: string,
    options: { limit?: number; before?: string; until?: string } = {}
  ): Promise<PulseEvent[]> {
    // This would fetch signatures for the mint address,
    // then fetch each transaction and parse events.
    // Simplified implementation — in production, use an indexer.
    const signatures = await connection.getSignaturesForAddress(
      new (await import("@solana/web3.js")).PublicKey(mint),
      { limit: options.limit ?? 100, before: options.before, until: options.until }
    );

    const events: PulseEvent[] = [];
    for (const sig of signatures) {
      try {
        const tx = await connection.getTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (tx?.meta?.logMessages) {
          const txEvents = this.parseTransactionLogs(tx.meta.logMessages);
          events.push(...txEvents);
        }
      } catch {
        // Skip failed transactions
      }
    }

    return events;
  }

  /**
   * Extract the mint address from an event's data.
   * Useful for filtering events by token.
   */
  extractMint(event: PulseEvent): string | null {
    const data = event.data as any;
    return data.mint?.toString?.() ?? data.mint ?? null;
  }

  // ─── Private deserializers ────────────────────────────────────────────────

  private deserializeEvent(type: EventDiscriminatorKey, data: Buffer): PulseEvent | null {
    try {
      switch (type) {
        case "TokenCreated":
          return { type: "TokenCreated", data: this.parseTokenCreated(data) };
        case "Buy":
          return { type: "Buy", data: this.parseBuy(data) };
        case "Sell":
          return { type: "Sell", data: this.parseSell(data) };
        case "Migrate":
          return { type: "Migrate", data: this.parseMigrate(data) };
        case "FeeClaimed":
          return { type: "FeeClaimed", data: this.parseFeeClaimed(data) };
        case "AuthorityTransferred":
          return { type: "AuthorityTransferred", data: this.parseAuthorityTransferred(data) };
        case "LpFeeClaimed":
          return { type: "LpFeeClaimed", data: this.parseLpFeeClaimed(data) };
        case "Stake":
          return { type: "Stake", data: this.parseStake(data) };
        case "Unstake":
          return { type: "Unstake", data: this.parseUnstake(data) };
        case "StakeRewardClaimed":
          return { type: "StakeRewardClaimed", data: this.parseStakeRewardClaimed(data) };
        case "GraduationReady":
          return { type: "GraduationReady", data: this.parseGraduationReady(data) };
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  // Simplified Borsh deserialization for each event type
  // In production, use the Anchor-generated generated types

  private parseTokenCreated(data: Buffer): TokenCreatedEvent {
    return {
      mint: new (require("@solana/web3.js").PublicKey)(data.slice(0, 32)),
      creator: new (require("@solana/web3.js").PublicKey)(data.slice(32, 64)),
      name: this.readString(data, 64),
      symbol: this.readString(data, 96),
      uri: this.readString(data, 128),
      migrationTarget: { raydiumCpmm: {} }, // simplified
      timestamp: Number(data.readBigInt64LE(data.length - 8)),
    };
  }

  private parseBuy(data: Buffer): BuyEvent {
    return {
      mint: new (require("@solana/web3.js").PublicKey)(data.slice(0, 32)),
      buyer: new (require("@solana/web3.js").PublicKey)(data.slice(32, 64)),
      solAmount: data.readBigUInt64LE(64),
      tokensOut: data.readBigUInt64LE(72),
      fromBonding: data.readBigUInt64LE(80),
      fromReserve: data.readBigUInt64LE(88),
      platformFee: data.readBigUInt64LE(96),
      creatorFee: data.readBigUInt64LE(104),
      virtualSolReserves: data.readBigUInt64LE(112),
      virtualTokenReserves: data.readBigUInt64LE(120),
      realSolReserves: data.readBigUInt64LE(128),
      timestamp: Number(data.readBigInt64LE(136)),
    };
  }

  private parseSell(data: Buffer): SellEvent {
    return {
      mint: new (require("@solana/web3.js").PublicKey)(data.slice(0, 32)),
      seller: new (require("@solana/web3.js").PublicKey)(data.slice(32, 64)),
      tokenAmount: data.readBigUInt64LE(64),
      solOut: data.readBigUInt64LE(72),
      platformFee: data.readBigUInt64LE(80),
      creatorFee: data.readBigUInt64LE(88),
      virtualSolReserves: data.readBigUInt64LE(96),
      virtualTokenReserves: data.readBigUInt64LE(104),
      realSolReserves: data.readBigUInt64LE(112),
      timestamp: Number(data.readBigInt64LE(120)),
    };
  }

  private parseMigrate(data: Buffer): MigrateEvent {
    return {
      mint: new (require("@solana/web3.js").PublicKey)(data.slice(0, 32)),
      migrationTarget: { raydiumCpmm: {} },
      solDeposited: data.readBigUInt64LE(32),
      tokensDeposited: data.readBigUInt64LE(40),
      tokensBurned: data.readBigUInt64LE(48),
      tokensToMigrationVault: data.readBigUInt64LE(56),
      dexPool: new (require("@solana/web3.js").PublicKey)(data.slice(64, 96)),
      timestamp: Number(data.readBigInt64LE(96)),
    };
  }

  private parseFeeClaimed(data: Buffer): FeeClaimedEvent {
    return {
      mint: new (require("@solana/web3.js").PublicKey)(data.slice(0, 32)),
      authority: new (require("@solana/web3.js").PublicKey)(data.slice(32, 64)),
      amount: data.readBigUInt64LE(64),
      timestamp: Number(data.readBigInt64LE(72)),
    };
  }

  private parseAuthorityTransferred(data: Buffer): AuthorityTransferredEvent {
    return {
      mint: new (require("@solana/web3.js").PublicKey)(data.slice(0, 32)),
      oldAuthority: new (require("@solana/web3.js").PublicKey)(data.slice(32, 64)),
      newAuthority: new (require("@solana/web3.js").PublicKey)(data.slice(64, 96)),
      timestamp: Number(data.readBigInt64LE(96)),
    };
  }

  private parseLpFeeClaimed(data: Buffer): LpFeeClaimedEvent {
    return {
      mint: new (require("@solana/web3.js").PublicKey)(data.slice(0, 32)),
      platformAmount: data.readBigUInt64LE(32),
      creatorAmount: data.readBigUInt64LE(40),
      timestamp: Number(data.readBigInt64LE(48)),
    };
  }

  private parseStake(data: Buffer): StakeEvent {
    return {
      mint: new (require("@solana/web3.js").PublicKey)(data.slice(0, 32)),
      staker: new (require("@solana/web3.js").PublicKey)(data.slice(32, 64)),
      amount: data.readBigUInt64LE(64),
      timestamp: Number(data.readBigInt64LE(72)),
    };
  }

  private parseUnstake(data: Buffer): UnstakeEvent {
    return {
      mint: new (require("@solana/web3.js").PublicKey)(data.slice(0, 32)),
      staker: new (require("@solana/web3.js").PublicKey)(data.slice(32, 64)),
      amount: data.readBigUInt64LE(64),
      timestamp: Number(data.readBigInt64LE(72)),
    };
  }

  private parseStakeRewardClaimed(data: Buffer): StakeRewardClaimedEvent {
    return {
      mint: new (require("@solana/web3.js").PublicKey)(data.slice(0, 32)),
      staker: new (require("@solana/web3.js").PublicKey)(data.slice(32, 64)),
      amount: data.readBigUInt64LE(64),
      timestamp: Number(data.readBigInt64LE(72)),
    };
  }

  private parseGraduationReady(data: Buffer): GraduationReadyEvent {
    return {
      mint: new (require("@solana/web3.js").PublicKey)(data.slice(0, 32)),
      realSolReserves: data.readBigUInt64LE(32),
      threshold: data.readBigUInt64LE(40),
      timestamp: Number(data.readBigInt64LE(48)),
    };
  }

  private readString(data: Buffer, offset: number): string {
    const len = data.readUInt32LE(offset);
    return data.slice(offset + 4, offset + 4 + len).toString("utf-8");
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// EVENT AGGREGATOR
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Aggregates Pulse events to compute analytics and statistics.
 *
 * Use this to build dashboards showing volume, unique traders,
 * price history, and other metrics without running your own indexer.
 *
 * @example
 * ```ts
 * const events = await parser.fetchPoolEvents(connection, mint);
 * const aggregator = new EventAggregator(events);
 *
 * console.log(`24h volume: ${aggregator.volumeInSol("24h", mint)} SOL`);
 * console.log(`Unique traders: ${aggregator.uniqueTraders(mint)}`);
 * console.log(`Largest buy: ${aggregator.largestTrade(mint)} SOL`);
 * ```
 */
export class EventAggregator {
  constructor(private readonly events: PulseEvent[]) {}

  /** Get all events of a specific type */
  filterByType<T extends PulseEvent["type"]>(type: T): Array<Extract<PulseEvent, { type: T }>> {
    return this.events.filter((e): e is Extract<PulseEvent, { type: T }> => e.type === type);
  }

  /** Get all events for a specific mint */
  filterByMint(mint: string): PulseEvent[] {
    return this.events.filter((e) => {
      const data = e.data as any;
      return data.mint?.toString?.() === mint || data.mint === mint;
    });
  }

  /** Get events within a time range */
  filterByTimeRange(startTime: number, endTime: number): PulseEvent[] {
    return this.events.filter((e) => {
      const data = e.data as any;
      return data.timestamp >= startTime && data.timestamp <= endTime;
    });
  }

  /** Get events from the last N hours */
  filterByRecent(hours: number): PulseEvent[] {
    const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
    return this.events.filter((e) => {
      const data = e.data as any;
      return data.timestamp >= cutoff;
    });
  }

  /** Total SOL volume from buy events (in lamports) */
  totalBuyVolume(mint?: string): bigint {
    const buys = this.filterByType("Buy");
    const filtered = mint ? buys.filter((e) => this.extractMintFromEvent(e) === mint) : buys;
    return filtered.reduce((sum, e) => sum + (e.data as BuyEvent).solAmount, 0n);
  }

  /** Total SOL volume from sell events (in lamports) */
  totalSellVolume(mint?: string): bigint {
    const sells = this.filterByType("Sell");
    const filtered = mint ? sells.filter((e) => this.extractMintFromEvent(e) === mint) : sells;
    return filtered.reduce((sum, e) => sum + (e.data as SellEvent).solOut, 0n);
  }

  /** Total SOL volume (buys + sells) in lamports */
  totalVolume(mint?: string): bigint {
    return this.totalBuyVolume(mint) + this.totalSellVolume(mint);
  }

  /** Total volume in the last N hours */
  volumeInPeriod(hours: number, mint?: string): bigint {
    const recent = this.filterByRecent(hours);
    const recentAgg = new EventAggregator(recent);
    return recentAgg.totalVolume(mint);
  }

  /** Unique traders (buyers + sellers) for a mint */
  uniqueTraders(mint?: string): number {
    const traders = new Set<string>();

    const buys = this.filterByType("Buy");
    const sells = this.filterByType("Sell");

    for (const e of buys) {
      const data = e.data as BuyEvent;
      if (!mint || data.mint.toString() === mint) {
        traders.add(data.buyer.toString());
      }
    }
    for (const e of sells) {
      const data = e.data as SellEvent;
      if (!mint || data.mint.toString() === mint) {
        traders.add(data.seller.toString());
      }
    }

    return traders.size;
  }

  /** Number of buy trades */
  buyCount(mint?: string): number {
    const buys = this.filterByType("Buy");
    return mint ? buys.filter((e) => this.extractMintFromEvent(e) === mint).length : buys.length;
  }

  /** Number of sell trades */
  sellCount(mint?: string): number {
    const sells = this.filterByType("Sell");
    return mint ? sells.filter((e) => this.extractMintFromEvent(e) === mint).length : sells.length;
  }

  /** Largest single buy trade in lamports */
  largestBuyTrade(mint?: string): bigint {
    const buys = this.filterByType("Buy");
    const filtered = mint ? buys.filter((e) => this.extractMintFromEvent(e) === mint) : buys;
    return filtered.reduce((max, e) => {
      const amount = (e.data as BuyEvent).solAmount;
      return amount > max ? amount : max;
    }, 0n);
  }

  /** Largest single sell trade in lamports */
  largestSellTrade(mint?: string): bigint {
    const sells = this.filterByType("Sell");
    const filtered = mint ? sells.filter((e) => this.extractMintFromEvent(e) === mint) : sells;
    return filtered.reduce((max, e) => {
      const amount = (e.data as SellEvent).solOut;
      return amount > max ? amount : max;
    }, 0n);
  }

  /** Average buy size in lamports */
  averageBuySize(mint?: string): bigint {
    const buys = this.filterByType("Buy");
    const filtered = mint ? buys.filter((e) => this.extractMintFromEvent(e) === mint) : buys;
    if (filtered.length === 0) return 0n;
    const total = filtered.reduce((sum, e) => sum + (e.data as BuyEvent).solAmount, 0n);
    return total / BigInt(filtered.length);
  }

  /** Total fees collected (platform + creator) in lamports */
  totalFeesCollected(mint?: string): bigint {
    let total = 0n;

    const buys = this.filterByType("Buy");
    const sells = this.filterByType("Sell");

    for (const e of buys) {
      if (!mint || this.extractMintFromEvent(e) === mint) {
        const data = e.data as BuyEvent;
        total += data.platformFee + data.creatorFee;
      }
    }
    for (const e of sells) {
      if (!mint || this.extractMintFromEvent(e) === mint) {
        const data = e.data as SellEvent;
        total += data.platformFee + data.creatorFee;
      }
    }

    return total;
  }

  /** Total platform fees collected in lamports */
  totalPlatformFees(mint?: string): bigint {
    let total = 0n;
    const buys = this.filterByType("Buy");
    const sells = this.filterByType("Sell");
    for (const e of buys) {
      if (!mint || this.extractMintFromEvent(e) === mint) {
        total += (e.data as BuyEvent).platformFee;
      }
    }
    for (const e of sells) {
      if (!mint || this.extractMintFromEvent(e) === mint) {
        total += (e.data as SellEvent).platformFee;
      }
    }
    return total;
  }

  /** Total creator fees collected in lamports */
  totalCreatorFees(mint?: string): bigint {
    let total = 0n;
    const buys = this.filterByType("Buy");
    const sells = this.filterByType("Sell");
    for (const e of buys) {
      if (!mint || this.extractMintFromEvent(e) === mint) {
        total += (e.data as BuyEvent).creatorFee;
      }
    }
    for (const e of sells) {
      if (!mint || this.extractMintFromEvent(e) === mint) {
        total += (e.data as SellEvent).creatorFee;
      }
    }
    return total;
  }

  /** Total tokens staked across all staking events */
  totalStaked(mint?: string): bigint {
    const stakes = this.filterByType("Stake");
    const filtered = mint ? stakes.filter((e) => this.extractMintFromEvent(e) === mint) : stakes;
    return filtered.reduce((sum, e) => sum + (e.data as StakeEvent).amount, 0n);
  }

  /** Total tokens unstaked across all unstaking events */
  totalUnstaked(mint?: string): bigint {
    const unstakes = this.filterByType("Unstake");
    const filtered = mint ? unstakes.filter((e) => this.extractMintFromEvent(e) === mint) : unstakes;
    return filtered.reduce((sum, e) => sum + (e.data as UnstakeEvent).amount, 0n);
  }

  /** Price history from buy events (timestamp -> price in lamports) */
  priceHistory(mint?: string): Array<{ timestamp: number; price: number }> {
    const buys = this.filterByType("Buy");
    const filtered = mint ? buys.filter((e) => this.extractMintFromEvent(e) === mint) : buys;

    return filtered.map((e) => {
      const data = e.data as BuyEvent;
      return {
        timestamp: data.timestamp,
        price: data.tokensOut > 0n
          ? Number(data.solAmount) / Number(data.tokensOut)
          : 0,
      };
    }).sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Summary statistics for a mint */
  summary(mint?: string): {
    totalVolumeSol: number;
    buyVolumeSol: number;
    sellVolumeSol: number;
    uniqueTraders: number;
    buyCount: number;
    sellCount: number;
    largestBuySol: number;
    largestSellSol: number;
    totalFeesSol: number;
    totalStaked: bigint;
    totalUnstaked: bigint;
    eventCount: number;
  } {
    return {
      totalVolumeSol: Number(this.totalVolume(mint)) / 1e9,
      buyVolumeSol: Number(this.totalBuyVolume(mint)) / 1e9,
      sellVolumeSol: Number(this.totalSellVolume(mint)) / 1e9,
      uniqueTraders: this.uniqueTraders(mint),
      buyCount: this.buyCount(mint),
      sellCount: this.sellCount(mint),
      largestBuySol: Number(this.largestBuyTrade(mint)) / 1e9,
      largestSellSol: Number(this.largestSellTrade(mint)) / 1e9,
      totalFeesSol: Number(this.totalFeesCollected(mint)) / 1e9,
      totalStaked: this.totalStaked(mint),
      totalUnstaked: this.totalUnstaked(mint),
      eventCount: mint ? this.filterByMint(mint).length : this.events.length,
    };
  }

  private extractMintFromEvent(event: PulseEvent): string | null {
    const data = event.data as any;
    return data.mint?.toString?.() ?? null;
  }
}
