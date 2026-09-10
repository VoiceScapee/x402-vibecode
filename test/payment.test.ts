/** Payment-requirements construction + 402 header round-trip. No keys needed. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildVibecodeRouteConfig,
  decodePaymentRequiredHeader,
  FEE_PAYER_ACCOUNT,
  HBAR_ASSET_ID,
  HEDERA_TESTNET_NETWORK,
  paymentResourceMatches,
  PRICE_TINYBARS,
  priceInHbar,
} from "../src/payment.js";

describe("payment requirements", () => {
  it("builds exact/HBAR/testnet requirements with the Blocky402 feePayer", () => {
    const cfg = buildVibecodeRouteConfig("0.0.12345");
    const accepts = Array.isArray(cfg.accepts) ? cfg.accepts[0] : cfg.accepts;
    assert.equal(accepts.scheme, "exact");
    assert.equal(accepts.network, HEDERA_TESTNET_NETWORK);
    assert.equal(accepts.payTo, "0.0.12345");
    assert.deepEqual(accepts.price, { asset: HBAR_ASSET_ID, amount: PRICE_TINYBARS });
    assert.equal(accepts.maxTimeoutSeconds, 180);
    assert.equal((accepts.extra as Record<string, string>).feePayer, FEE_PAYER_ACCOUNT);
    // upfront flow: settle BEFORE the (LLM-expensive) handler runs
    assert.equal((accepts.extra as Record<string, string>).paymentFlow, "upfront");
  });

  it("documents the price math (~$0.01 at ~$0.20/HBAR)", () => {
    // 5,000,000 tinybars = 0.05 HBAR
    assert.equal(PRICE_TINYBARS, "5000000");
    assert.equal(priceInHbar(), "0.05");
  });
});

describe("PAYMENT-REQUIRED header", () => {
  it("round-trips base64 JSON", () => {
    const obj = {
      x402Version: 2,
      resource: { url: "http://localhost:3000/vibecode", mimeType: "application/json" },
      accepts: [
        {
          scheme: "exact",
          network: "hedera:testnet",
          amount: "5000000",
          asset: "0.0.0",
          payTo: "0.0.12345",
          maxTimeoutSeconds: 180,
          extra: { feePayer: "0.0.7162784" },
        },
      ],
    };
    const header = Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
    assert.deepEqual(decodePaymentRequiredHeader(header), obj);
  });

  it("validates the resource URL against the called endpoint", () => {
    const good = { resource: { url: "http://localhost:3000/vibecode" } };
    const wrong = { resource: { url: "http://localhost:3000/other" } };
    assert.equal(paymentResourceMatches(good, "http://localhost:3000/vibecode"), true);
    assert.equal(paymentResourceMatches(wrong, "http://localhost:3000/vibecode"), false);
    assert.equal(paymentResourceMatches({}, "http://localhost:3000/vibecode"), false);
    assert.equal(paymentResourceMatches(null, "http://localhost:3000/vibecode"), false);
  });
});
