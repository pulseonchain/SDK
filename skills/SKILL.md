# Pulse Bonding Curve — Agent Skill

Use this skill when the user needs to interact with the Pulse bonding curve
protocol on Solana. Pulse uses an Anchor-based program that lets creators
launch tokens via a constant-product bonding curve and graduate them to DEXes
(Raydium, Meteora, PumpSwap).

## When to use this skill

Trigger on any request involving:
- Buying or selling tokens on Pulse
- Creating / launching a new token on the bonding curve
- Checking prices, quotes, or graduation status
- Staking tokens or claiming rewards for Meteora pools
- Checking if a token is ready to migrate to a DEX
- Explaining how the Pulse protocol works

## Program Info

| Network  | Program ID                                                    |
|----------|---------------------------------------------------------------|
| Devnet   | `SOON`              |
| Localnet | `5NLh9rQPR4EAZZpZfAJ3ujszffKjMJJCEGXxCBf4CRea`              |
| Mainnet  | TBD (same as localnet until mainnet deployment)                |

SDK: `@pulseonchain/sdk` — https://github.com/pulseonchain/sdk

## Key Concepts

### Bonding Curve

Pulse uses a **constant-product AMM** with virtual reserves:
- **Formula**: `price = virtual_sol / virtual_tokens`
- **Initial virtual SOL**: 30 SOL (30,000,000,000 lamports)
- **Initial virtual tokens**: ~1.073B
- **Trading supply**: 700M tokens (drawn down on buys)
- **Reserve supply**: 97M tokens (only used for large buys near graduation)
- **LP supply**: 300M tokens (seeded to DEX at graduation)

### Graduation

When a pool accumulates ≥ 85 SOL, anyone can call `migrate()`:
1. 300M LP tokens → DEX pool
2. Remaining tokens split 50/50: half burned, half to migration vault
3. All SOL → DEX pool
4. Pool marked `graduated = true`

### Fee Structure

Every trade: **1% fee** on SOL volume
- 0.75% → platform treasury (immediate)
- 0.25% → creator fee_recipient PDA (claimable)

Post-graduation LP fees: same 0.75/0.25 split + configurable staker share for Meteora.

### Migration Targets

- `RaydiumCpmm` — Raydium CPMM pool
- `MeteoraDammV1` — Meteora Dynamic AMM v1 (with fee sharing)
- `MeteoraDlmm` — Meteora Dynamic LMM (with fee sharing)
- `PumpSwapBurn` — PumpSwap (LP tokens burned)
- `PumpSwapHoldLp` — PumpSwap (LP tokens held for fee claiming)

## PDA Derivation

All accounts are deterministic PDAs:

| Account | Seeds |
|---------|-------|
| GlobalConfig | `["global_config"]` |
| PoolState | `["pool_state", mint]` |
| FeeVault | `["fee_vault", mint]` |
| FeeRecipient | `["fee_recipient", mint]` |
| PoolTokenAccount | `["pool_tokens", mint]` |
| LpReserveAccount | `["lp_reserve", mint]` |
| MigrationVault | `["migration_vault", mint]` |
| MigrationConfig | `["migration_config", mint]` |
| StakerVault | `["staker_vault", mint]` |
| StakeAccount | `["stake", mint, user]` |
| StakeTokenVault | `["stake_token_vault", mint]` |

## Instructions Summary

### Trading
- `buy(sol_amount, min_tokens_out)` — Buy tokens with SOL
- `sell(token_amount, min_sol_out)` — Sell tokens for SOL

### Token Creation (4 steps)
1. `create_token(name, symbol, uri, migration_target)` — Mint + metadata + PoolState
2. `create_token_accounts()` — Pool token account + LP reserve
3. `create_staker_vault()` — Staker vault + fee vaults + MigrationConfig
4. `initialize_pool(initial_sol_deposit)` — Mint 700M+97M+300M, revoke authority, deposit SOL

### Graduation
- `migrate()` — Permissionless. Sends LP tokens + SOL to DEX.

### Creator
- `claim_fees()` — Withdraw creator's 0.25% fee share
- `transfer_authority(new_authority)` — Transfer creator rights permanently
- `claim_migration_vault()` — Claim post-graduation tokens

### Staking (Meteora)
- `stake(amount)` — Stake tokens for fee share
- `unstake(amount)` — Unstake tokens
- `claim_staker_rewards()` — Claim SOL rewards

### Post-Graduation
- `claim_lp_fees()` — Permissionless crank. Claims LP fees from DEX.

## SDK Usage

```typescript
import { Pulse, PulsePDA } from "@pulseonchain/sdk";

// Initialize
const pulse = Pulse.devnet();

// Derive PDAs
const pdas = PulsePDA.derived(mint);

// Simulate a buy
const quote = await pulse.simulateBuy(mint, BigInt(1_000_000_000));
console.log(`Tokens out: ${quote.tokensOut}`);
console.log(`Price impact: ${quote.priceImpact}%`);

// Check graduation
const ready = await pulse.isReadyToGraduate(mint);
const progress = await pulse.graduationProgress(mint);

// Fetch pool state
const pool = await pulse.fetchPool(mint);
console.log(`Virtual SOL: ${pool.virtualSolReserves}`);
console.log(`Real SOL: ${pool.realSolReserves}`);
console.log(`Graduated: ${pool.graduated}`);
```

## Enhanced Provider Features

### Helius (pass `heliusApiKey`)
- `pulse.searchTokens({ query })` — Search tokens with enriched metadata
- `pulse.getAsset(mint)` — Get token metadata via DAS API
- `pulse.getWalletTokens(address)` — Get all tokens with metadata

### Alchemy (pass `alchemyApiKey`)
- `pulse.getTokenBalances(address)` — Get SPL token balances with metadata
- `pulse.getAssetTransfers(address)` — Get transfer history
- `pulse.getTokenMetadata(mint)` — Get token metadata

### Combined (both keys)
- `pulse.getPortfolio(address)` — Full portfolio with on-chain + off-chain data
- `pulse.getTokenProfile(mint)` — Complete token profile with price, metadata, transfers

## Error Codes

| Code | Meaning |
|------|---------|
| `Paused` | Program is paused |
| `Unauthorized` | Wrong signer |
| `AlreadyGraduated` | Token already migrated |
| `NotReadyToGraduate` | < 85 SOL raised |
| `SlippageExceeded` | Output below minimum |
| `InsufficientPoolTokens` | Buy too large |
| `InsufficientPoolSol` | Sell exceeds pool SOL |
| `BelowMinReserve` | Creator fees below 0.005 SOL minimum |
| `MathOverflow` | Arithmetic overflow |

## Links

- SDK: https://github.com/pulseonchain/sdk
- Docs: https://docs.pulseonchain.com (coming soon)
