import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkRealPayEligibility } from "../examples/agent-client/real-pay.js";

const BASE = {
  serviceName: "Vibecode edit",
  serviceEndpoint: "https://example.com/vibecode",
  priceUsdCents: 25,
  maxPriceUsdCents: 25,
  allowMainnet: false,
};

describe("checkRealPayEligibility", () => {
  it("allows a testnet vibecode service within the price cap", () => {
    assert.equal(
      checkRealPayEligibility({ ...BASE, network: "hedera:testnet" }),
      null,
    );
  });

  it("refuses unknown networks", () => {
    const reason = checkRealPayEligibility({ ...BASE, network: "ethereum:mainnet" });
    assert.match(reason ?? "", /unsupported network/);
  });

  it("refuses mainnet without --allow-mainnet", () => {
    const reason = checkRealPayEligibility({ ...BASE, network: "hedera:mainnet" });
    assert.match(reason ?? "", /--allow-mainnet/);
  });

  it("allows mainnet with --allow-mainnet", () => {
    assert.equal(
      checkRealPayEligibility({ ...BASE, network: "hedera:mainnet", allowMainnet: true }),
      null,
    );
  });

  it("refuses when the price exceeds the cap", () => {
    const reason = checkRealPayEligibility({
      ...BASE,
      network: "hedera:testnet",
      priceUsdCents: 26,
    });
    assert.match(reason ?? "", /exceeds --max-price-usd-cents/);
  });

  it("refuses a missing/NaN price (fail closed)", () => {
    const reason = checkRealPayEligibility({
      ...BASE,
      network: "hedera:testnet",
      priceUsdCents: NaN,
    });
    assert.match(reason ?? "", /exceeds --max-price-usd-cents/);
  });

  it("refuses an unknown service schema (never pay blind)", () => {
    const reason = checkRealPayEligibility({
      ...BASE,
      network: "hedera:testnet",
      serviceName: "Mystery box",
      serviceEndpoint: "https://example.com/mystery",
    });
    assert.match(reason ?? "", /pay blind/);
  });

  it("accepts the vibecode shape by service name too", () => {
    assert.equal(
      checkRealPayEligibility({
        ...BASE,
        network: "hedera:testnet",
        serviceName: "VIBECODE summarizer",
        serviceEndpoint: "https://example.com/api/edit",
      }),
      null,
    );
  });
});
