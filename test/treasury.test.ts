/**
 * Unit tests for the Voicescape 98/2 platform split.
 *
 * No keys, no network, no HBAR — pure math plus env/config behavior of
 * the treasury forwarder (dry-run paths only).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PRICE_TINYBARS,
  TREASURY_FEE_BPS,
  getTreasuryAccountId,
  splitPayment,
} from "../src/payment.js";
import { forwardTreasuryShare } from "../src/treasury.js";

describe("98/2 split math", () => {
  it("splits the configured price exactly: 98% operator / 2% treasury", () => {
    assert.equal(TREASURY_FEE_BPS, 200);
    const { operator, treasury } = splitPayment(PRICE_TINYBARS);
    assert.equal(operator, 4_900_000n);
    assert.equal(treasury, 100_000n);
    assert.equal(operator + treasury, BigInt(PRICE_TINYBARS));
  });

  it("floors the treasury share so dust stays with the operator", () => {
    // 101 * 2% = 2.02 -> floor 2
    const s1 = splitPayment("101");
    assert.equal(s1.treasury, 2n);
    assert.equal(s1.operator, 99n);
    // 1 tinybar * 2% = 0.02 -> floor 0 (dust, not forwarded)
    const s2 = splitPayment("1");
    assert.equal(s2.treasury, 0n);
    assert.equal(s2.operator, 1n);
  });

  it("handles zero and rejects negatives", () => {
    const z = splitPayment("0");
    assert.equal(z.operator, 0n);
    assert.equal(z.treasury, 0n);
    assert.throws(() => splitPayment("-1"), /negative/);
  });

  it("is exact on large amounts", () => {
    const { operator, treasury } = splitPayment("123456789012345678");
    assert.equal(operator + treasury, 123456789012345678n);
    assert.equal(treasury, 2469135780246913n); // floor(2%)
  });
});

describe("treasury configuration", () => {
  it("getTreasuryAccountId returns null when unset", () => {
    const saved = process.env.TREASURY_ACCOUNT_ID;
    delete process.env.TREASURY_ACCOUNT_ID;
    try {
      assert.equal(getTreasuryAccountId(), null);
    } finally {
      if (saved !== undefined) process.env.TREASURY_ACCOUNT_ID = saved;
    }
  });
});

describe("forwardTreasuryShare", () => {
  it("skips cleanly when the treasury is not configured", async () => {
    const saved = process.env.TREASURY_ACCOUNT_ID;
    delete process.env.TREASURY_ACCOUNT_ID;
    try {
      const res = await forwardTreasuryShare({
        amountTinybars: PRICE_TINYBARS,
        sourceTxId: "0.0.9999@1-mock",
      });
      assert.equal(res.attempted, false);
      assert.equal(res.reason, "treasury-not-configured");
      assert.equal(res.treasuryShareTinybars, "100000");
      assert.equal(res.operatorShareTinybars, "4900000");
    } finally {
      if (saved !== undefined) process.env.TREASURY_ACCOUNT_ID = saved;
    }
  });

  it("simulates the forward in dry-run without touching the chain", async () => {
    const res = await forwardTreasuryShare({
      amountTinybars: PRICE_TINYBARS,
      sourceTxId: "0.0.9999@1-mock",
      treasuryAccountId: "0.0.7777",
      dryRun: true,
    });
    assert.equal(res.attempted, true);
    assert.equal(res.simulated, true);
    assert.equal(res.txId, null);
    assert.equal(res.treasuryShareTinybars, "100000");
    assert.equal(res.operatorShareTinybars, "4900000");
  });

  it("skips dust shares without submitting a transfer", async () => {
    const res = await forwardTreasuryShare({
      amountTinybars: "1",
      sourceTxId: "0.0.9999@1-mock",
      treasuryAccountId: "0.0.7777",
      dryRun: true,
    });
    assert.equal(res.attempted, false);
    assert.equal(res.reason, "dust");
  });
});
