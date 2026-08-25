/**
 * A managed x402 burner per Telegram GROUP, derived not stored — ported from
 * openzoo-shim lib/xburner.js with a new derivation tag.
 *
 * DERIVED, NOT STORED, and that is the whole security argument:
 *   seed(group) = HMAC-SHA512(master, "openzoo-eliza-v1:" + chatId)
 * There is exactly ONE secret on disk no matter how many groups the agent
 * ever joins. A per-group keyfile store would mean hundreds of secrets, a
 * backup problem, a deletion problem, and a breach that scales with
 * adoption. Here the blast radius is one file that already had to be
 * protected, and a burner can be re-derived on any machine from that file
 * alone — nothing to lose, nothing to migrate.
 *
 * The tradeoff, stated plainly: the master file CAN derive every burner, so
 * it is as sensitive as all of them combined. 0600, never logged, never
 * sent anywhere.
 *
 * Keyed on the numeric Telegram chat id, never the group title: titles are
 * mutable and a burner that followed a renamed group would hand a new
 * group the old wallet.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';

const MASTER_FILE = process.env.OPENZOO_ELIZA_MASTER
  || path.join(os.homedir(), '.openzoo', 'eliza-master.key');

/** Bump if the derivation ever changes — old burners must keep deriving. */
const DERIVATION = 'openzoo-eliza-v1';

export interface GroupBurner {
  keypair: Keypair;
  evmPrivateKey: string;
  address: string;
  groupId: string;
}

export function loadOrCreateMaster(file: string = MASTER_FILE): Buffer {
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    const buf = Buffer.from(hex, 'hex');
    if (buf.length === 32) return buf;
    throw new Error('bad length');
  } catch {
    const buf = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // wx: never clobber an existing master. Overwriting it would orphan
    // every burner ever handed out — funds still on-chain, key unrecoverable.
    try {
      fs.writeFileSync(file, buf.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    } catch {
      return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    }
    return buf;
  }
}

/** Deterministic burner for a Telegram chat id (group or DM). */
export function deriveGroupBurner(groupId: string | number, master: Buffer = loadOrCreateMaster()): GroupBurner {
  if (groupId === undefined || groupId === null || groupId === '') {
    throw new Error('deriveGroupBurner needs a chat id');
  }
  const mac = crypto.createHmac('sha512', master)
    .update(`${DERIVATION}:${String(groupId)}`)
    .digest();
  const keypair = Keypair.fromSeed(Uint8Array.from(mac.subarray(0, 32)));
  const evmPrivateKey = `0x${mac.subarray(32, 64).toString('hex')}`;
  return {
    keypair,
    evmPrivateKey,
    address: keypair.publicKey.toBase58(),
    groupId: String(groupId),
  };
}

/** Address only — for a reply that tells a group where to send funds. */
export function groupBurnerAddress(groupId: string | number, master?: Buffer): string {
  return deriveGroupBurner(groupId, master ?? loadOrCreateMaster()).address;
}

/**
 * Group an address into 4-character blocks so a human can actually verify
 * it. A 44-character base58 run is unreadable, and unreadable is exactly
 * what a lookalike address relies on. (Ported from xbot's groupCa.)
 */
export function groupCa(addr: string, size = 4): string {
  return String(addr).replace(new RegExp(`.{1,${size}}`, 'g'), '$& ').trim();
}
