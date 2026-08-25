/**
 * @elizaos/plugin-openzoo — inference the agent pays for itself.
 *
 * No API key anywhere in the loop: model calls go to the openzoo x402
 * gateway (~490 models, OpenAI-compatible) and settle from a wallet —
 * the room's shared burner when one is in scope, the agent's own machine
 * wallet otherwise. Whatever the agent earns on Solana/Base lands in the
 * same wallet that buys its next thought. As long as it can make money,
 * it can afford to think, forever.
 *
 * Three standing behaviors, all ported from the retiring @openzoobot:
 *  - EVERY reply carries the receipt: routed model, billed USD, and what
 *    the SAME call would have cost direct on OpenRouter (src/receipt.ts).
 *  - The agent ingests all the sauce it can find: $HOME/open* and
 *    $HOME/lecore are crawled and bound into one leCore context that
 *    rides every model call as x-hrr-context (src/knowledge.ts).
 *  - Groups share one derived burner wallet each, funded by the group,
 *    persisted as ONE master key on disk (src/burner.ts).
 */

import {
  type IAgentRuntime,
  type Plugin,
  ModelType,
  EventType,
  Service,
  logger,
} from '@elizaos/core';
import { config as zooConfig, FUNDING_ASSETS } from 'openzoo/lib/config.js';
import { deriveGroupBurner, type GroupBurner } from './burner';
import { seedKnowledge } from './knowledge';
import {
  zooChat,
  runWithZooScope,
  currentZooScope,
  chatWalletStatus,
  type ZooScope,
} from './pay';
import { ReceiptLedger, priceLine, usd, receiptFrom } from './receipt';

export { priceLine, usd, receiptFrom } from './receipt';
export { deriveGroupBurner, groupBurnerAddress, groupCa } from './burner';
export { runWithZooScope, currentZooScope, zooChat, chatWalletStatus } from './pay';
export { seedKnowledge, bindText, defaultRoots } from './knowledge';

const env = typeof process !== 'undefined' ? process.env : ({} as Record<string, string | undefined>);

function getSetting(runtime: IAgentRuntime, key: string, fallback?: string): string | undefined {
  const v = runtime.getSetting(key);
  if (v !== undefined && v !== null && v !== '') return String(v);
  return env[key] ?? fallback;
}

/**
 * `openzoo/auto` everywhere by default: the gateway routes each question to
 * a cheap model that is good enough for it, and the receipt names what it
 * picked — model selection IS the product being demonstrated.
 */
const DEFAULT_SMALL = 'openzoo/auto';
const DEFAULT_LARGE = 'openzoo/auto';

// There is no subscription lane. x402 is the only way anything gets paid:
// every DM, group and chat settles from its own derived burner, and calls
// with no chat in scope settle from the agent's machine wallet.

/**
 * The service is the seam connectors talk to — looked up by name
 * (`runtime.getService('openzoo')`), never imported, so a connector runs
 * unchanged whether or not this plugin is loaded.
 */
export class OpenzooService extends Service {
  static serviceType = 'openzoo';
  capabilityDescription =
    'x402 pay-per-call inference with per-room burner wallets, OpenRouter price receipts, and a leCore knowledge context';

  ledger = new ReceiptLedger();
  contextId: string | null = null;

  private rescanTimer: ReturnType<typeof setInterval> | null = null;

  static async start(runtime: IAgentRuntime): Promise<OpenzooService> {
    const svc = new OpenzooService(runtime);
    // Knowledge seeding is an enhancement, never a precondition: the agent
    // must come up (and answer) while megabytes of sauce bind in the
    // background. The context id lands on calls as soon as it exists.
    const seed = () =>
      seedKnowledge((m) => logger.info({ src: 'plugin:openzoo' }, m)).then((ctx) => {
        if (ctx && ctx !== svc.contextId) {
          svc.contextId = ctx;
          logger.info({ src: 'plugin:openzoo' }, `knowledge context attached: ${ctx}`);
        }
      });
    void seed();
    // Rescan on an interval so a long-running bot keeps ingesting new
    // sauce, not just what existed at boot. Also how a crawl that hit the
    // per-run byte cap works through its backlog. 0 disables.
    const rescanMs = Number(process.env.OPENZOO_KNOWLEDGE_RESCAN_MS ?? 3_600_000);
    if (rescanMs > 0) {
      svc.rescanTimer = setInterval(() => void seed(), rescanMs);
      svc.rescanTimer.unref?.();
    }
    return svc;
  }

