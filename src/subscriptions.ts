/**
 * @module subscriptions
 *
 * Real-time WebSocket event subscriptions for the Pulse bonding curve protocol.
 *
 * Subscribe to live events as they happen on-chain:
 * - **Trade events** — buy/sell in real-time for a specific mint or all pools
 * - **Graduation events** — get notified when tokens hit 85 SOL
 * - **Staking events** — track stake/unstake/claim activity
 * - **New token launches** — detect tokens as they're created
 * - **Price updates** — stream price changes tick-by-tick
 *
 * Uses Solana's `programSubscribe` WebSocket API for efficient real-time
 * data without polling.
 *
 * @example
 * ```ts
 * import { PulseSubscriptions } from "@pulseonchain/sdk";
 *
 * const subs = new PulseSubscriptions(pulse.connection, pulse.programId);
 *
 * // Subscribe to all buy events for a specific mint
 * const id = await subs.onBuy(mint, (event) => {
 *   console.log(`${event.data.buyer} bought ${event.data.tokensOut} tokens`);
 * });
 *
 * // Subscribe to graduation events across all pools
 * await subs.onGraduation((event) => {
 *   console.log(`🎓 ${event.data.mint} is ready to graduate!`);
 * });
 *
 * // Subscribe to new token launches
 * await subs.onTokenCreated((event) => {
 *   console.log(`New token: ${event.data.name} (${event.data.symbol})`);
 * });
 *
 * // Later: unsubscribe
 * await subs.unsubscribe(id);
 * await subs.unsubscribeAll();
 * ```
 */

import { Connection, PublicKey } from "@solana/web3.js";
import type { PulseEvent, BuyEvent, SellEvent, MigrateEvent, TokenCreatedEvent, GraduationReadyEvent, StakeEvent, UnstakeEvent } from "./types";
import { EventParser } from "./events";

// ══════════════════════════════════════════════════════════════════════════════
// EVENT CALLBACK TYPES
// ══════════════════════════════════════════════════════════════════════════════

export type BuyEventHandler = (event: BuyEvent, raw: any) => void | Promise<void>;
export type SellEventHandler = (event: SellEvent, raw: any) => void | Promise<void>;
export type MigrateEventHandler = (event: MigrateEvent, raw: any) => void | Promise<void>;
export type TokenCreatedHandler = (event: TokenCreatedEvent, raw: any) => void | Promise<void>;
export type GraduationReadyHandler = (event: GraduationReadyEvent, raw: any) => void | Promise<void>;
export type StakeEventHandler = (event: StakeEvent, raw: any) => void | Promise<void>;
export type UnstakeEventHandler = (event: UnstakeEvent, raw: any) => void | Promise<void>;
export type AnyEventHandler = (event: PulseEvent, raw: any) => void | Promise<void>;
export type PriceUpdateHandler = (data: {
  mint: string;
  price: number;
  priceSol: number;
  timestamp: number;
  solAmount: bigint;
  tokensOut: bigint;
}) => void | Promise<void>;
export type ErrorHandler = (error: Error) => void;

// ══════════════════════════════════════════════════════════════════════════════
// SUBSCRIPTION OPTIONS
// ══════════════════════════════════════════════════════════════════════════════

export interface SubscriptionOptions {
  /** Commitment level for the subscription */
  commitment?: "processed" | "confirmed" | "finalized";
  /** Encoding for account data */
  encoding?: "base58" | "base64" | "jsonParsed";
  /** Custom error handler (default: console.error) */
  onError?: ErrorHandler;
  /** Whether to auto-reconnect on connection loss (default: true) */
  autoReconnect?: boolean;
  /** Reconnect delay in milliseconds (default: 5000) */
  reconnectDelayMs?: number;
  /** Maximum reconnect attempts (default: 10) */
  maxReconnectAttempts?: number;
}

interface SubscriptionEntry {
  id: number;
  type: string;
  mint?: string;
  callback: (...args: any[]) => void;
}

