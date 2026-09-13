/**
 * Audit entry assembly — every settled payment is recorded with the paid
 * asset, both sides of the 98/2 split, the treasury address, and the
 * treasury forward tx id. No keys, no network (buildAuditEntry is pure).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAuditEntry } from "../src/audit.js";
import { forwardTreasuryShare } from "../src/treasury.js";
import {
  HBAR_ASSET_ID,
  HEDERA_TESTNET_NETWORK,
  USDC_TESTNET_TOKEN_ID,
} from "../src/payment.js";

describe("buildAuditEntry", () => {
  it("records an HBAR payment with asset + both shares + treasury forward", async () => {
    const forward = await forwardTreasuryShare({
      amount: "5000000",
      asset: HBAR_ASSET_ID,
      sourceTxId: "0.0.9999@1-mock",
      treasuryAccountId: "0.0.7777",
      dryRun: true,
    });
    const entry = buildAuditEntry({
      txId: "0.0.9999@1-mock",
      payer: "0.0.9999",
      payTo: "0.0.8888",
      amountBaseUnits: "5000000",
      asset: HBAR_ASSET_ID,
      network: HEDERA_TESTNET_NETWORK,
      endpoint: "/vibecode",
      facilitator: "http://mock",
      forward,
      treasuryAccountId: "0.0.7777",
    });

    assert.equal(entry.asset, HBAR_ASSET_ID);
    assert.equal(entry.amountBaseUnits, "5000000");
    assert.equal(entry.operatorShareBaseUnits, "4900000");
    assert.equal(entry.treasuryShareBaseUnits, "100000");
    assert.equal(entry.treasuryAccountId, "0.0.7777");
    assert.equal(entry.treasuryForwardTxId, null); // dry-run: simulated
    assert.equal(entry.payTo, "0.0.8888");
    assert.ok(!Number.isNaN(Date.parse(entry.settledAt)));
  });

  it("records a USDC payment with the token id as asset + both shares", async () => {
    const forward = await forwardTreasuryShare({
      amount: "500000", // $0.50
      asset: USDC_TESTNET_TOKEN_ID,
      sourceTxId: "0.0.9999@2-mock",
      treasuryAccountId: "0.0.7777",
      dryRun: true,
    });
    const entry = buildAuditEntry({
      txId: "0.0.9999@2-mock",
      payer: "0.0.9999",
      payTo: "0.0.8888",
      amountBaseUnits: "500000",
      asset: USDC_TESTNET_TOKEN_ID,
      network: HEDERA_TESTNET_NETWORK,
      endpoint: "/vibecode",
      facilitator: "http://mock",
      forward,
      treasuryAccountId: "0.0.7777",
    });

    assert.equal(entry.asset, USDC_TESTNET_TOKEN_ID);
    assert.equal(entry.amountBaseUnits, "500000");
    assert.equal(entry.operatorShareBaseUnits, "490000");
    assert.equal(entry.treasuryShareBaseUnits, "10000");
    assert.equal(entry.treasuryAccountId, "0.0.7777");
  });
});
