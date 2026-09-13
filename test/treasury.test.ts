/**
 * Unit tests for the Voicescape 98/2 platform split (multi-asset).
 *
 * No keys, no network, no funds — pure math plus env/config behavior of
 * the treasury forwarder (dry-run paths only). The split math is
 * asset-agnostic: it works on base units of whatever asset was paid
 * (tinybars for HBAR, 10^-6 USDC for the USDC rail).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  HBAR_ASSET_ID,
  TREASURY_FEE_BPS,
  getTreasuryAccountId,
  priceTinybars,
  priceUsdcBaseUnits,
  splitPayment,
  USDC_TESTNET_TOKEN_ID,
} from "../src/payment.js";
import { forwardTreasuryShare } from "../src/treasury.js";
import { resetPriceFeed } from "../src/price.js";

describe("98/2 split math", () => {
  it("splits the configured HBAR price exactly: 98% operator / 2% treasury", () => {
    assert.equal(TREASURY_FEE_BPS, 200);
    const { operator, treasury } = splitPayment(priceTinybars());
    assert.equal(operator, 4_900_000n);
    assert.equal(treasury, 100_000n);
    assert.equal(operator + treasury, BigInt(priceTinybars()));
  });

  it("splits a USDC payment exactly, in token base units", () => {
    // 10,000 base units ($0.01): 98% = 9,800, 2% = 200
    const { operator, treasury } = splitPayment(priceUsdcBaseUnits());
    assert.equal(operator, 9_800n);
    assert.equal(treasury, 200n);
    assert.equal(operator + treasury, BigInt(priceUsdcBaseUnits()));
  });

  it("is exact on a large USDC amount", () => {
    // $0.50 -> 500,000 base units: 2% = 10,000 exactly
    const { operator, treasury } = splitPayment("500000");
    assert.equal(treasury, 10_000n);
    assert.equal(operator, 490_000n);
  });

  it("floors the treasury share so dust stays with the operator", () => {
    // 101 * 2% = 2.02 -> floor 2
    const s1 = splitPayment("101");
    assert.equal(s1.treasury, 2n);
    assert.equal(s1.operator, 99n);
    // 1 unit * 2% = 0.02 -> floor 0 (dust, not forwarded)
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
  // NOTE: these dry-run tests set FORWARD_FEE_TINYBARS=0 to disable the
  // below-forward-fee skip (see test/economics.test.ts for the skip rule).
  // At the default 1¢ price the 2% share is worth less than 2x the forward
  // fee budget, so without this override even these dry-runs would skip.
  function withZeroForwardFee(): string | undefined {
    const saved = process.env.FORWARD_FEE_TINYBARS;
    process.env.FORWARD_FEE_TINYBARS = "0";
    return saved;
  }
  function restoreForwardFee(saved: string | undefined): void {
    if (saved === undefined) delete process.env.FORWARD_FEE_TINYBARS;
    else process.env.FORWARD_FEE_TINYBARS = saved;
  }

  it("skips cleanly when the treasury is not configured", async () => {
    const saved = process.env.TREASURY_ACCOUNT_ID;
    delete process.env.TREASURY_ACCOUNT_ID;
    try {
      const res = await forwardTreasuryShare({
        amount: priceTinybars(),
        asset: HBAR_ASSET_ID,
        sourceTxId: "0.0.9999@1-mock",
      });
      assert.equal(res.attempted, false);
      assert.equal(res.reason, "treasury-not-configured");
      assert.equal(res.asset, HBAR_ASSET_ID);
      assert.equal(res.treasuryShareUnits, "100000");
      assert.equal(res.operatorShareUnits, "4900000");
    } finally {
      if (saved !== undefined) process.env.TREASURY_ACCOUNT_ID = saved;
    }
  });

  it("simulates the HBAR forward in dry-run without touching the chain", async () => {
    const fee = withZeroForwardFee();
    try {
      const res = await forwardTreasuryShare({
        amount: priceTinybars(),
        asset: HBAR_ASSET_ID,
        sourceTxId: "0.0.9999@1-mock",
        treasuryAccountId: "0.0.7777",
        dryRun: true,
      });
      assert.equal(res.attempted, true);
      assert.equal(res.simulated, true);
      assert.equal(res.txId, null);
      assert.equal(res.asset, HBAR_ASSET_ID);
      assert.equal(res.treasuryShareUnits, "100000");
      assert.equal(res.operatorShareUnits, "4900000");
    } finally {
      restoreForwardFee(fee);
    }
  });

  it("simulates the USDC forward in dry-run with exact 2% token math", async () => {
    const fee = withZeroForwardFee();
    try {
      const res = await forwardTreasuryShare({
        amount: priceUsdcBaseUnits(), // 10,000 base units = $0.01
        asset: USDC_TESTNET_TOKEN_ID,
        sourceTxId: "0.0.9999@1-mock",
        treasuryAccountId: "0.0.7777",
        dryRun: true,
      });
      assert.equal(res.attempted, true);
      assert.equal(res.simulated, true);
      assert.equal(res.asset, USDC_TESTNET_TOKEN_ID);
      assert.equal(res.treasuryShareUnits, "200"); // exactly 2% of 10,000
      assert.equal(res.operatorShareUnits, "9800");
    } finally {
      restoreForwardFee(fee);
    }
  });

  it("forwards exactly 2% of a larger USDC payment", async () => {
    const res = await forwardTreasuryShare({
      amount: "500000", // $0.50
      asset: USDC_TESTNET_TOKEN_ID,
      sourceTxId: "0.0.9999@2-mock",
      treasuryAccountId: "0.0.7777",
      dryRun: true,
    });
    assert.equal(res.treasuryShareUnits, "10000");
    assert.equal(res.operatorShareUnits, "490000");
  });

  it("skips dust shares without submitting a transfer", async () => {
    const res = await forwardTreasuryShare({
      amount: "1",
      asset: USDC_TESTNET_TOKEN_ID,
      sourceTxId: "0.0.9999@1-mock",
      treasuryAccountId: "0.0.7777",
      dryRun: true,
    });
    assert.equal(res.attempted, false);
    assert.equal(res.reason, "dust");
  });

  it("rejects an unsupported asset", async () => {
    await assert.rejects(
      forwardTreasuryShare({
        amount: "100",
        asset: "0.0.123456",
        sourceTxId: "0.0.9999@1-mock",
        treasuryAccountId: "0.0.7777",
        dryRun: true,
      }),
      /unsupported asset/,
    );
  });

  it("forwards at exactly 2x the fee budget, skips one tinybar below (HBAR rail)", async () => {
    // Default FORWARD_FEE_TINYBARS=500_000 -> skip iff treasury < 1_000_000.
    // amount=50_000_000 -> treasury=floor(50M*200/10000)=1_000_000 (boundary: forward).
    // amount=49_999_999 -> treasury=999_999 (one below: skip).
    const savedFee = process.env.FORWARD_FEE_TINYBARS;
    delete process.env.FORWARD_FEE_TINYBARS;
    try {
      const atBoundary = await forwardTreasuryShare({
        amount: "50000000",
        asset: HBAR_ASSET_ID,
        sourceTxId: "0.0.9999@b1-mock",
        treasuryAccountId: "0.0.7777",
        dryRun: true,
      });
      assert.equal(atBoundary.treasuryShareUnits, "1000000");
      assert.equal(atBoundary.attempted, true);
      assert.equal(atBoundary.simulated, true);

      const belowBoundary = await forwardTreasuryShare({
        amount: "49999999",
        asset: HBAR_ASSET_ID,
        sourceTxId: "0.0.9999@b2-mock",
        treasuryAccountId: "0.0.7777",
        dryRun: true,
      });
      assert.equal(belowBoundary.treasuryShareUnits, "999999");
      assert.equal(belowBoundary.attempted, false);
      assert.equal(belowBoundary.reason, "below-forward-fee");
    } finally {
      if (savedFee !== undefined) process.env.FORWARD_FEE_TINYBARS = savedFee;
    }
  });

  it("forwards at exactly 2x the fee value, skips one base unit below (USDC rail)", async () => {
    // Rate $0.20 (num=20, den=100), fee budget 500_000 tinybars:
    // skip iff T*1e8*100 < 500_000*2*20*1e6 = 2e13  <=>  T < 2000.
    // amount=100_000 -> treasury=2000 (boundary: forward); amount=99_999 -> 1999 (skip).
    resetPriceFeed();
    const savedFee = process.env.FORWARD_FEE_TINYBARS;
    const savedRate = process.env.HBAR_USD_PRICE;
    delete process.env.FORWARD_FEE_TINYBARS;
    delete process.env.HBAR_USD_PRICE;
    try {
      const atBoundary = await forwardTreasuryShare({
        amount: "100000",
        asset: USDC_TESTNET_TOKEN_ID,
        sourceTxId: "0.0.9999@b3-mock",
        treasuryAccountId: "0.0.7777",
        dryRun: true,
      });
      assert.equal(atBoundary.treasuryShareUnits, "2000");
      assert.equal(atBoundary.attempted, true);
      assert.equal(atBoundary.simulated, true);

      const belowBoundary = await forwardTreasuryShare({
        amount: "99999",
        asset: USDC_TESTNET_TOKEN_ID,
        sourceTxId: "0.0.9999@b4-mock",
        treasuryAccountId: "0.0.7777",
        dryRun: true,
      });
      assert.equal(belowBoundary.treasuryShareUnits, "1999");
      assert.equal(belowBoundary.attempted, false);
      assert.equal(belowBoundary.reason, "below-forward-fee");
    } finally {
      if (savedFee !== undefined) process.env.FORWARD_FEE_TINYBARS = savedFee;
      if (savedRate !== undefined) process.env.HBAR_USD_PRICE = savedRate;
      resetPriceFeed();
    }
  });
});
