/**
 * The receipt — ported from openzoo-shim lib/xbot.js, semantics preserved.
 *
 * Every reply the agent posts carries the cost of producing it, compared
 * against buying the SAME tokens on the SAME model direct from OpenRouter.
 * The receipt is the product: a reply that just answers is a worse @grok,
 * a reply that prices itself is the pitch.
 *
 * TRUST THE GATEWAY'S FIGURES. xbot learned this the hard way: recomputing
 * cost client-side from usage.prompt_tokens prices the discount against
 * itself (against an attached context, prompt_tokens counts only the
 * recalled slice) and printed "same as OpenRouter direct" on calls the
 * gateway itself billed at a 3.2x saving.
 */

export interface ZooReceipt {
  routedModel: string;
  billedUsd: number;
  directUsd: number;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Format a USD figure small enough that toFixed(2) would render every reply
 * as "$0.00" — which reads as "free" and destroys the entire claim.
 */
export function usd(n: number): string {
  if (!(n > 0)) return '$0';
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.000001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(1)}`;
}

function short(id: string): string {
  return String(id).split('/').pop() || String(id);
}

/** Pull the receipt out of a gateway chat-completions response body. */
export function receiptFrom(json: any): ZooReceipt {
  const usage = json?.usage || {};
  const x402 = json?.x402 || {};
  return {
    routedModel: json?.model || 'unknown',
    billedUsd: Number(x402.billedUsd ?? usage.cost ?? 0),
    directUsd: Number(x402.directUsd ?? 0),
    promptTokens: Number(usage.prompt_tokens || 0),
    completionTokens: Number(usage.completion_tokens || 0),
  };
}

/**
 * The receipt line — APPLES TO APPLES. `directUsd` is the gateway's own
 * figure for what THESE tokens, on THIS model, would have cost direct on
 * OpenRouter. Equal prices are reported as equal: on a short prompt there
 * is genuinely nothing to spill, and inventing a saving would be the same
 * lie in a smaller font. 5% is the noise floor, not a marketing bar.
 */
export function priceLine(
  r: { routedModel: string; billedUsd: number; directUsd: number },
  site = process.env.OPENZOO_SITE || 'openzoo.fun',
): string {
  const bits = [short(r.routedModel), usd(r.billedUsd)];
  if (r.directUsd > 0 && r.billedUsd > 0) {
    const x = r.directUsd / r.billedUsd;
    if (x >= 1.05) bits.push(`vs ${usd(r.directUsd)} direct on OpenRouter — ${x.toFixed(1)}× cheaper`);
    else bits.push('same as OpenRouter direct — never more');
  }
  bits.push(site);
  return bits.join(' · ');
}

/**
 * Per-room running tab. One user-visible reply is built from SEVERAL model
 * calls (shouldRespond gate, the answer itself, maybe an object call), and a
 * receipt that priced only the last one would understate what the reply cost.
 * The ledger accumulates every settled call against a room until the send
 * path drains it onto the outgoing message.
 */
export class ReceiptLedger {
  private tabs = new Map<string, { billedUsd: number; directUsd: number; calls: number; routedModel: string }>();

  add(roomId: string, r: ZooReceipt): void {
    if (!roomId) return;
    const tab = this.tabs.get(roomId) || { billedUsd: 0, directUsd: 0, calls: 0, routedModel: r.routedModel };
    tab.billedUsd += r.billedUsd;
    tab.directUsd += r.directUsd;
    tab.calls += 1;
    // The headline model is the one that did the heavy lifting: keep the
    // model of the most expensive single call, not the last small gate.
    if (r.billedUsd >= tab.billedUsd - r.billedUsd || tab.calls === 1) tab.routedModel = r.routedModel;
    this.tabs.set(roomId, tab);
  }

  /** Drain the tab for a room into a printable receipt line, or '' if empty. */
  drain(roomId: string): string {
    const tab = this.tabs.get(roomId);
    if (!tab || !(tab.billedUsd > 0)) { this.tabs.delete(roomId); return ''; }
    this.tabs.delete(roomId);
    return priceLine(tab);
  }

  peek(roomId: string) {
    return this.tabs.get(roomId) || null;
  }
}
