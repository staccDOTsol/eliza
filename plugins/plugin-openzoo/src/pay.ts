/**
 * How a model call gets paid — x402 per request, nothing else:
 *
 *   - CHAT IN SCOPE: the chat's derived burner settles each call directly.
 *     402 quote → sign a token transfer with the chat's keypair, the
 *     facilitator co-signs as fee payer (two signatures, zero gas for the
 *     burner) → replay with X-PAYMENT. A broke chat throws
 *     GroupUnderfundedError, which the connector echoes as a funding
 *     message. The gateway's credit/top-up endpoints are GONE ("pay per
 *     request with x402 — no account, no API key, no subscription").
 *   - NO SCOPE (autonomy loops, control UI, warmups): the agent's own
 *     machine wallet settles the same way via openzoo's PayClient. This is
 *     the self-sustaining lane — whatever the agent earns on-chain lands
 *     in the wallet that buys its next thought.
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
import { config, FUNDING_ASSETS } from 'openzoo/lib/config.js';
import { withNamespace } from 'openzoo/lib/namespace.js';
import {
  orderAccepts,
  buildPaymentOnline,
  paymentEnvelope,
  encodeEnvelope,
  paymentHeaders,
  tokenBalance,
  railOf,
} from 'openzoo/lib/x402.js';
import type { GroupBurner } from './burner';
import { receiptFrom, type ZooReceipt } from './receipt';

const GATEWAY: string = config.apiBase;

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

/**
 * What the chat's wallet holds on-chain, and whether that can settle a
 * call. Credit prepay is GONE — the gateway disabled top-ups outright
 * ("pay per request with x402 — no account, no API key, no subscription"),
 * so affordability IS the on-chain balance. No SOL required: the payment
 * envelope's fee payer is the FACILITATOR's gas signer (see the shim's
 * buildPayment), so the burner signs a transfer and pays zero gas.
 */
export async function chatWalletStatus(burner: GroupBurner): Promise<{
  sol: number;
  holdings: { symbol: string; ui: number }[];
  holdingsLine: string;
  canPay: boolean;
}> {
  const conn = connection();
  const sol = (await conn.getBalance(burner.keypair.publicKey).catch(() => 0)) / 1e9;
  const holdings: { symbol: string; ui: number }[] = [];
  for (const a of FUNDING_ASSETS) {
    const b = await tokenBalance(conn, burner.keypair.publicKey, a.mint).catch(() => null);
    holdings.push({ symbol: a.symbol, ui: Number(b?.ui ?? 0) });
  }
  const held = holdings.filter((h) => h.ui > 0);
  const holdingsLine = held.length
    ? held.map((h) => `${h.ui} ${h.symbol}`).join(' · ') + (sol > 0 ? ` · ${sol} SOL` : '')
    : sol > 0 ? `${sol} SOL (no payable tokens)` : 'empty';
  return { sol, holdings, holdingsLine, canPay: held.length > 0 };
}

/**
 * Settle ONE x402 payment with the CHAT's keypair. This deliberately does
 * not use PayClient: PayClient always signs with the operator's machine
 * wallet, and the entire point of a chat burner is that the chat's own
 * funds settle the chat's own calls. Solana rails only for now — the
 * derived burner has an EVM key too, but nothing drives it yet.
 */
async function payWith402(
  burner: GroupBurner,
  url: string,
  init: RequestInit,
  quote: any,
): Promise<{ res: Response; accept: any }> {
  const candidates = orderAccepts(quote, config.token, {}).filter((a: any) => railOf(a) === 'solana');
  let lastErr: Error | null = null;
  for (const accept of candidates) {
    try {
      const built: any = await buildPaymentOnline(connection(), burner.keypair, accept);
      // buildPaymentOnline returns the SIGNED TX, not the wire header — the
      // header is the envelope of (full 402 challenge, accept row, payload).
      // MEASURED without this: `built.header` is undefined, X-PAYMENT never
      // sent, and every funded chat re-402'd as "underfunded" forever.
      const header = encodeEnvelope(paymentEnvelope(quote, accept, built.payload));
      const headers = {
        ...(init.headers as Record<string, string> || {}),
        ...paymentHeaders(header),
      };
      const res = await fetch(url, { ...init, headers: ns(burner, headers) });
      if (res.status !== 402) return { res, accept };
      lastErr = new Error(`still 402 after paying ${accept?.extra?.symbol || accept?.asset}`);
    } catch (e: any) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no payable 402 row');
}

/**
 * Consume an SSE chat-completions stream: hand each text delta to onChunk,
 * and synthesize the JSON-shaped body the non-streaming path returns —
 * model/usage/x402 ride the trailing chunks (stream_options include_usage),
 * which is where the receipt figures come from on a streamed call.
 */
async function consumeSse(
  res: Response,
  onChunk?: (delta: string) => void,
): Promise<any> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('stream had no body');
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let meta: any = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const payload = line.match(/^data:\s*(.*)$/)?.[1];
      if (!payload || payload === '[DONE]') continue;
      let j: any;
      try { j = JSON.parse(payload); } catch { continue; }
      const delta = j?.choices?.[0]?.delta?.content ?? '';
      if (delta) { text += delta; onChunk?.(delta); }
      if (j?.model) meta.model = j.model;
      if (j?.usage) meta.usage = j.usage;
      if (j?.x402) meta.x402 = j.x402;
    }
  }
  return { ...meta, choices: [{ message: { content: text } }] };
}