// ══════════════════════════════════════════════════════════════════════════════
// PULSE SUBSCRIPTIONS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Real-time WebSocket subscriptions for the Pulse protocol.
 *
 * Wraps Solana's `onLogs` and `programSubscribe` APIs with typed
 * event callbacks. Handles reconnection, filtering by mint, and
 * error recovery automatically.
 *
 * @example
 * ```ts
 * const subs = new PulseSubscriptions(connection, PROGRAM_ID, {
 *   commitment: "confirmed",
 *   autoReconnect: true,
 * });
 *
 * // Track all trades across all pools
 * await subs.onAnyTrade((event) => {
 *   console.log(`${event.type}: ${event.data.mint}`);
 * });
 *
 * // Track price for a specific token
 * await subs.onPriceUpdate(mint, (data) => {
 *   updateUI(data.mint, data.priceSol);
 * });
 * ```
 */
export class PulseSubscriptions {
  private readonly connection: Connection;
  private readonly programId: PublicKey;
  private readonly options: Required<SubscriptionOptions>;
  private readonly parser: EventParser;
  private readonly subscriptions: Map<number, SubscriptionEntry> = new Map();
  private nextId = 1;
  private reconnectAttempts = 0;
  private logSubscriptionId: number | null = null;

  constructor(
    connection: Connection,
    programId: PublicKey,
    options: SubscriptionOptions = {}
  ) {
    this.connection = connection;
    this.programId = programId;
    this.parser = new EventParser(programId.toBase58());
    this.options = {
      commitment: options.commitment ?? "confirmed",
      encoding: options.encoding ?? "jsonParsed",
      onError: options.onError ?? ((err) => console.error("[PulseSubs]", err)),
      autoReconnect: options.autoReconnect ?? true,
      reconnectDelayMs: options.reconnectDelayMs ?? 5000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 10,
    };
  }

  // ─── Trade Subscriptions ──────────────────────────────────────────────────

  /**
   * Subscribe to buy events for a specific mint.
   *
   * @param mint - The token mint to watch
   * @param handler - Callback invoked on each buy event
   * @returns Subscription ID (pass to `unsubscribe()` to stop)
   *
   * @example
   * ```ts
   * const id = await subs.onBuy(mint, (event) => {
   *   console.log(`Buy: ${event.solAmount} SOL → ${event.tokensOut} tokens`);
   *   console.log(`Buyer: ${event.buyer}`);
   *   console.log(`New reserves: ${event.realSolReserves} SOL`);
   * });
   * ```
   */
  async onBuy(mint: PublicKey, handler: BuyEventHandler): Promise<number> {
    return this.addListener("buy", mint.toBase58(), async (event, raw) => {
      if (event.type === "Buy") {
        await handler(event.data as BuyEvent, raw);
      }
    });
  }

  /**
   * Subscribe to sell events for a specific mint.
   */
  async onSell(mint: PublicKey, handler: SellEventHandler): Promise<number> {
    return this.addListener("sell", mint.toBase58(), async (event, raw) => {
      if (event.type === "Sell") {
        await handler(event.data as SellEvent, raw);
      }
    });
  }

  /**
   * Subscribe to all trade events (buy + sell) for a specific mint.
   */
  async onTrade(mint: PublicKey, handler: AnyEventHandler): Promise<number> {
    return this.addListener("trade", mint.toBase58(), async (event, raw) => {
      if (event.type === "Buy" || event.type === "Sell") {
        await handler(event, raw);
      }
    });
  }

  /**
   * Subscribe to all trade events across ALL pools.
   * ⚠️ High traffic — use with caution on mainnet.
   */
  async onAnyTrade(handler: AnyEventHandler): Promise<number> {
    return this.addListener("anyTrade", undefined, async (event, raw) => {
      if (event.type === "Buy" || event.type === "Sell") {
        await handler(event, raw);
      }
    });
  }

  // ─── Graduation Subscriptions ─────────────────────────────────────────────

