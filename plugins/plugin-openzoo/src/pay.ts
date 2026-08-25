/**
 * How a model call gets paid, in order of preference:
 *
 *   1. GROUP CREDIT — the room's shared burner has prepaid gateway credit
 *      (namespace-keyed to the burner's keypair). Zero chain traffic per
 *      call: the gateway draws the balance down and returns 200.
 *   2. GROUP TOP-UP — the burner holds tokens but no credit: buy as much
 *      credit as the wallet covers in ONE x402 settlement (ported from
 *      xbot's ensureCredit), then retry. $45 of TOKEN becomes thousands of
 *      calls with no further on-chain hops.
 *   3. OPERATOR WALLET — no group burner in scope (DM, CLI, non-telegram
 *      room) or the group is broke: the agent's own machine wallet pays via
 *      openzoo's PayClient (subscription key or per-call x402). This is the
 *      self-sustaining lane — whatever the agent earns on Solana/Base lands
 *      in the same wallet that buys its inference.
 *
 * WHY AsyncLocalStorage: eliza model handlers receive (runtime, params) and
 * nothing about the room. The connector (telegram fork) wraps the whole
 * response pipeline in `runWithZooScope`, so every model call fired while
 * answering a group message settles against THAT group — without threading
 * a roomId through core.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Connection } from '@solana/web3.js';
// The shim IS the payment stack — imported, not reimplemented.
import { config } from 'openzoo/lib/config.js';
import { withNamespace } from 'openzoo/lib/namespace.js';
import {
  parse402,
  orderAccepts,
  buildPaymentOnline,
  paymentHeaders,
  tokenBalance,
  railOf,
} from 'openzoo/lib/x402.js';
import type { GroupBurner } from './burner';
import { receiptFrom, type ZooReceipt } from './receipt';

const GATEWAY: string = config.apiBase;

/** Below this credit balance, try to top up before the next call. */
const CREDIT_MIN_USD = Number(process.env.OPENZOO_ELIZA_CREDIT_MIN || 0.25);
const TOPUP_CAP_USD = Number(process.env.OPENZOO_ELIZA_TOPUP_CAP || 500);

export interface ZooScope {
  roomId: string;
  chatId?: string;         // raw telegram chat id — the wallet key
  burner?: GroupBurner;
}

const als = new AsyncLocalStorage<ZooScope>();

/** Wrap a response pipeline so model calls in it settle against this room. */
export function runWithZooScope<T>(scope: ZooScope, fn: () => Promise<T>): Promise<T> {
  return als.run(scope, fn);
}

export function currentZooScope(): ZooScope | undefined {
  return als.getStore();
}

export class GroupUnderfundedError extends Error {
  address: string;
  quotedUsd: number;
  constructor(address: string, quotedUsd: number) {
    super(`group burner underfunded (quoted up to $${quotedUsd || '?'})`);
    this.name = 'GroupUnderfundedError';
    this.address = address;
    this.quotedUsd = quotedUsd;
  }
}

let conn: Connection | null = null;
function connection(): Connection {
  if (!conn) conn = new Connection(config.rpcUrl, 'confirmed');
  return conn;
}

const ns = (burner: GroupBurner, headers: Record<string, string> = {}) =>
  withNamespace(headers, { keypair: burner.keypair });