  async stop(): Promise<void> {
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
  }

  /**
   * Wrap a response pipeline so every model call inside it settles against
   * this room's burner and lands on this room's receipt tab. Connectors
   * pass raw platform ids; derivation happens here.
   */
  runWithScope<T>(scope: { roomId: string; chatId?: string }, fn: () => Promise<T>): Promise<T> {
    let burner: GroupBurner | undefined;
    if (scope.chatId && process.env.OPENZOO_ELIZA_GROUP_WALLETS !== '0') {
      try { burner = deriveGroupBurner(scope.chatId); } catch { /* operator lane */ }
    }
    return runWithZooScope({ roomId: scope.roomId, chatId: scope.chatId, burner }, fn);
  }

  /** The receipt line for a room's accumulated calls, or '' if none. */
  drainReceipt(roomId: string): string {
    return this.ledger.drain(roomId);
  }

  /** Everything a /wallet reply needs. RAW addresses, no 4-char grouping:
   *  that spacing existed to slip X's crypto-address filter, Telegram has
   *  no such filter, and spaces break paste. */
  async walletInfo(chatId: string): Promise<{
    address: string;
    addressGrouped: string;
    holdingsLine: string;
    canPay: boolean;
    fundingLines: string[];
  }> {
    const burner = deriveGroupBurner(chatId);
    const status = await chatWalletStatus(burner);
    const token = FUNDING_ASSETS.find((a) => a.symbol === 'TOKEN');
    const leos = FUNDING_ASSETS.find((a) => a.symbol === 'LEOS');
    return {
      address: burner.address,
      addressGrouped: burner.address,
      holdingsLine: status.holdingsLine,
      canPay: status.canPay,
      fundingLines: [
        'send USDC, or:',
        ...(token ? [`TOKEN ${token.mint}`] : []),
        ...(leos ? [`LEOS ${leos.mint}`] : []),
      ],
    };
  }

  /**
   * Can this chat pay for an answer RIGHT NOW? Checked by the connector
   * BEFORE the response pipeline runs: core's message service swallows a
   * mid-pipeline GroupUnderfundedError and answers "Something went wrong"
   * (observed live), so affordability must be decided up front — funds in,
   * answer out; no funds, paywall. Positive results are cached for 60s so
   * a funded chat costs one balance read a minute, not one per message.
   */
  private fundedUntil = new Map<string, number>();

  async ensureChatFunded(chatId: string): Promise<{ funded: boolean; balance: number }> {
    if (process.env.OPENZOO_ELIZA_GROUP_WALLETS === '0') return { funded: true, balance: 0 };
    const now = Date.now();
    const exp = this.fundedUntil.get(chatId);
    if (exp && exp > now) return { funded: true, balance: -1 };
    // Affordability IS the on-chain balance now — the gateway killed its
    // credit system. Any payable token balance settles per-request x402;
    // no SOL needed (the facilitator pays gas as the co-signing fee payer).
    const status = await chatWalletStatus(deriveGroupBurner(chatId));
    if (status.canPay) this.fundedUntil.set(chatId, now + 60_000);
    return { funded: status.canPay, balance: status.canPay ? 1 : 0 };
  }