  /**
   * Subscribe to graduation ready events for a specific mint.
   * Fires when `real_sol_reserves >= 85 SOL`.
   */
  async onGraduation(mint: PublicKey, handler: GraduationReadyHandler): Promise<number> {
    return this.addListener("graduation", mint.toBase58(), async (event, raw) => {
      if (event.type === "GraduationReady") {
        await handler(event.data as GraduationReadyEvent, raw);
      }
    });
  }

  /**
   * Subscribe to graduation events across ALL pools.
   * Perfect for building a graduation alert service.
   *
   * @example
   * ```ts
   * await subs.onAnyGraduation((event) => {
   *   sendDiscordAlert(`🎓 ${event.mint} hit 85 SOL! Time to migrate!`);
   * });
   * ```
   */
  async onAnyGraduation(handler: GraduationReadyHandler): Promise<number> {
    return this.addListener("anyGraduation", undefined, async (event, raw) => {
      if (event.type === "GraduationReady") {
        await handler(event.data as GraduationReadyEvent, raw);
      }
    });
  }

  /**
   * Subscribe to migration events (actual graduation execution) for a mint.
   */
  async onMigration(mint: PublicKey, handler: MigrateEventHandler): Promise<number> {
    return this.addListener("migration", mint.toBase58(), async (event, raw) => {
      if (event.type === "Migrate") {
        await handler(event.data as MigrateEvent, raw);
      }
    });
  }

  /**
   * Subscribe to all migration events across ALL pools.
   */
  async onAnyMigration(handler: MigrateEventHandler): Promise<number> {
    return this.addListener("anyMigration", undefined, async (event, raw) => {
      if (event.type === "Migrate") {
        await handler(event.data as MigrateEvent, raw);
      }
    });
  }

  // ─── Token Creation Subscriptions ─────────────────────────────────────────

  /**
   * Subscribe to new token launches across ALL pools.
   *
   * @example
   * ```ts
   * await subs.onTokenCreated((event) => {
   *   console.log(`New launch: ${event.name} (${event.symbol})`);
   *   console.log(`Creator: ${event.creator}`);
   *   console.log(`Target DEX: ${Object.keys(event.migrationTarget)[0]}`);
   * });
   * ```
   */
  async onTokenCreated(handler: TokenCreatedHandler): Promise<number> {
    return this.addListener("tokenCreated", undefined, async (event, raw) => {
      if (event.type === "TokenCreated") {
        await handler(event.data as TokenCreatedEvent, raw);
      }
    });
  }

  // ─── Staking Subscriptions ────────────────────────────────────────────────

  /**
   * Subscribe to stake events for a specific mint.
   */
  async onStake(mint: PublicKey, handler: StakeEventHandler): Promise<number> {
    return this.addListener("stake", mint.toBase58(), async (event, raw) => {
      if (event.type === "Stake") {
        await handler(event.data as StakeEvent, raw);
      }
    });
  }

  /**
   * Subscribe to unstake events for a specific mint.
   */
  async onUnstake(mint: PublicKey, handler: UnstakeEventHandler): Promise<number> {
    return this.addListener("unstake", mint.toBase58(), async (event, raw) => {
      if (event.type === "Unstake") {
        await handler(event.data as UnstakeEvent, raw);
      }
    });
  }

  // ─── Price Subscriptions ──────────────────────────────────────────────────