/** Credit balance for a group burner's namespace. Errors read as zero. */
export async function groupCreditBalance(burner: GroupBurner): Promise<number> {
  try {
    const r = await fetch(`${GATEWAY}/v1/credits`, { headers: ns(burner) });
    const j: any = await r.json();
    return Number(j.balanceUsd ?? j.balance ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Settle ONE x402 payment with the GROUP's keypair. This deliberately does
 * not use PayClient: PayClient always signs with the operator's machine
 * wallet, and the entire point of a group burner is that the group's own
 * funds settle the group's own calls. Solana rails only for now — the
 * derived burner has an EVM key too, but nothing drives it yet.
 */
async function payWith402(burner: GroupBurner, url: string, init: RequestInit, quote: any): Promise<Response> {
  const candidates = orderAccepts(quote, config.token, {}).filter((a: any) => railOf(a) === 'solana');
  let lastErr: Error | null = null;
  for (const accept of candidates) {
    try {
      const built: any = await buildPaymentOnline(connection(), burner.keypair, accept);
      const headers = {
        ...(init.headers as Record<string, string> || {}),
        ...paymentHeaders(built.header),
      };
      const res = await fetch(url, { ...init, headers: ns(burner, headers) });
      if (res.status !== 402) return res;
      lastErr = new Error(`still 402 after paying ${accept?.extra?.symbol || accept?.asset}`);
    } catch (e: any) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no payable 402 row');
}

/**
 * Prepay the gateway the moment the group wallet can afford it — xbot's
 * ensureCredit, re-keyed to the group burner. One settlement buys thousands
 * of calls. Returns { balance, toppedUp }.
 */
export async function ensureGroupCredit(burner: GroupBurner): Promise<{ balance: number; toppedUp: number }> {
  const balance = await groupCreditBalance(burner);
  if (balance >= CREDIT_MIN_USD) return { balance, toppedUp: 0 };

  // What can this wallet afford? Quote $1 of credit and read raw-per-USD
  // off each solana rail, then divide holdings by it. The gateway prices
  // TOKEN at spot, so this never needs a price table.
  let affordable = 0;
  try {
    const q = await fetch(`${GATEWAY}/v1/credits/topup`, {
      method: 'POST',
      headers: ns(burner, { 'content-type': 'application/json' }),
      body: JSON.stringify({ usd: 1 }),
    });
    if (q.status === 402) {
      const ch: any = await q.json();
      for (const row of ch.accepts || []) {
        if (!String(row.network || '').startsWith('solana')) continue;
        const perUsd = Number(row.maxAmountRequired || 0);
        if (!(perUsd > 0)) continue;
        const bal = await tokenBalance(connection(), burner.keypair.publicKey, row.asset).catch(() => null);
        if (bal?.raw) affordable = Math.max(affordable, Number(bal.raw) / perUsd);
      }
    }
  } catch { /* fall through — nothing affordable */ }
  const usdAmt = Math.min(Math.floor(affordable * 0.97 * 100) / 100, TOPUP_CAP_USD);
  if (usdAmt < 1) return { balance, toppedUp: 0 };   // gateway minimum is $1

  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usd: usdAmt }),
  };
  const first = await fetch(`${GATEWAY}/v1/credits/topup`, {
    ...init,
    headers: ns(burner, init.headers as Record<string, string>),
  });
  let res = first;
  if (first.status === 402) {
    const quote = await first.json();
    res = await payWith402(burner, `${GATEWAY}/v1/credits/topup`, init, quote);
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) return { balance, toppedUp: 0 };
  return { balance: Number(body.balanceUsd ?? usdAmt), toppedUp: Number(body.creditedUsd ?? usdAmt) };
}

/**
 * One chat completion, paid by whoever is in scope. Returns the raw
 * OpenAI-shaped body plus the receipt (which the ledger turns into the
 * price line every reply must carry).
 */
export async function zooChat(
  body: Record<string, unknown>,
  { contextId, subscriptionKey, signal }: { contextId?: string | null; subscriptionKey?: string; signal?: AbortSignal } = {},
): Promise<{ data: any; receipt: ZooReceipt; payer: 'group-credit' | 'operator' }> {
  const scope = currentZooScope();
  const url = `${GATEWAY}/v1/chat/completions`;
  const base: Record<string, string> = {
    'content-type': 'application/json',
    ...(contextId ? { 'x-hrr-context': contextId } : {}),
  };

  // GROUP LANE — only when a burner is in scope.
  if (scope?.burner) {
    const burner = scope.burner;
    const attempt = () => fetch(url, {
      method: 'POST',
      headers: ns(burner, { ...base }),
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    let res = await attempt();
    if (res.status === 402) {
      // No credit. Try to buy some from whatever the group wallet holds,
      // then retry ONCE — a second 402 means the group is genuinely broke,
      // and the operator lane decides what happens next.
      const { toppedUp } = await ensureGroupCredit(burner).catch(() => ({ toppedUp: 0 }));
      if (toppedUp > 0) res = await attempt();
    }
    if (res.ok) {
      const data = await res.json();
      return { data, receipt: receiptFrom(data), payer: 'group-credit' };
    }
    if (res.status !== 402) {
      throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    // fall through to operator lane below — the group being broke must not
    // silence the agent unless the operator has opted into strict mode.
    if (process.env.OPENZOO_ELIZA_GROUP_STRICT === '1') {
      const quote: any = await res.json().catch(() => ({}));
      const raw = Number(quote?.accepts?.[0]?.maxAmountRequired || 0);
      throw new GroupUnderfundedError(burner.address, raw > 0 ? raw / 1e6 : 0);
    }
  }

  // OPERATOR LANE — subscription key if configured, else PayClient handles
  // the 402 → pay → replay dance from the machine wallet.
  if (subscriptionKey) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...base, authorization: `Bearer ${subscriptionKey}` },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`gateway ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return { data, receipt: receiptFrom(data), payer: 'operator' };
  }

  const { PayClient } = await import('openzoo/lib/pay.js');
  const pay = new PayClient();
  const { data } = await pay.chat(body, { headers: base });
  return { data, receipt: receiptFrom(data), payer: 'operator' };
}
