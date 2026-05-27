<div align="center">

# 🫀 Pulse SDK

**The official SDK for the Pulse Bonding Curve Protocol on Solana**

[![npm](https://img.shields.io/npm/v/@pulseonchain/sdk?color=8B5CF6&logo=npm)](https://www.npmjs.com/package/@pulseonchain/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-8B5CF6)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript)](https://www.typescriptlang.org/)

[![GitHub](https://img.shields.io/badge/GitHub-pulseonchain%2Fsdk-181717?logo=github)](https://github.com/pulseonchain/sdk)

</div>

---

## What is Pulse?

Pulse is a cross-chain bonding curve protocol built on Solana (Anchor framework). Any creator can launch a token, run it through a **constant-product bonding curve**, and graduate it to multiple DEX launchpads — Raydium, Meteora, PumpSwap — not just one.

This is the **official SDK** to interact with Pulse, starting from **devnet** and expanding to **mainnet** at launch.

```
Creator launches ──► CP curve trades ──► 85 SOL raised
                                           │
                              ┌────────────┼────────────┐
                              ▼            ▼            ▼
                          Raydium       Meteora     PumpSwap
                           CPMM        DAMM/DLMM    Burn/Hold
```

---

## Install

```bash
npm install @pulseonchain/sdk
# or
yarn add @pulseonchain/sdk
# or
pnpm add @pulseonchain/sdk
```

### Peer dependencies (if not already in your project)

```bash
npm install @solana/web3.js
```

---

## Quick Start

```typescript
import { Pulse, PulsePDA } from "@pulseonchain/sdk";
import { PublicKey } from "@solana/web3.js";

// ─── Connect ──────────────────────────────────────────────────────────
const pulse = Pulse.devnet();
// const pulse = Pulse.mainnet();
// const pulse = Pulse.localnet();

// ─── Derive PDAs for any mint ────────────────────────────────────────
const mint = new PublicKey("YOUR_MINT_ADDRESS");
const pdas = PulsePDA.derived(mint);
console.log("Pool State:", pdas.poolState.toBase58());
console.log("Fee Vault:", pdas.feeVault.toBase58());

// ─── Simulate a trade before submitting ──────────────────────────────
const quote = await pulse.simulateBuy(mint, BigInt(1_000_000_000)); // 1 SOL
console.log(`Receive: ${quote.tokensOut} tokens`);
console.log(`Price impact: ${quote.priceImpact}%`);
console.log(`Fees: ${quote.platformFee + quote.creatorFee} lamports`);

// ─── Execute a buy ──────────────────────────────────────────────────
await pulse.buy(wallet, {
  mint,
  solAmount: BigInt(1_000_000_000),       // 1 SOL
  minTokensOut: quote.tokensOut * 99n / 100n,  // 1% slippage tolerance
});

// ─── Check graduation progress ──────────────────────────────────────
const progress = await pulse.graduationProgress(mint); // 0-100
const ready = await pulse.isReadyToGraduate(mint);
if (ready) {
  console.log("🎓 This token is ready to graduate to a DEX!");
}
```

---

## 10 Cool Things You Can Do

Here are the highlights. Each one is a unique way to build on or interact with
the Pulse protocol.

### 1. 🔄 Simulate Trades Before Submitting

Get a full quote — tokens out, price impact, fees — without spending a single
lamport. The math runs locally against the on-chain pool state, so it's an
exact match for what the program will compute.

```typescript
const buyQuote = await pulse.simulateBuy(mint, BigInt(500_000_000));
console.log(`
  Tokens out:    ${buyQuote.tokensOut}
  Price/token:   ${buyQuote.pricePerToken}
  Price impact:  ${buyQuote.priceImpact}%
  Platform fee:  ${buyQuote.platformFee}
  Creator fee:   ${buyQuote.creatorFee}
  Net SOL:       ${buyQuote.netSol}
`);

const sellQuote = await pulse.simulateSell(mint, BigInt(1_000_000));
console.log(`SOL back: ${sellQuote.netSolToUser}`);
```

### 2. 📈 Track Graduation Progress in Real-Time

Every bonding curve token graduates when it hits 85 SOL. Build a progress bar,
send alerts, or trigger auto-buys when a token gets close.

```typescript
const pool = await pulse.fetchPool(mint);
const progress = graduationProgress(pool);             // 0-100
const remaining = solToGraduation(pool);              // SOL needed
const price = getSpotPriceSol(pool);                  // current price

console.log(`${progress.toFixed(1)}% to graduation`);
console.log(`${lamportsToSol(remaining)} SOL remaining`);
console.log(`Current price: ${price} SOL per token`);
```

### 3. 🔍 Derive Every PDA for Any Mint

Every on-chain account in Pulse is a deterministic PDA. One call gives you all
11 PDAs: pool state, fee vault, fee recipient, LP reserve, migration vault,
staker vault, stake token vault, and more.

```typescript
const pdas = PulsePDA.derived(mint);
console.log(pdas.poolState);         // PoolState PDA
console.log(pdas.feeVault);          // Holds bonding curve SOL
console.log(pdas.feeRecipient);      // Creator's claimable fees
console.log(pdas.migrationVault);    // Post-graduation claim vault
console.log(pdas.stakerVault);       // Staking reward tracker

// User-specific PDA
const stakeAccount = PulsePDA.stakeAccount(mint, userPubkey);
// Migration vault ATA
const mvATA = PulsePDA.migrationVaultATA(mint);
```

### 4. 💰 Quote Staker Rewards for Any User

For Meteora migration targets, token stakers earn a share of post-graduation LP
fees. Calculate pending rewards off-chain without sending a transaction.

```typescript
const pending = await pulse.pendingStakerRewards(mint, userPubkey);
console.log(`Pending rewards: ${lamportsToSol(pending)} SOL`);

// Or compute it locally with full pool + vault state:
const pool = await pulse.fetchPool(mint);
const stakerVault = await pulse.fetchStakerVault(mint);
const stakeAccount = await pulse.fetchStakeAccount(mint, userPubkey);
const rewards = pendingStakerRewards(
  stakerVault.accumulatedRewardPerToken,
  stakeAccount.rewardDebt,
  stakeAccount.amountStaked
);
```

### 5. 🏗️ Build the Full Token Creation Flow

The SDK scaffolds all 4 steps of token creation. Use this to build launchpads,
no-code token creators, or programmatic token generation pipelines.

```typescript
const txs = pulse.buildCreateTokenTransactions(
  creator.publicKey,
  mint.publicKey,
  {
    name: "My Token",
    symbol: "MYTKN",
    uri: "https://arweave.net/metadata.json",
    migrationTarget: { raydiumCpmm: {} },
    initialSolDeposit: BigInt(50_000_000), // 0.05 SOL
  },
  RAYDIUM_CPMM_PROGRAM_ID,
  dexPool.publicKey,
  dexTokenAccount.publicKey,
  feeRecipient.publicKey
);
// Submit each transaction sequentially
for (const tx of txs) {
  await connection.sendTransaction(tx, [creator, mint]);
}
```

### 6. 🎓 Trigger Migration (Permissionless)

Anyone can graduate a token once it hits 85 SOL. Build a crank service that
monitors all pools and calls `migrate()` the instant they're eligible.

```typescript
// Crank service example
setInterval(async () => {
  const pools = await pulse.fetchAllPools();
  for (const pool of pools) {
    if (isReadyToGraduate(pool) && !pool.graduated) {
      console.log(`Migrating ${pool.mint}...`);
      const sig = await pulse.migrate(crankWallet, pool.mint);
      console.log(`Migrated! tx: ${sig}`);
    }
  }
}, 10_000);
```

---

### 7. ⚡ Helius-Exclusive: Search & Enrich Token Data

Pass a Helius API key to unlock the **Digital Asset Standard (DAS) API** —
enriched metadata, images, collection grouping, and fast token search. Standard
RPC simply cannot do this.

```typescript
const pulse = Pulse.devnet({ heliusApiKey: "your-helius-key" });

// Search tokens by name or symbol
const results = await pulse.searchTokens({ query: "pulse", limit: 10 });
for (const token of results.items) {
  console.log(`${token.content.metadata.name} (${token.content.metadata.symbol})`);
  console.log(`Image: ${token.content.links?.image}`);
  console.log(`Supply: ${token.token_info?.supply}`);
}

// Get enriched data for a single mint
const asset = await pulse.getAsset(mint.toBase58());
console.log(asset.content.metadata.name);

// Get all tokens in a wallt with metadata inline
const walletTokens = await pulse.getWalletTokens(walletAddress);
for (const t of walletTokens) {
  console.log(`${t.token_info?.price_info?.price_per_token} SOL — ${t.content.metadata.name}`);
}
```

> **Why Helius?** The DAS API is the fastest way to get token metadata on Solana.
> No need to parse on-chain Metaplex accounts yourself. One call returns name,
> symbol, image, and supply.

---

### 8. 🔮 Alchemy-Exclusive: Wallet Analytics & Token Balances

Pass an Alchemy API key to unlock **wallet-level token analytics** — accurate SPL
token balances with metadata, transfer history, and token logos. Alchemy's
Solana support fills gaps that standard RPC can't.

```typescript
const pulse = Pulse.mainnet({ alchemyApiKey: "your-alchemy-key" });

// Get all SPL token balances with metadata (name, symbol, decimals, logo)
const balances = await pulse.getTokenBalances(walletAddress);
for (const b of balances) {
  console.log(`
    Token:   ${b.tokenMetadata?.name} (${b.tokenMetadata?.symbol})
    Balance: ${b.tokenBalance}
    Logo:    ${b.tokenMetadata?.logo}
  `);
}

// Get transfer history (the most reliable way on Solana)
const transfers = await pulse.getAssetTransfers(walletAddress, {
  category: ["spl"],
  limit: 50,
});
for (const t of transfers) {
  console.log(`${t.hash}: ${t.value} ${t.asset} → ${t.to}`);
}

// Get token metadata in a single call
const meta = await pulse.getTokenMetadata(mint.toBase58());
console.log(`${meta.name} — ${meta.symbol} (${meta.decimals} decimals)`);
```

> **Why Alchemy?** Standard RPC's `getTokenAccountsByOwner` returns raw account
> data. Alchemy parses it and returns names, symbols, logos, and decimals inline.
> Their `getAssetTransfers` is also the most reliable way to get SPL transfer
> history — no more parsing individual transaction logs.

---

### 9. 🤝 Combined (Alchemy + Helius): Full Portfolio Analysis

Pass **both** API keys for the ultimate portfolio analysis. This combines
Alchemy's accurate token balances, Helius's enriched metadata, and Pulse's
on-chain bonding curve positions into one unified view.

```typescript
const pulse = Pulse.mainnet({
  alchemyApiKey: "your-alchemy-key",
  heliusApiKey: "your-helius-key",
});

const portfolio = await pulse.getPortfolio(walletAddress);

console.log(`Total tokens: ${portfolio.tokens.length}`);
console.log(`Enriched tokens: ${portfolio.enrichedTokens.length}`);
console.log(`Pulse positions: ${portfolio.bondingPositions.length}`);

for (const pos of portfolio.bondingPositions) {
  console.log(`
    Token:    ${pos.mint}
    Balance:  ${pos.tokenBalance}
    Price:    ${getSpotPriceSol(pos.pool)} SOL
    Progress: ${graduationProgress(pos.pool).toFixed(1)}%
    Graduated: ${pos.pool.graduated}
  `);
}

// Get a complete token profile (price + metadata + transfers)
const profile = await pulse.getTokenProfile(mint.toBase58());
console.log(`Name:    ${profile.tokenMetadata?.name}`);
console.log(`Price:   ${profile.price} SOL`);
console.log(`Grad:    ${profile.graduationProgress.toFixed(1)}%`);
console.log(`History: ${profile.recentTransfers.length} recent transfers`);
```

> **Why both?** This is the "killer method" for building token dashboards.
> Alchemy gives you accurate wallet balances. Helius gives you rich metadata.
> Pulse gives you bonding curve state. Combined, you get everything in 2 API
> calls instead of dozens.

---

### 10. 🤖 Agent Skill: Give Your AI Agent Pulse Superpowers

The SDK ships with an **agent skill** (`skills/SKILL.md`) that AI agents can load
to interact with the Pulse protocol. Point your agent at it and it can:

- Execute buys and sell trades on Pulse
- Check graduation status and price quotes
- Explain the bonding curve math to users
- Create new tokens via the protocol
- Search for tokens using Helius

```bash
# Copy the skill to your agent's skills directory
cp node_modules/@pulseonchain/sdk/skills/SKILL.md \
   ~/.agents/skills/pulse-bonding-curve/SKILL.md
```

The skill includes the full program reference, PDA derivation guide, error codes,
and code examples. Any AI agent that reads the skill can operate on Pulse.

---

## Feature Matrix


> 💡 **Standard RPC** is free and works everywhere. Get a free Helius key at
> [helius.dev](https://helius.dev) and an Alchemy key at
> [alchemy.com](https://alchemy.com) for the enhanced features. Pass **both** keys
> to `Pulse.mainnet({ alchemyApiKey, heliusApiKey })` to unlock combined portfolio
> analytics via `getPortfolio()` and `getTokenProfile()`.

---

## Cluster Configuration

| Network | Program ID | Default RPC |
|---------|-----------|-------------|
| **Devnet** | `5q34BJ3g525q1nfS3cxrw6edrBidaz2RqcwBHRxKK33B` | `https://api.devnet.solana.com` |
| **Mainnet** | TBD (updating at launch) | `https://api.mainnet-beta.solana.com` |
| **Localnet** | `5NLh9rQPR4EAZZpZfAJ3ujszffKjMJJCEGXxCBf4CRea` | `http://127.0.0.1:8899` |

```typescript
// Devnet (current)
const pulse = Pulse.devnet();

// Mainnet (at launch)
const pulse = Pulse.mainnet();

// Localnet (testing)
const pulse = Pulse.localnet();

// Custom RPC
const pulse = Pulse.fromUrl("https://your-rpc.com");

// With enhanced providers
const pulse = Pulse.devnet({
  heliusApiKey: "your-helius-key",
  alchemyApiKey: "your-alchemy-key",
});
```

---

## Protocol Reference

### Token Supply

| Bucket | Amount | Purpose |
|--------|--------|---------|
| Bonding Supply | 700,000,000 | Sold via the bonding curve |
| Reserve Supply | 97,052,391 | Guarantees last-buyer fills near graduation |
| LP Reserve | 300,000,000 | Seeded to the DEX at graduation |
| **Total** | **~1.097B** | Fixed — mint authority revoked at pool init |

### Bonding Curve Formula

```
price = virtual_sol / virtual_tokens

On buy:  tokens_out = virtual_tokens × net_sol / (virtual_sol + net_sol)
On sell: sol_out     = virtual_sol × tokens_in / (virtual_tokens + tokens_in)
```

### Fee Structure

Every trade: **1% fee** on SOL volume
- **0.75%** → platform treasury (immediate)
- **0.25%** → creator fee_recipient PDA (claimable via `claim_fees()`)

### Graduation

When `real_sol_reserves >= 85 SOL`:
1. 300M LP tokens → DEX pool
2. Remaining tokens: 50% burned, 50% to migration vault
3. All SOL → DEX pool
4. Pool marked `graduated = true`

### Migration Targets

- `RaydiumCpmm` — Raydium CPMM pool
- `MeteoraDammV1` — Meteora Dynamic AMM v1 (with fee sharing)
- `MeteoraDlmm` — Meteora Dynamic LMM (with fee sharing)
- `PumpSwapBurn` — PumpSwap (LP tokens burned)
- `PumpSwapHoldLp` — PumpSwap (LP tokens held for fee claiming)

---

## API Reference

### Core Methods

| Method | Description |
|--------|-------------|
| `pulse.buy(wallet, params)` | Buy tokens with SOL |
| `pulse.sell(wallet, params)` | Sell tokens for SOL |
| `pulse.migrate(payer, mint)` | Graduate token to DEX (permissionless) |
| `pulse.claimFees(authority, mint)` | Creator claims fee share |
| `pulse.transferAuthority(auth, mint, newAuth)` | Transfer creator rights |
| `pulse.stake(wallet, params)` | Stake tokens for fee share |
| `pulse.unstake(wallet, params)` | Unstake tokens |
| `pulse.claimStakerRewards(wallet, mint)` | Claim staker SOL rewards |
| `pulse.claimMigrationVault(auth, mint)` | Claim post-graduation tokens |

### Quote / Simulation

| Method | Description |
|--------|-------------|
| `pulse.simulateBuy(mint, solAmount)` | Get a buy quote |
| `pulse.simulateSell(mint, tokenAmount)` | Get a sell quote |
| `pulse.getSpotPrice(mint)` | Current price in SOL |
| `pulse.isReadyToGraduate(mint)` | Check graduation eligibility |
| `pulse.solToGraduation(mint)` | SOL needed to graduate |
| `pulse.graduationProgress(mint)` | Progress 0-100% |
| `pulse.pendingStakerRewards(mint, user)` | Pending staker rewards |

### Fetch State

| Method | Description |
|--------|-------------|
| `pulse.fetchGlobalConfig()` | Fetch the global config |
| `pulse.fetchPool(mint)` | Fetch pool state by mint |
| `pulse.fetchStakeAccount(mint, user)` | Fetch user's stake account |
| `pulse.fetchStakerVault(mint)` | Fetch staker vault |
| `pulse.fetchAllPools()` | Fetch all pools (heavy query) |

### Helius-Exclusive

| Method | Description |
|--------|-------------|
| `pulse.searchTokens(params)` | Search tokens with enriched metadata |
| `pulse.getAsset(mint)` | Get enriched asset data via DAS |
| `pulse.getWalletTokens(address)` | Get wallet tokens with metadata |

### Alchemy-Exclusive

| Method | Description |
|--------|-------------|
| `pulse.getTokenBalances(address)` | Get SPL token balances with metadata |
| `pulse.getAssetTransfers(address, opts)` | Get transfer history |
| `pulse.getTokenMetadata(mint)` | Get token metadata |

### Combined (Alchemy + Helius)

| Method | Description |
|--------|-------------|
| `pulse.getPortfolio(address)` | Full portfolio with on-chain + off-chain data |
| `pulse.getTokenProfile(mint)` | Complete token profile |

### PDA Derivation

```typescript
import { PulsePDA } from "@pulseonchain/sdk";

const pdas = PulsePDA.derived(mint, programId?);
// pdas.globalConfig
// pdas.poolState
// pdas.feeVault
// pdas.feeRecipient
// pdas.poolTokenAccount
// pdas.lpReserveAccount
// pdas.stakeTokenVault
// pdas.migrationVault
// pdas.migrationConfig
// pdas.stakerVault

// User-specific
PulsePDA.stakeAccount(mint, user, programId?);
PulsePDA.associatedTokenAddress(owner, mint);
PulsePDA.migrationVaultATA(mint, programId?);
```

### Utility Functions

```typescript
import {
  calcFees,
  simulateBuy,
  simulateSell,
  getSpotPriceSol,
  isReadyToGraduate,
  solToGraduation,
  graduationProgress,
  validateMigrationTarget,
  lamportsToSol,
  solToLamports,
  formatTokenAmount,
  parseTokenAmount,
  pendingStakerRewards,
} from "@pulseonchain/sdk";
```

---

## Roadmap

- [x] Devnet SDK with full instruction coverage
- [x] Helius DAS API integration
- [x] Alchemy wallet analytics integration
- [x] Combined portfolio analysis
- [x] Agent skill for AI agents
- [ ] Mainnet deployment + program ID update
- [ ] React hooks (`@pulseonchain/sdk/react-hooks`)
- [ ] WebSocket event subscriptions for real-time trade monitoring
- [ ] IDL export for Anchor program clients
- [ ] Python SDK (`pulse-py`)

---

## Contributing

We welcome contributions! The SDK is open source under MIT.

```bash
git clone https://github.com/pulseonchain/sdk
cd sdk
npm install
npm run build
```

---

## License

MIT — [https://github.com/pulseonchain/sdk](https://github.com/pulseonchain/sdk)

---

<div align="center">

**Built with ❤️ by the Pulse Protocol team**

[GitHub](https://github.com/pulseonchain/sdk) · [NPM](https://www.npmjs.com/package/@pulseonchain/sdk) · [Docs](https://docs.pulseonchain.com)

</div>