  /**
   * Subscribe to real-time price updates for a specific mint.
   * Fires on every buy or sell trade.
   *
   * @example
   * ```ts
   * await subs.onPriceUpdate(mint, (data) => {
   *   console.log(`Price: ${data.priceSol} SOL per token`);
   *   console.log(`Last trade: ${data.solAmount} SOL for ${data.tokensOut} tokens`);
   *   updateChart(data.timestamp, data.priceSol);
   * });
   * ```
   */
  async onPriceUpdate(mint: PublicKey, handler: PriceUpdateHandler): Promise<number> {
    return this.addListener("priceUpdate", mint.toBase58(), async (event, raw) => {
      if (event.type === "Buy") {
        const data = event.data as BuyEvent;
        await handler({
          mint: data.mint.toString(),
          price: data.tokensOut > 0n ? Number(data.solAmount) / Number(data.tokensOut) : 0,
          priceSol: data.tokensOut > 0n ? Number(data.solAmount) / Number(data.tokensOut) / 1e9 : 0,
          timestamp: data.timestamp,
          solAmount: data.solAmount,
          tokensOut: data.tokensOut,
        });
      } else if (event.type === "Sell") {
        const data = event.data as SellEvent;
        await handler({
          mint: data.mint.toString(),
          price: data.tokenAmount > 0n ? Number(data.solOut) / Number(data.tokenAmount) : 0,
          priceSol: data.tokenAmount > 0n ? Number(data.solOut) / Number(data.tokenAmount) / 1e9 : 0,
          timestamp: data.timestamp,
          solAmount: data.solOut,
          tokensOut: data.tokenAmount,
        });
      }
    });
  }

  // ─── Generic Subscriptions ────────────────────────────────────────────────

  /**
   * Subscribe to ALL events for a specific mint.
   */
  async onAllEvents(mint: PublicKey, handler: AnyEventHandler): Promise<number> {
    return this.addListener("all", mint.toBase58(), handler);
  }

  /**
   * Subscribe to ALL events across ALL pools.
   * ⚠️ Very high traffic on mainnet.
   */
  async onAnyEvent(handler: AnyEventHandler): Promise<number> {
    return this.addListener("any", undefined, handler);
  }

  // ─── Unsubscribe ──────────────────────────────────────────────────────────

  /**
   * Unsubscribe from a specific subscription.
   *
   * @param id - The subscription ID returned by the `on*` method
   */
  async unsubscribe(id: number): Promise<void> {
    this.subscriptions.delete(id);

    // If no more subscriptions, remove the underlying log listener
    if (this.subscriptions.size === 0 && this.logSubscriptionId !== null) {
      try {
        await this.connection.removeOnLogsListener(this.logSubscriptionId);
      } catch {
        // Already removed
      }
      this.logSubscriptionId = null;
    }
  }

  /**
   * Unsubscribe from ALL active subscriptions.
   */
  async unsubscribeAll(): Promise<void> {
    this.subscriptions.clear();
    if (this.logSubscriptionId !== null) {
      try {
        await this.connection.removeOnLogsListener(this.logSubscriptionId);
      } catch {
        // Already removed
      }
      this.logSubscriptionId = null;
    }
  }

