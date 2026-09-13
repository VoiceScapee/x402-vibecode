/**
 * Economics invariant tests — "the platform never loses money".
 *
 * No keys, no network, no funds: pure math + env behavior. Each test
 * saves/restores the env vars it touches and resets the price feed so the
 * active HBAR/USD rate comes from HBAR_USD_PRICE (never the live feed).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeMinPriceCents,
  enforceStartupPriceFloor,
  getForwardFeeTinybars,
  getOperatorOverheadTinybars,
  resolveModelRates,
} from "../src/economics.js";
import { forwardTreasuryShare } from "../src/treasury.js";
import { splitPayment } from "../src/payment.js";
import {
  HBAR_ASSET_ID,
  USDC_TESTNET_TOKEN_ID,
} from "../src/payment.js";
import { resetPriceFeed } from "../src/price.js";

const ECON_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_INPUT_USD_PER_MTOK",
  "ANTHROPIC_OUTPUT_USD_PER_MTOK",
  "MAX_INPUT_TOKENS",
  "MAX_OUTPUT_TOKENS",
  "OPERATOR_OVERHEAD_TINYBARS",
  "FORWARD_FEE_TINYBARS",
  "HBAR_USD_PRICE",
  "PRICE_USD_CENTS",
  "ANTHROPIC_API_KEY",
];

function saveEnv(): Map<string, string | undefined> {
  const m = new Map<string, string | undefined>();
  for (const k of ECON_ENV_KEYS) m.set(k, process.env[k]);
  return m;
}

function restoreEnv(m: Map<string, string | undefined>): void {
  for (const [k, v] of m) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Fresh deterministic economics env: sonnet defaults, $0.20/HBAR, no live feed. */
function freshEnv(): Map<string, string | undefined> {
  const saved = saveEnv();
  for (const k of ECON_ENV_KEYS) delete process.env[k];
  resetPriceFeed();
  process.env.HBAR_USD_PRICE = "0.20";
  return saved;
}

describe("startup price floor math", () => {
  it("computes a 20¢ floor for the sonnet default at defaults (refuses the 1¢ default price)", () => {
    const saved = freshEnv();
    try {
      const floor = computeMinPriceCents();
      // worst-case AI: (20000×$3 + 4096×$15)/1e6 × 1.5 = $0.18216 → ceil 19¢
      assert.equal(floor.aiCostCents, 19n);
      // overhead: 0.01 HBAR @ $0.20 = $0.002 → ceil 1¢
      assert.equal(floor.overheadCents, 1n);
      assert.equal(floor.floorCents, 20n);
      assert.ok(floor.floorCents > 1n, "floor must exceed the default $0.01 price");
    } finally {
      restoreEnv(saved);
    }
  });

  it("raises the floor when token budgets grow", () => {
    const saved = freshEnv();
    try {
      process.env.MAX_OUTPUT_TOKENS = "8192";
      const floor = computeMinPriceCents();
      assert.ok(floor.floorCents > 20n);
    } finally {
      restoreEnv(saved);
    }
  });

  it("drops under a haiku-class model override", () => {
    const saved = freshEnv();
    try {
      process.env.ANTHROPIC_MODEL = "claude-haiku-4-5-20250929";
      const floor = computeMinPriceCents();
      // worst-case AI: (20000×$1 + 4096×$5)/1e6 × 1.5 = $0.06072 → ceil 7¢, +1¢ overhead = 8¢
      assert.equal(floor.aiCostCents, 7n);
      assert.equal(floor.floorCents, 8n);
      assert.ok(floor.floorCents < 20n);
    } finally {
      restoreEnv(saved);
    }
  });

  it("honors explicit rate overrides over the table", () => {
    const saved = freshEnv();
    try {
      process.env.ANTHROPIC_INPUT_USD_PER_MTOK = "0.25";
      process.env.ANTHROPIC_OUTPUT_USD_PER_MTOK = "1.25";
      const floor = computeMinPriceCents();
      // (20000×$0.25 + 4096×$1.25)/1e6 × 1.5 = $0.01518 → ceil 2¢, +1¢ = 3¢
      assert.equal(floor.floorCents, 3n);
    } finally {
      restoreEnv(saved);
    }
  });

  it("throws when only one rate override is set (no silent table/override mixing)", () => {
    const saved = freshEnv();
    try {
      process.env.ANTHROPIC_INPUT_USD_PER_MTOK = "0.25";
      assert.throws(() => resolveModelRates("claude-sonnet-4-5-20250929"), /BOTH/);
    } finally {
      restoreEnv(saved);
    }
  });

  it("throws a loud error for an unknown model with no overrides", () => {
    const saved = freshEnv();
    try {
      assert.throws(
        () => resolveModelRates("claude-mega-9"),
        (e: unknown) =>
          e instanceof Error &&
          e.message.includes('Unknown ANTHROPIC_MODEL "claude-mega-9"') &&
          e.message.includes("ANTHROPIC_INPUT_USD_PER_MTOK"),
      );
    } finally {
      restoreEnv(saved);
    }
  });
});

