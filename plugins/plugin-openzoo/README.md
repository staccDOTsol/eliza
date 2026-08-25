# @elizaos/plugin-openzoo

elizaOS, ported to [openzoo](https://openzoo.fun): the agent pays for its own
inference over [x402](https://www.x402.org/) — no API key anywhere in the
loop. As long as the agent can make money on Solana/Base, it can afford to
think, forever.

Ported from the retiring `@openzoobot` (openzoo-shim `lib/xbot.js`), keeping
its three load-bearing behaviors:

1. **Every reply carries the receipt.** Routed model, billed USD, and what
   the SAME tokens on the SAME model would have cost buying direct on
   OpenRouter — `grok-4.6 · $0.0037 · vs $0.0118 direct on OpenRouter —
   3.2× cheaper · openzoo.fun`. Equal prices are reported as equal; the
   figures are the gateway's own, never recomputed client-side.
2. **It ingests all the sauce.** On startup the plugin crawls `$HOME/open*`
   and `$HOME/lecore` for text-like files (.md and friends), binds them into
   one persistent leCore context on the gateway (free, cumulative,
   hash-deduped), and attaches it to every model call via `x-hrr-context`.
3. **Wallets are derived, not stored.** Each Telegram group (and each X
   author) gets a burner: `HMAC-SHA512(master, "openzoo-eliza-v1:" + id)`.
   One secret on disk (`~/.openzoo/eliza-master.key`, 0600) no matter how
   many groups exist; a burner re-derives on any machine from that file.

## How a call gets paid

1. **Group credit** — the room's burner has prepaid gateway credit → the
   call draws it down, zero chain traffic.
2. **Group top-up** — the burner holds tokens but no credit → buy as much
   credit as the wallet covers in ONE x402 settlement, retry.
3. **Operator wallet** — no burner in scope, or the group is broke → the
   agent's own machine wallet (`~/.openzoo/wallet.json`) pays via openzoo's
   PayClient, or `OPENZOO_SUBSCRIPTION_KEY` if set.

Set `OPENZOO_ELIZA_GROUP_STRICT=1` to refuse instead of falling back when a
group is unfunded.

## Connector behavior (forked in this repo)

- **Telegram** (`plugins/plugin-telegram`): responds ONLY to @-tags of its
  handle, replies to its own messages, slash commands, and DMs — but
  ingests every message it can see into memory. `/wallet` prints the
  group's shared burner address + funding assets, `/balance` its gateway
  credit, `/topup` converts held tokens into credit.
- **X** (`plugins/plugin-x`): replies to mentions with the receipt appended
  (the answer is trimmed to fit 280 weighted chars rather than the receipt
  dropped); each asker's calls settle from their own derived burner when
  funded; the core shouldRespond LLM call is skipped for platform mentions.

## Run it

```jsonc
// ~/.local/state/eliza/eliza.json (the default state dir; override with
// ELIZA_CONFIG_PATH or ELIZA_STATE_DIR)
{
  "plugins": { "allow": ["openzoo"] },
  "connectors": { "telegram": { "enabled": true } }
}
```

```bash
export TELEGRAM_BOT_TOKEN=...     # from @BotFather
export OPENZOO_ENABLE=1           # auto-enables the plugin
bun run start                     # repo root
```

No inference key. The first paid call creates `~/.openzoo/wallet.json`;
fund it (or a group's `/wallet` address) with USDC / TOKEN / LEOS + a
little SOL and the agent is self-sustaining.

## Settings

| var | default | meaning |
|---|---|---|
| `OPENZOO_API_BASE` | `https://x402-tokens.fly.dev` | gateway |
| `OPENZOO_SMALL_MODEL` / `OPENZOO_LARGE_MODEL` | `openzoo/auto` | the gateway picks a cheap model that is good enough; the receipt names it |
| `OPENZOO_SUBSCRIPTION_KEY` | — | optional; skip x402 and bill a subscription |
| `OPENZOO_KNOWLEDGE` | on | `0` disables the $HOME/open* + $HOME/lecore crawl |
| `OPENZOO_KNOWLEDGE_ROOTS` | — | extra `:`-separated roots to bind |
| `OPENZOO_ELIZA_GROUP_WALLETS` | on | `0` = operator wallet pays everything |
| `OPENZOO_ELIZA_CREDIT_MIN` | `0.25` | top up below this credit balance |
| `OPENZOO_ELIZA_TOPUP_CAP` | `500` | max USD per top-up settlement |
| `OPENZOO_ELIZA_MASTER` | `~/.openzoo/eliza-master.key` | burner master key path |
| `OPENZOO_TG_STRICT_DM` | off | `1` = even DMs need an @-tag |

Streaming is supported: when core passes `stream` + `onStreamChunk`,
deltas are forwarded off the SSE wire as they arrive, and the receipt is
recovered from the x402 settle header (a streamed body's trailing chunks
carry usage but not the price comparison).

No `TEXT_EMBEDDING` is registered, deliberately — the gateway is
OpenRouter-backed, which has no embeddings endpoint, and leCore recall
covers the memory story. Core degrades gracefully without it.