  /**
   * The funding message a broke chat sees — xbot's paywall reply,
   * translated to Telegram. Carries the chat's OWN burner address (grouped
   * so lookalikes are checkable), what to send, and the quoted price when
   * one is known, because "top up your wallet" without a number is an
   * unanswerable instruction.
   */
  paywallMessage(chatId: string, quotedUsd = 0): string {
    const burner = deriveGroupBurner(chatId);
    const token = FUNDING_ASSETS.find((a) => a.symbol === 'TOKEN');
    const leos = FUNDING_ASSETS.find((a) => a.symbol === 'LEOS');
    return [
      "this chat's wallet is out of funds — it pays x402 per question. send to:",
      burner.address,
      '',
      ...(quotedUsd > 0
        ? [`this question quoted up to ${usd(quotedUsd)} — $1 covers roughly ${Math.max(1, Math.floor(1 / quotedUsd))}`]
        : []),
      'send USDC, or:',
      ...(token ? [`TOKEN ${token.mint}`] : []),
      ...(leos ? [`LEOS ${leos.mint}`] : []),
      '',
      'no SOL needed — payment settles per question, gas is on us. then just ask again, or /wallet to check',
    ].join('\n');
  }
}

// ---------------------------------------------------------------- models

type AnyMessage = { role?: string; content?: unknown };

/** Flatten core's message shapes into OpenAI chat messages. Both `prompt`
 *  (legacy) and `messages` (v5) arrive here, sometimes with parts arrays. */
function toOpenAiMessages(params: any): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  if (params.system) out.push({ role: 'system', content: String(params.system) });
  const msgs: AnyMessage[] = Array.isArray(params.messages) ? params.messages : [];
  for (const m of msgs) {
    const role = m.role === 'assistant' || m.role === 'system' ? m.role : 'user';
    let content = '';
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) {
      content = m.content
        .map((p: any) => (typeof p === 'string' ? p : p?.text || ''))
        .filter(Boolean)
        .join('\n');
    }
    if (content) out.push({ role, content });
  }
  if (!msgs.length && params.prompt) out.push({ role: 'user', content: String(params.prompt) });
  if (!out.some((m) => m.role === 'user')) out.push({ role: 'user', content: ' ' });
  return out;
}

async function generateText(
  runtime: IAgentRuntime,
  params: any,
  size: 'small' | 'large',
): Promise<string> {
  const model =
    params.model
    || (size === 'small'
      ? getSetting(runtime, 'OPENZOO_SMALL_MODEL', DEFAULT_SMALL)
      : getSetting(runtime, 'OPENZOO_LARGE_MODEL', DEFAULT_LARGE));

  const body: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(params),
    ...(params.omitMaxTokens ? {} : { max_tokens: params.maxTokens ?? Number(getSetting(runtime, 'OPENZOO_MAX_TOKENS', '2048')) }),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.topP !== undefined ? { top_p: params.topP } : {}),
    ...(params.frequencyPenalty !== undefined ? { frequency_penalty: params.frequencyPenalty } : {}),
    ...(params.presencePenalty !== undefined ? { presence_penalty: params.presencePenalty } : {}),
    ...(params.stopSequences?.length ? { stop: params.stopSequences } : {}),
    // Structured output rides TEXT_LARGE in 2.0.x: ask the gateway for JSON
    // and let core parse. json_object is the widely-supported denominator.
    ...(params.responseSchema || params.responseFormat === 'json'
      ? { response_format: { type: 'json_object' } }
      : {}),
  };

  const svc = runtime.getService<OpenzooService>('openzoo');
  const { data, receipt } = await zooChat(body, {
    contextId: svc?.contextId,
    signal: params.signal,
    // Streaming: deltas are forwarded to core as they arrive off the SSE
    // wire; the full string still returns at the end (always a legal
    // handler result), with usage/x402 read from the trailing chunks.
    ...(params.stream && typeof params.onStreamChunk === 'function'
      ? { onStreamChunk: params.onStreamChunk as (d: string) => void }
      : {}),
  });

  const text: string = data?.choices?.[0]?.message?.content ?? '';
  const scope = currentZooScope();
  if (svc && scope?.roomId) svc.ledger.add(scope.roomId, receipt);

  // MODEL_USED wants the CONCRETE routed model id, not the slot name —
  // `auto` resolving to a small model is exactly the information of value.
  runtime.emitEvent(EventType.MODEL_USED as string, {
    runtime,
    source: 'openzoo',
    provider: 'openzoo',
    type: size === 'small' ? ModelType.TEXT_SMALL : ModelType.TEXT_LARGE,
    model: receipt.routedModel,
    modelName: receipt.routedModel,
    modelLabel: size === 'small' ? String(ModelType.TEXT_SMALL) : String(ModelType.TEXT_LARGE),
    prompt: body.messages ? JSON.stringify(body.messages).slice(0, 2000) : '',
    tokens: {
      prompt: receipt.promptTokens,
      completion: receipt.completionTokens,
      total: receipt.promptTokens + receipt.completionTokens,
    },
    // Not part of the stock payload, but the whole pitch of this plugin:
    billedUsd: receipt.billedUsd,
    directUsd: receipt.directUsd,
  } as any);

  return text;
}