/**
 * One chat completion, paid by whoever is in scope. Returns the raw
 * OpenAI-shaped body plus the receipt (which the ledger turns into the
 * price line every reply must carry). Pass onStreamChunk to stream: deltas
 * are forwarded as they arrive and the same shape is returned at the end.
 */
export async function zooChat(
  body: Record<string, unknown>,
  { contextId, signal, onStreamChunk }: {
    contextId?: string | null;
    signal?: AbortSignal;
    onStreamChunk?: (delta: string) => void;
  } = {},
): Promise<{ data: any; receipt: ZooReceipt; payer: 'group-x402' | 'operator' }> {
  const streaming = typeof onStreamChunk === 'function';
  if (streaming) {
    body = { ...body, stream: true, stream_options: { include_usage: true } };
  }
  const scope = currentZooScope();
  const url = `${GATEWAY}/v1/chat/completions`;
  const base: Record<string, string> = {
    'content-type': 'application/json',
    ...(contextId ? { 'x-hrr-context': contextId } : {}),
  };

  // CHAT LANE — a burner in scope IS the payer, full stop. Pay per
  // request: 402 quote → sign a transfer with the CHAT's keypair
  // (facilitator co-signs as fee payer — the two-signature dance) →
  // replay. No credits, no subscription, no operator subsidy. A broke
  // chat gets GroupUnderfundedError, which the connector echoes into the
  // chat as a funding message — the xbot paywall, translated to Telegram.
  if (scope?.burner) {
    const burner = scope.burner;
    const init: RequestInit = {
      method: 'POST',
      headers: { ...base },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    };
    let res = await fetch(url, { ...init, headers: ns(burner, { ...base }) });
    let paidAccept: any = null;
    if (res.status === 402) {
      const quote: any = await res.json().catch(() => ({}));
      try {
        const paid = await payWith402(burner, url, init, quote);
        res = paid.res;
        paidAccept = paid.accept;
      } catch {
        const raw = Number(quote?.accepts?.[0]?.maxAmountRequired || 0);
        throw new GroupUnderfundedError(burner.address, raw > 0 ? raw / 1e6 : 0);
      }
    }
    if (!res.ok) {
      if (res.status === 402) throw new GroupUnderfundedError(burner.address, 0);
      throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = streaming ? await consumeSse(res, onStreamChunk) : await res.json();
    const receipt = receiptFrom(data);
    // Streamed bodies often lack the x402 block — the QUOTE's own figures
    // are the honest fallback (billed is the reserved ceiling there, so
    // body figures win whenever present).
    const extra: any = paidAccept?.extra || {};
    if (!(receipt.billedUsd > 0) && Number(extra.billedUsd) > 0) receipt.billedUsd = Number(extra.billedUsd);
    if (!(receipt.directUsd > 0) && Number(extra.directUsd) > 0) receipt.directUsd = Number(extra.directUsd);
    return { data, receipt, payer: 'group-x402' };
  }

  // NO SCOPE — internal calls (autonomy loops, the control UI, boot
  // warmups) settle x402 from the agent's own machine wallet. Still no
  // subscription: PayClient does the 402 → pay → replay dance.
  const { PayClient } = await import('openzoo/lib/pay.js');
  const pay = new PayClient();
  // A wallet failure here still names a fundable address — the agent's own.
  const wrapUnderfunded = (e: unknown): never => {
    const msg = String((e as Error)?.message ?? e ?? '');
    if (/402|underfund|insufficient|no offered payment row|afford/i.test(msg)) {
      const m = msg.match(/"maxAmountRequired"\s*:\s*"?(\d+)/);
      throw new GroupUnderfundedError(pay.address, m?.[1] ? Number(m[1]) / 1e6 : 0);
    }
    throw e;
  };
  if (streaming) {
    // chat() parses JSON, so the streamed lane goes through fetch(), which
    // does the same 402 → pay → replay dance and hands back the live
    // response with its body still open.
    const paid = await pay.fetch(url, {
      method: 'POST',
      headers: base,
      body: JSON.stringify(body),
    }).catch(wrapUnderfunded);
    const { response } = paid;
    if (!response.ok) {
      const errText = (await response.text()).slice(0, 300);
      if (response.status === 402) wrapUnderfunded(new Error(`402 ${errText}`));
      throw new Error(`gateway ${response.status}: ${errText.slice(0, 200)}`);
    }
    const data = await consumeSse(response, onStreamChunk);
    const receipt = receiptFrom(data);
    // A streamed body's trailing chunks carry usage but often not the x402
    // block — the settle header PayClient decoded has the real figures.
    // MEASURED without this: "mimo-v2.5 · $0.000217 · openzoo.fun", no
    // OpenRouter comparison — the one line this whole plugin exists to print.
    const settled: any = (paid as any).receipt || {};
    if (!(receipt.billedUsd > 0) && Number(settled.billedUsd) > 0) receipt.billedUsd = Number(settled.billedUsd);
    if (!(receipt.directUsd > 0) && Number(settled.directUsd) > 0) receipt.directUsd = Number(settled.directUsd);
    return { data, receipt, payer: 'operator' };
  }
  const { data } = await pay.chat(body, { headers: base }).catch(wrapUnderfunded);
  return { data, receipt: receiptFrom(data), payer: 'operator' };
}
