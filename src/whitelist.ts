/**
 * @module whitelist
 *
 * Whitelist / presale phase helpers for the Pulse bonding curve.
 *
 * The whitelist system uses a Merkle tree to allow creators to gate early
 * buying to specific wallets — OG holders, Discord roles, NFT holders, etc.
 * This module provides everything needed to:
 *
 *   1. Build a Merkle tree from a list of wallet addresses
 *   2. Generate and verify Merkle proofs for individual wallets
 *   3. Encode proofs for on-chain submission
 *   4. Build the createWhitelistConfig transaction
 *   5. Build the whitelist_buy transaction with proof
 *
 * The Merkle tree implementation matches the Rust verify_merkle_proof() function
 * exactly (sorted-pair hashing with SHA-256).
 *
 * @example
 * ```ts
 * import { WhitelistHelper } from "@pulseonchain/sdk/whitelist";
 *
 * // Build the tree from your allowlist
 * const tree = WhitelistHelper.buildTree([
 *   "7uN3TJJHzA...",
 *   "9Xf2ZBkL...",
 *   // ... more wallets
 * ]);
 *
 * // Get proof for a specific wallet
 * const proof = WhitelistHelper.getProof(tree, "7uN3TJJHzA...");
 *
 * // Verify a proof (same logic as the on-chain program)
 * const valid = WhitelistHelper.verifyProof(tree.root, "7uN3TJJHzA...", proof);
 *
 * // Submit whitelist buy with proof
 * await pulse.whitelistBuy(wallet, {
 *   mint,
 *   solAmount: BigInt(500_000_000),
 *   minTokensOut: 0n,
 *   merkleProof: proof,
 * });
 * ```
 */

import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";

// ─── Merkle Tree ──────────────────────────────────────────────────────────────

export interface MerkleTree {
  /** The Merkle root as a 32-byte Uint8Array */
  root: Uint8Array;
  /** Root as a hex string (for display / storage) */
  rootHex: string;
  /** All leaves (hashed wallet addresses), sorted */
  leaves: Uint8Array[];
  /** All tree layers (layers[0] = leaves, layers[last] = root) */
  layers: Uint8Array[][];
  /** The original wallet list */
  wallets: string[];
}

export interface MerkleProof {
  /** Array of 32-byte sibling nodes */
  proof: Uint8Array[];
  /** The leaf for this wallet */
  leaf: Uint8Array;
  /** Leaf index in the sorted leaves array */
  leafIndex: number;
}

/** Hash a wallet address using SHA-256 (matches the on-chain keccak/sha256). */
function hashLeaf(wallet: string): Uint8Array {
  const pubkey = new PublicKey(wallet);
  return new Uint8Array(
    createHash("sha256").update(pubkey.toBuffer()).digest()
  );
}

/** Hash two sorted nodes together (matches the on-chain sorted-pair approach). */
function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [left, right] = bufferCompare(a, b) <= 0 ? [a, b] : [b, a];
  const combined = Buffer.concat([left, right]);
  return new Uint8Array(createHash("sha256").update(combined).digest());
}

function bufferCompare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export const WhitelistHelper = {
  /**
   * Build a Merkle tree from a list of wallet addresses.
   *
   * The tree uses sorted-pair SHA-256 hashing — same as the on-chain verifier.
   * Duplicate wallets are silently deduplicated.
   *
   * @param wallets - Array of base58 wallet addresses
   */
  buildTree(wallets: string[]): MerkleTree {
    // Deduplicate
    const unique = [...new Set(wallets)];
    if (unique.length === 0) {
      throw new Error("Cannot build a Merkle tree with 0 wallets");
    }

    // Hash all leaves and sort them
    const leaves = unique.map(hashLeaf);
    leaves.sort(bufferCompare);

    // Build layers bottom-up
    const layers: Uint8Array[][] = [leaves];
    let current = leaves;

    while (current.length > 1) {
      const next: Uint8Array[] = [];
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          next.push(hashPair(current[i], current[i + 1]));
        } else {
          // Odd node: promote it directly
          next.push(current[i]);
        }
      }
      layers.push(next);
      current = next;
    }

    const root = current[0];
    return {
      root,
      rootHex: Buffer.from(root).toString("hex"),
      leaves,
      layers,
      wallets: unique,
    };
  },

  /**
   * Get the Merkle proof for a specific wallet address.
   * Returns null if the wallet is not in the tree.
   *
   * @param tree - The Merkle tree built with buildTree()
   * @param wallet - The wallet address to get the proof for
   */
  getProof(tree: MerkleTree, wallet: string): MerkleProof | null {
    const leaf = hashLeaf(wallet);
    const leafIndex = tree.leaves.findIndex(l => bufferCompare(l, leaf) === 0);

    if (leafIndex === -1) return null;

    const proof: Uint8Array[] = [];
    let index = leafIndex;

    for (let layerIdx = 0; layerIdx < tree.layers.length - 1; layerIdx++) {
      const layer = tree.layers[layerIdx];
      const sibling = index % 2 === 0 ? index + 1 : index - 1;
      if (sibling < layer.length) {
        proof.push(layer[sibling]);
      }
      index = Math.floor(index / 2);
    }

    return { proof, leaf, leafIndex };
  },

  /**
   * Verify a Merkle proof for a wallet against a root.
   * This is the TypeScript equivalent of the on-chain verify_merkle_proof().
   *
   * Use this client-side to validate proofs before submitting.
   */
  verifyProof(root: Uint8Array, wallet: string, proof: Uint8Array[]): boolean {
    let current = hashLeaf(wallet);
    for (const sibling of proof) {
      current = hashPair(current, sibling);
    }
    return bufferCompare(current, root) === 0;
  },

  /**
   * Encode a proof as an array of 32-byte arrays for on-chain submission.
   *
   * The on-chain instruction expects `Vec<[u8; 32]>` which in the SDK
   * becomes an array of Buffer/Uint8Array of length 32.
   */
  encodeProofForChain(proof: Uint8Array[]): number[][] {
    return proof.map(node => Array.from(node));
  },

  /**
   * Encode the Merkle root as a 32-byte array for the WhitelistConfig PDA.
   */
  encodeRootForChain(root: Uint8Array): number[] {
    return Array.from(root);
  },

  /**
   * Check whether a wallet is on the whitelist.
   *
   * @param wallets - The whitelist wallet array (same as passed to buildTree)
   * @param wallet  - The wallet to check
   */
  isWhitelisted(wallets: string[], wallet: string): boolean {
    const normalized = wallet.trim();
    return wallets.some(w => w === normalized);
  },

  /**
   * Generate a summary of the Merkle tree for logging / verification.
   */
  summary(tree: MerkleTree): string {
    return [
      `Merkle Tree Summary`,
      `─────────────────────────────────`,
      `Wallets:    ${tree.wallets.length}`,
      `Depth:      ${tree.layers.length - 1}`,
      `Root:       ${tree.rootHex}`,
      `First leaf: ${tree.wallets[0]}`,
      `Last leaf:  ${tree.wallets[tree.wallets.length - 1]}`,
    ].join("\n");
  },
};
