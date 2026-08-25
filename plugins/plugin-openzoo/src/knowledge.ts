/**
 * Default knowledge corpus: every bot ingests all the sauce it can find.
 *
 * At startup the plugin crawls $HOME/open* and $HOME/lecore for text-like
 * files (.md and friends) and binds them into ONE persistent leCore context
 * on the openzoo gateway. That context rides every model call as
 * `x-hrr-context`, so the agent recalls the project's own docs, code and
 * notes without ever forwarding the corpus inline — bind once, ask forever.
 *
 * Binding is FREE (not a paid endpoint) and CUMULATIVE: part 1 created the
 * context, everything since appends to the same context_id. What was already
 * bound is tracked locally by content hash, so a restart binds only what
 * changed instead of re-uploading megabytes of unchanged docs.
 *
 * Everything under these roots is the operator's own material, which is why
 * one shared context is acceptable. Do not point this at private material
 * belonging to someone else — a shared context means any question can recall
 * any bound slice.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
// Reuse the shim's battle-tested crawler and splitter rather than reinventing
// either: collectFiles knows which extensions are text, which directories to
// skip, and splitIntoParts cuts on paragraph boundaries so a fact is never
// stranded across two bind calls.
import { collectFiles, splitIntoParts } from 'openzoo/lib/bindpath.js';

const GATEWAY = process.env.OPENZOO_API_BASE || process.env.OPENZOO_GATEWAY || 'https://x402-tokens.fly.dev';

const STATE_FILE = process.env.OPENZOO_KNOWLEDGE_STATE
  || path.join(os.homedir(), '.openzoo', 'eliza-knowledge.json');

/** Per-file ceiling: a single 20MB log would drown the corpus in noise. */
const MAX_FILE_BYTES = Number(process.env.OPENZOO_KNOWLEDGE_MAX_FILE || 2_000_000);
/** Per-run ceiling, same rationale as bindpath's MAX_TOTAL_BYTES. */
const MAX_RUN_BYTES = Number(process.env.OPENZOO_KNOWLEDGE_MAX_RUN || 32 * 1024 * 1024);

interface KnowledgeState {
  contextId: string | null;
  bound: Record<string, string>; // absolute path -> sha256 of content last bound
}

function loadState(): KnowledgeState {
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { contextId: d.contextId || null, bound: d.bound || {} };
  } catch {
    return { contextId: null, bound: {} };
  }
}

function saveState(state: KnowledgeState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

/** Bare files under $HOME matching open* are sauce too (handoff notes and
 *  the like) — but only text-shaped ones; a banner jpg is not a corpus. */
const FILE_ROOT_EXTS = new Set(['.md', '.txt', '.json', '.log']);

/** $HOME/open* (directories AND text files) plus $HOME/lecore — every root
 *  that exists right now. */
export function defaultRoots(home: string = os.homedir()): string[] {
  const roots: string[] = [];
  try {
    for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
      if (!entry.name.startsWith('open')) continue;
      if (entry.isDirectory()) roots.push(path.join(home, entry.name));
      else if (FILE_ROOT_EXTS.has(path.extname(entry.name).toLowerCase())) {
        roots.push(path.join(home, entry.name));
      }
    }
  } catch { /* unreadable home — nothing to crawl */ }
  const lecore = path.join(home, 'lecore');
  if (fs.existsSync(lecore)) roots.push(lecore);
  const extra = process.env.OPENZOO_KNOWLEDGE_ROOTS;
  if (extra) for (const p of extra.split(':')) if (p && fs.existsSync(p)) roots.push(p);
  return [...new Set(roots)].sort();
}

async function postBind(payload: Record<string, unknown>): Promise<string> {
  // Deliberately WITHOUT namespace headers: xbot's shared context is bound
  // the same way, and it is what lets both the operator lane and the
  // per-group paid lane attach the same context id.
  const r = await fetch(`${GATEWAY}/v1/hrr/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`bind ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  if (!j?.context_id) throw new Error('bind returned no context_id');
  return j.context_id as string;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Crawl the default roots and bind everything new or changed. Returns the
 * context id to attach on model calls (or null when there is nothing bound
 * and nothing bindable — the agent still answers, it just answers without
 * the sauce).
 *
 * Failure here must never block the agent: a gateway that is down costs the
 * corpus, not the conversation.
 */
export async function seedKnowledge(log: (msg: string) => void = () => {}): Promise<string | null> {
  if (process.env.OPENZOO_KNOWLEDGE === '0') return null;
  const state = loadState();
  try {
    const roots = defaultRoots();
    if (!roots.length) return state.contextId;

    // Gather what changed since the last run, newest state wins.
    const fresh: { file: string; text: string; hash: string }[] = [];
    let runBytes = 0;
    let capped = false;
    for (const root of roots) {
      if (capped) break;
      let files: string[] = [];
      // maxFiles raised well past bindpath's default 5000: a capped listing
      // returns the SAME first N files every run, so anything past the cap
      // would never be seen at all. The per-run byte cap below is what
      // actually bounds the work — leftovers bind on later runs.
      try { files = collectFiles(root, { maxFiles: 100_000 }); } catch { continue; }
      for (const f of files) {
        try {
          if (fs.statSync(f).size > MAX_FILE_BYTES) continue;
          const text = fs.readFileSync(f, 'utf8');
          const h = sha(text);
          if (state.bound[f] === h) continue;
          if (runBytes + text.length > MAX_RUN_BYTES) {
            log(`knowledge: hit ${Math.round(MAX_RUN_BYTES / 1048576)}MB run cap — remaining files bind on the next pass`);
            capped = true;
            break;
          }
          runBytes += text.length;
          fresh.push({ file: f, text, hash: h });
        } catch { /* unreadable file — skip */ }
      }
    }

    if (!fresh.length) {
      if (state.contextId) log(`knowledge: corpus current (${Object.keys(state.bound).length} files) → ${state.contextId}`);
      return state.contextId;
    }

    const corpus = fresh
      .map(({ file, text }) => `===== ${file.replace(os.homedir(), '~')} =====\n${text}`)
      .join('\n\n');
    const parts = splitIntoParts(corpus);
    log(`knowledge: binding ${fresh.length} file(s), ${parts.length} part(s), ${(runBytes / 1048576).toFixed(1)}MB`);

    let contextId = state.contextId;
    for (const part of parts) {
      contextId = await postBind(contextId ? { context_id: contextId, corpus: part } : { corpus: part });
    }
    // Persist ONLY after every part landed — a half-bound run re-binds next
    // start rather than silently forgetting the tail.
    state.contextId = contextId;
    for (const { file, hash } of fresh) state.bound[file] = hash;
    saveState(state);
    log(`knowledge: bound → ${contextId}`);
    return contextId;
  } catch (e: any) {
    log(`knowledge: seeding failed (${e?.message || e}) — answering without the corpus`);
    return state.contextId;
  }
}

/**
 * Append arbitrary conversation material to the same context. Free, and a
 * failure never costs anyone their answer. This is how group chatter
 * accumulates into recallable memory (xbot's bindThread, generalized).
 */
export async function bindText(contextId: string | null, text: string): Promise<string | null> {
  const t = String(text || '').trim();
  if (!t) return contextId;
  try {
    return await postBind(contextId ? { context_id: contextId, corpus: t } : { corpus: t });
  } catch {
    return contextId;
  }
}
