/**
 * Type surface for the `openzoo` npm package (plain ESM JS, no bundled
 * types). Only the members this plugin actually uses are declared — the
 * shim's own JSDoc is the real documentation.
 */

declare module 'openzoo/lib/config.js' {
  export const config: {
    apiBase: string;
    rpcUrl: string;
    token: string;
    rail: string | null;
    walletPath: string;
    [k: string]: unknown;
  };
  export const FUNDING_ASSETS: { symbol: string; mint: string }[];
  export function fundingLine(address: string): string;
}

declare module 'openzoo/lib/namespace.js' {
  export function withNamespace(
    headers?: Record<string, string>,
    wallet?: { keypair: import('@solana/web3.js').Keypair },
  ): Record<string, string>;
}

declare module 'openzoo/lib/x402.js' {
  import type { Connection, Keypair, PublicKey } from '@solana/web3.js';
  export function parse402(body: unknown): { accepts: any[] };
  export function orderAccepts(
    body: unknown,
    preferredSymbol: string,
    opts?: { allowRH?: boolean; forceRail?: string | null },
  ): any[];
  export function railOf(accept: unknown): string | null;
  export function paymentHeaders(header: string): Record<string, string>;
  export function buildPaymentOnline(connection: Connection, keypair: Keypair, accept: unknown): Promise<{ header: string }>;
  export function tokenBalance(connection: Connection, owner: PublicKey, mintStr: string): Promise<{ raw: bigint; ui: number | null }>;
  export function decodeSettleHeader(headerValue: string | null): unknown;
}

declare module 'openzoo/lib/pay.js' {
  export class PayClient {
    constructor();
    readonly address: string;
    readonly evmAddress: string | null;
    fetch(url: string, init?: RequestInit, opts?: { onStage?: (s: string) => void }): Promise<{ response: Response; paid: boolean; receipt?: any }>;
    chat(body: Record<string, unknown>, opts?: { onStage?: (s: string) => void; headers?: Record<string, string> }): Promise<{ data: any; receipt?: any }>;
  }
}

declare module 'openzoo/lib/bindpath.js' {
  export function collectFiles(root: string, opts?: { exts?: string[]; maxFiles?: number }): string[];
  export function splitIntoParts(text: string, maxBytes?: number): string[];
  export function bindPath(target: string, opts?: { exts?: string[]; force?: boolean; onProgress?: (p: any) => void }): Promise<{ contextId: string; files: string[]; parts: number; bytes: number; reused: boolean }>;
}

declare module 'openzoo/lib/wallet.js' {
  export function loadOrCreateWallet(): {
    keypair: import('@solana/web3.js').Keypair;
    evmPrivateKey: string | null;
    created: boolean;
    path: string;
  };
}
