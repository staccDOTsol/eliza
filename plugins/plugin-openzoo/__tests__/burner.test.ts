import { describe, expect, it } from "vitest";
import { deriveGroupBurner, groupBurnerAddress, groupCa } from "../src/burner";

// A fixed master so derivation is testable without touching the real
// ~/.openzoo/eliza-master.key (which must never be created by a test run).
const MASTER = Buffer.alloc(32, 7);

describe("deriveGroupBurner", () => {
  it("is deterministic: same chat id, same wallet, forever", () => {
    const a = deriveGroupBurner("-1001234567890", MASTER);
    const b = deriveGroupBurner("-1001234567890", MASTER);
    expect(a.address).toBe(b.address);
    expect(a.evmPrivateKey).toBe(b.evmPrivateKey);
  });

  it("separates groups: different chat ids never share a wallet", () => {
    const a = deriveGroupBurner("-1001234567890", MASTER);
    const b = deriveGroupBurner("-1009876543210", MASTER);
    expect(a.address).not.toBe(b.address);
  });

  it("accepts numeric ids and stringifies them identically", () => {
    expect(deriveGroupBurner(42, MASTER).address).toBe(deriveGroupBurner("42", MASTER).address);
  });

  it("yields both a solana keypair and an evm key from one derivation", () => {
    const b = deriveGroupBurner("1", MASTER);
    expect(b.address.length).toBeGreaterThanOrEqual(32);
    expect(b.evmPrivateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(b.keypair.publicKey.toBase58()).toBe(b.address);
  });

  it("refuses an empty chat id rather than deriving the same wallet for everyone", () => {
    expect(() => deriveGroupBurner("", MASTER)).toThrow();
  });

  it("groupBurnerAddress matches the full derivation", () => {
    expect(groupBurnerAddress("7", MASTER)).toBe(deriveGroupBurner("7", MASTER).address);
  });
});

describe("groupCa", () => {
  it("chunks an address into human-checkable blocks without losing a character", () => {
    const addr = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const grouped = groupCa(addr);
    expect(grouped.replace(/ /g, "")).toBe(addr);
    expect(grouped).toContain("EPjF Wdd5");
  });
});
