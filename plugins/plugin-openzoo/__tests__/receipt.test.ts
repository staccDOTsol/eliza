import { describe, expect, it } from "vitest";
import { priceLine, ReceiptLedger, receiptFrom, usd } from "../src/receipt";

describe("usd", () => {
  it("never renders a real price as free", () => {
    expect(usd(0.0000105)).toBe("$0.000010");
    expect(usd(0.0234)).toBe("$0.0234");
    expect(usd(1e-8)).toBe("$1.0e-8");
    expect(usd(0)).toBe("$0");
  });
});

describe("priceLine", () => {
  it("prints the OpenRouter comparison whenever the saving is real", () => {
    const line = priceLine(
      { routedModel: "x-ai/grok-4.6", billedUsd: 0.0037, directUsd: 0.0118 },
      "openzoo.fun"
    );
    expect(line).toContain("grok-4.6");
    expect(line).toContain("$0.0037");
    expect(line).toContain("vs $0.0118 direct on OpenRouter");
    expect(line).toContain("3.2× cheaper");
    expect(line).toContain("openzoo.fun");
  });

  it("reports equal prices as equal, never inventing a saving", () => {
    const line = priceLine({ routedModel: "openzoo/auto", billedUsd: 0.001, directUsd: 0.001 });
    expect(line).toContain("same as OpenRouter direct — never more");
  });

  it("reports a genuine 1.2x saving instead of hiding it under a marketing bar", () => {
    const line = priceLine({ routedModel: "m", billedUsd: 0.001, directUsd: 0.0012 });
    expect(line).toContain("1.2× cheaper");
  });
});

describe("receiptFrom", () => {
  it("trusts the gateway figures, x402 first then usage.cost", () => {
    const r = receiptFrom({
      model: "meta-llama/llama-3.1-8b",
      usage: { prompt_tokens: 208, completion_tokens: 90, cost: 0.002 },
      x402: { billedUsd: 0.0037, directUsd: 0.0118 },
    });
    expect(r.routedModel).toBe("meta-llama/llama-3.1-8b");
    expect(r.billedUsd).toBe(0.0037);
    expect(r.directUsd).toBe(0.0118);
    expect(r.promptTokens).toBe(208);
  });

  it("falls back to usage.cost when x402 is absent (credit-paid calls)", () => {
    const r = receiptFrom({ model: "m", usage: { cost: 0.0005 } });
    expect(r.billedUsd).toBe(0.0005);
    expect(r.directUsd).toBe(0);
  });
});

describe("ReceiptLedger", () => {
  it("accumulates every call for a room and drains once", () => {
    const ledger = new ReceiptLedger();
    ledger.add("room1", {
      routedModel: "small",
      billedUsd: 0.0001,
      directUsd: 0.0001,
      promptTokens: 10,
      completionTokens: 2,
    });
    ledger.add("room1", {
      routedModel: "x-ai/grok-4.6",
      billedUsd: 0.003,
      directUsd: 0.009,
      promptTokens: 900,
      completionTokens: 300,
    });
    const line = ledger.drain("room1");
    expect(line).toContain("grok-4.6"); // headline model = the expensive call
    expect(line).toContain("$0.0031");
    expect(ledger.drain("room1")).toBe(""); // drained means drained
  });

  it("returns empty for a room with no settled cost", () => {
    const ledger = new ReceiptLedger();
    expect(ledger.drain("nowhere")).toBe("");
    ledger.add("room2", {
      routedModel: "m",
      billedUsd: 0,
      directUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(ledger.drain("room2")).toBe("");
  });
});