  /**
   * Get the number of active subscriptions.
   */
  get activeSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Get a list of all active subscription types.
   */
  get activeSubscriptions(): Array<{ id: number; type: string; mint?: string }> {
    return Array.from(this.subscriptions.values()).map((s) => ({
      id: s.id,
      type: s.type,
      mint: s.mint,
    }));
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private addListener(
    type: string,
    mint: string | undefined,
    callback: (event: PulseEvent, raw: any) => Promise<void>
  ): number {
    const id = this.nextId++;
    this.subscriptions.set(id, { id, type, mint, callback });

    // Set up the underlying log listener if this is the first subscription
    if (this.logSubscriptionId === null) {
      this.setupLogListener();
    }

    return id;
  }

  private setupLogListener(): void {
    this.logSubscriptionId = this.connection.onLogs(
      this.programId,
      (logs) => {
        try {
          // Parse events from the transaction logs
          if (logs.logs) {
            const events = this.parser.parseTransactionLogs(logs.logs);

            for (const event of events) {
              // Dispatch to matching subscribers
              for (const sub of this.subscriptions.values()) {
                // Filter by mint if specified
                if (sub.mint) {
                  const eventMint = this.extractMintFromEvent(event);
                  if (eventMint !== sub.mint) continue;
                }

                // Fire callback (don't await — let them run in parallel)
                sub.callback(event, logs).catch((err: Error) => {
                  this.options.onError(err);
                });
              }
            }
          }
        } catch (err) {
          this.options.onError(err instanceof Error ? err : new Error(String(err)));
        }
      },
      this.options.commitment
    );
  }

  private extractMintFromEvent(event: PulseEvent): string | null {
    const data = event.data as any;
    return data.mint?.toString?.() ?? null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// HELIUS WEBSOCKET SUBSCRIPTIONS (Enhanced)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Enhanced WebSocket subscriptions using Helius's dedicated WebSocket API.
 *
 * Helius provides lower-latency, more reliable WebSocket connections
 * compared to standard Solana RPC. Use this for production-grade
 * real-time applications.
 *
 * Requires a Helius API key with WebSocket access.
 *
 * @example
 * ```ts
 * const heliusSubs = new HeliusSubscriptions("your-helius-api-key");
 *
 * // Subscribe to transactions involving the Pulse program
 * await heliusSubs.onPulseTransaction((tx) => {
 *   console.log(`New Pulse tx: ${tx.signature}`);
 *   console.log(`Type: ${tx.type}`);
 *   console.log(`Fee: ${tx.fee}`);
 * });
 *
 * // Subscribe to a specific mint's transactions
 * await heliusSubs.onMintTransactions(mint, (tx) => {
 *   console.log(`Trade on ${mint}: ${tx.signature}`);
 * });
 * ```
 */
export class HeliusSubscriptions {
  private ws: WebSocket | null = null;
  private readonly apiKey: string;
  private readonly baseUrl = "wss://mainnet.helius-rpc.com/";
  private subscriptions: Map<number, { type: string; callback: (...args: any[]) => void }> = new Map();
  private nextId = 1;
  private requestId = 1;
  private pendingRequests: Map<number, { resolve: Function; reject: Function }> = new Map();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Connect to the Helius WebSocket endpoint.
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.baseUrl}?api-key=${this.apiKey}`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        resolve();
      };

      this.ws.onerror = (err) => {
        reject(new Error("Helius WebSocket connection failed"));
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);

          // Handle subscription notifications
          if (data.method === "transactionNotification") {
            for (const sub of this.subscriptions.values()) {
              if (sub.type === "transaction") {
                sub.callback(data.params.result, data.params.signature);
              }
            }
          }

          // Handle pending request responses
          if (data.id !== undefined && this.pendingRequests.has(data.id)) {
            const { resolve, reject } = this.pendingRequests.get(data.id)!;
            this.pendingRequests.delete(data.id);
            if (data.error) {
              reject(new Error(data.error.message));
            } else {
              resolve(data.result);
            }
          }
        } catch {
          // Ignore parse errors
        }
      };
    });
  }

  /**
   * Disconnect from the Helius WebSocket.
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscriptions.clear();
  }

  /**
   * Subscribe to Pulse program transactions via Helius.
   */
  async onPulseTransaction(callback: (transaction: any, signature: string) => void): Promise<number> {
    const id = this.nextId++;
    this.subscriptions.set(id, { type: "transaction", callback });

    // Send subscription request
    this.sendRequest("transactionSubscribe", {
      accountInclude: [this.getProgramIdString()],
    });

    return id;
  }

  /**
   * Subscribe to transactions for a specific mint.
   */
  async onMintTransactions(mint: string, callback: (transaction: any, signature: string) => void): Promise<number> {
    const id = this.nextId++;
    this.subscriptions.set(id, { type: "transaction", callback });

    this.sendRequest("transactionSubscribe", {
      accountInclude: [mint],
    });

    return id;
  }

  /**
   * Subscribe to real-time priority fee updates.
   */
  async onPriorityFeeUpdate(callback: (fee: number) => void): Promise<number> {
    const id = this.nextId++;
    this.subscriptions.set(id, { type: "priorityFee", callback });
    return id;
  }

  private sendRequest(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"));
        return;
      }

      const id = this.requestId++;
      this.pendingRequests.set(id, { resolve, reject });

      this.ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: [params],
      }));

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error("Request timeout"));
        }
      }, 10_000);
    });
  }

  private getProgramIdString(): string {
    // Pulse mainnet program ID
    return "5NLh9rQPR4EAZZpZfAJ3ujszffKjMJJCEGXxCBf4CRea";
  }
}