describe("enforceStartupPriceFloor", () => {
  it("throws in real AI mode when the price is below the floor", () => {
    const saved = freshEnv();
    try {
      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.PRICE_USD_CENTS = "1"; // below the 20¢ floor
      assert.throws(() => enforceStartupPriceFloor(), (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.ok(e.message.includes("PRICE_USD_CENTS=1"), "names the configured price");
        assert.ok(e.message.includes("20"), "names the computed floor");
        assert.ok(
          e.message.includes("raise PRICE_USD_CENTS") || e.message.includes("haiku-class"),
          "names the fix",
        );
        assert.ok(e.message.includes("claude-sonnet-4-5-20250929"), "names the model");
        return true;
      });
    } finally {
      restoreEnv(saved);
    }
  });

  it("boots in real AI mode when the price covers the floor", () => {
    const saved = freshEnv();
    try {
      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.PRICE_USD_CENTS = "20";
      enforceStartupPriceFloor(); // must not throw
    } finally {
      restoreEnv(saved);
    }
  });

  it("does NOT enforce in mock mode (no ANTHROPIC_API_KEY)", () => {
    const saved = freshEnv();
    try {
      process.env.PRICE_USD_CENTS = "1";
      enforceStartupPriceFloor(); // must not throw — $0 mode has no AI cost
    } finally {
      restoreEnv(saved);
    }
  });

  it("throws in real AI mode for an unknown model with no rate overrides", () => {
    const saved = freshEnv();
    try {
      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.ANTHROPIC_MODEL = "claude-mega-9";
      process.env.PRICE_USD_CENTS = "999";
      assert.throws(() => enforceStartupPriceFloor(), /Unknown ANTHROPIC_MODEL/);
    } finally {
      restoreEnv(saved);
    }
  });
});

describe("treasury forward skip (below-forward-fee)", () => {
  it("defaults the forward fee budget to 500_000 tinybars", () => {
    const saved = freshEnv();
    try {
      assert.equal(getForwardFeeTinybars(), 500_000n);
    } finally {
      restoreEnv(saved);
    }
  });

  it("defaults the operator overhead to 1_000_000 tinybars", () => {
    const saved = freshEnv();
    try {
      assert.equal(getOperatorOverheadTinybars(), 1_000_000n);
    } finally {
      restoreEnv(saved);
    }
  });

  it("skips a tiny HBAR share with reason below-forward-fee", async () => {
    const saved = freshEnv();
    try {
      // 2% of 10,000,000 tinybars = 200,000 < 2×500,000 = 1,000,000
      const res = await forwardTreasuryShare({
        amount: "10000000",
        asset: HBAR_ASSET_ID,
        sourceTxId: "0.0.9999@1-mock",
        treasuryAccountId: "0.0.7777",
        dryRun: true,
      });
      assert.equal(res.attempted, false);
      assert.equal(res.reason, "below-forward-fee");
      assert.equal(res.treasuryShareUnits, "200000");
    } finally {
      restoreEnv(saved);
    }
  });

  it("skips a tiny USDC share with reason below-forward-fee", async () => {
    const saved = freshEnv();
    try {
      // 2% of 99,000 base units = 1,980 = $0.00198 < 2×$0.001 fee at $0.20/HBAR
      const res = await forwardTreasuryShare({
        amount: "99000",
        asset: USDC_TESTNET_TOKEN_ID,
        sourceTxId: "0.0.9999@1-mock",
        treasuryAccountId: "0.0.7777",
        dryRun: true,
      });
      assert.equal(res.attempted, false);
      assert.equal(res.reason, "below-forward-fee");
      assert.equal(res.treasuryShareUnits, "1980");
    } finally {
      restoreEnv(saved);
    }
  });

  it("keeps the exact-0 dust skip with reason dust", async () => {
    const saved = freshEnv();
    try {
      const res = await forwardTreasuryShare({
        amount: "1",
        asset: HBAR_ASSET_ID,
        sourceTxId: "0.0.9999@1-mock",
        treasuryAccountId: "0.0.7777",
        dryRun: true,
      });
      assert.equal(res.attempted, false);
      assert.equal(res.reason, "dust");
    } finally {
      restoreEnv(saved);
    }
  });

  it("still forwards normal shares (dry-run, both rails)", async () => {
    const saved = freshEnv();
    try {
      // HBAR: 2% of 100,000,000 = 2,000,000 >= 1,000,000
      const hbar = await forwardTreasuryShare({
        amount: "100000000",
        asset: HBAR_ASSET_ID,
        sourceTxId: "0.0.9999@1-mock",
        treasuryAccountId: "0.0.7777",
        dryRun: true,
      });
      assert.equal(hbar.attempted, true);
      assert.equal(hbar.simulated, true);
      assert.equal(hbar.treasuryShareUnits, "2000000");
      assert.equal(hbar.reason, undefined);

      // USDC: 2% of 1,000,000 ($1) = 20,000 = $0.02 >= $0.002
      const usdc = await forwardTreasuryShare({
        amount: "1000000",
        asset: USDC_TESTNET_TOKEN_ID,
        sourceTxId: "0.0.9999@2-mock",
        treasuryAccountId: "0.0.7777",
        dryRun: true,
      });
      assert.equal(usdc.attempted, true);
      assert.equal(usdc.simulated, true);
      assert.equal(usdc.treasuryShareUnits, "20000");
      assert.equal(usdc.reason, undefined);
    } finally {
      restoreEnv(saved);
    }
  });

  it("splitPayment exactness is unchanged", () => {
    const { operator, treasury } = splitPayment("123456789012345678");
    assert.equal(operator + treasury, 123456789012345678n);
    assert.equal(treasury, 2469135780246913n);
  });
});