// ---------------------------------------------------------------- plugin

export const openzooPlugin: Plugin = {
  name: 'openzoo',
  description:
    'x402 pay-per-call gateway to ~490 models. The agent pays for its own inference from a wallet it can earn into — no API key. Every call is priced against OpenRouter direct.',
  // Above elizacloud (50): loading this plugin means the operator chose
  // wallet-paid inference, and a cloud key lying around must not win.
  priority: 100,
  autoEnable: { envKeys: ['OPENZOO_ENABLE', 'OPENZOO_API_BASE'] },
  config: {
    OPENZOO_API_BASE: env.OPENZOO_API_BASE ?? null,
    OPENZOO_SMALL_MODEL: env.OPENZOO_SMALL_MODEL ?? null,
    OPENZOO_LARGE_MODEL: env.OPENZOO_LARGE_MODEL ?? null,
    OPENZOO_KNOWLEDGE: env.OPENZOO_KNOWLEDGE ?? null,
    OPENZOO_KNOWLEDGE_ROOTS: env.OPENZOO_KNOWLEDGE_ROOTS ?? null,
    OPENZOO_ELIZA_GROUP_WALLETS: env.OPENZOO_ELIZA_GROUP_WALLETS ?? null,
  },
  async init(_config, runtime) {
    logger.info(
      { src: 'plugin:openzoo' },
      `gateway ${zooConfig.apiBase} · x402 only, one burner per chat · models ${getSetting(runtime, 'OPENZOO_SMALL_MODEL', DEFAULT_SMALL)}/${getSetting(runtime, 'OPENZOO_LARGE_MODEL', DEFAULT_LARGE)}`,
    );
  },
  services: [OpenzooService],
  models: {
    [ModelType.TEXT_SMALL]: (runtime: IAgentRuntime, params: any) => generateText(runtime, params, 'small'),
    [ModelType.TEXT_LARGE]: (runtime: IAgentRuntime, params: any) => generateText(runtime, params, 'large'),
    [ModelType.TEXT_NANO as string]: (runtime: IAgentRuntime, params: any) => generateText(runtime, params, 'small'),
    [ModelType.TEXT_MEDIUM as string]: (runtime: IAgentRuntime, params: any) => generateText(runtime, params, 'large'),
    [ModelType.TEXT_MEGA as string]: (runtime: IAgentRuntime, params: any) => generateText(runtime, params, 'large'),
    [ModelType.RESPONSE_HANDLER as string]: (runtime: IAgentRuntime, params: any) => generateText(runtime, params, 'large'),
    [ModelType.ACTION_PLANNER as string]: (runtime: IAgentRuntime, params: any) => generateText(runtime, params, 'small'),
  } as Plugin['models'],
};

export default openzooPlugin;
