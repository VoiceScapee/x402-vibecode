/**
 * Payment-requirements construction + 402 header round-trip + USD price math.
 * No keys needed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildVibecodeRouteConfig,
  decodePaymentRequiredHeader,
  getFacilitatorApiKey,
  getFacilitatorUrl,
  getFeePayerAccount,
  getHbarUsdPrice,
  getPriceUsdCents,
  HBAR_ASSET_ID,
  HEDERA_MAINNET_NETWORK,
  HEDERA_TESTNET_NETWORK,
  paymentResourceMatches,
  priceInHbar,
  priceInUsdc,
  priceTinybars,
  priceUsdcBaseUnits,
  railForAsset,
  usdCentsToTinybars,
  usdCentsToUsdcBaseUnits,
  usdcAssetIdForNetwork,
  USDC_MAINNET_TOKEN_ID,
  USDC_TESTNET_TOKEN_ID,
} from "../src/payment.js";

/** Temporarily set env vars for one test, then restore. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k]!;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

describe("payment requirements (multi-asset)", () => {
  it("advertises BOTH rails in the 402 accepts list", () => {
    const cfg = buildVibecodeRouteConfig("0.0.12345");
    const accepts = Array.isArray(cfg.accepts) ? cfg.accepts : [cfg.accepts];
    assert.equal(accepts.length, 2);
    const assets = accepts.map((a) => (a.price as { asset: string }).asset).sort();
    assert.deepEqual(assets, [HBAR_ASSET_ID, USDC_TESTNET_TOKEN_ID].sort());

    for (const a of accepts) {
      assert.equal(a.scheme, "exact");
      assert.equal(a.network, HEDERA_TESTNET_NETWORK);
      assert.equal(a.payTo, "0.0.12345");
      assert.equal(a.maxTimeoutSeconds, 180);
      assert.equal((a.extra as Record<string, string>).feePayer, getFeePayerAccount());
      // upfront flow: settle BEFORE the (LLM-expensive) handler runs
      assert.equal((a.extra as Record<string, string>).paymentFlow, "upfront");
    }
  });

  it("prices both rails from the same USD quote at the defaults", () => {
    // PRICE_USD_CENTS=1, HBAR_USD_PRICE=0.20:
    //   HBAR: ceil(0.01 / 0.20 * 1e8) = 5,000,000 tinybars
    //   USDC: 1 * 10_000 = 10,000 base units
    withEnv({ PRICE_USD_CENTS: undefined, HBAR_USD_PRICE: undefined }, () => {
      const cfg = buildVibecodeRouteConfig("0.0.12345");
      const accepts = cfg.accepts as { price: { asset: string; amount: string } }[];
      const hbar = accepts.find((a) => a.price.asset === HBAR_ASSET_ID)!;
      const usdc = accepts.find((a) => a.price.asset === USDC_TESTNET_TOKEN_ID)!;
      assert.equal(hbar.price.amount, "5000000");
      assert.equal(usdc.price.amount, "10000");
    });
  });

  it("suspends the HBAR rail (USDC-only 402) when includeHbarRail is false", () => {
    const cfg = buildVibecodeRouteConfig("0.0.12345", { includeHbarRail: false });
    const accepts = cfg.accepts as { price: { asset: string; amount: string } }[];
    assert.equal(accepts.length, 1);
    assert.equal(accepts[0].price.asset, USDC_TESTNET_TOKEN_ID);
    assert.equal(accepts[0].price.amount, "10000");
  });

  it("keeps both rails when includeHbarRail is explicitly true", () => {
    const cfg = buildVibecodeRouteConfig("0.0.12345", { includeHbarRail: true });
    const accepts = cfg.accepts as { price: { asset: string; amount: string } }[];
    assert.equal(accepts.length, 2);
    const assets = accepts.map((a) => a.price.asset).sort();
    assert.deepEqual(assets, [HBAR_ASSET_ID, USDC_TESTNET_TOKEN_ID].sort());
  });
});

describe("USD price math", () => {
  it("defaults to 1¢ per request and an HBAR/USD rate of 0.20", () => {
    withEnv({ PRICE_USD_CENTS: undefined, HBAR_USD_PRICE: undefined }, () => {
      assert.equal(getPriceUsdCents(), 1n);
      assert.deepEqual(getHbarUsdPrice(), { num: 20n, den: 100n });
      assert.equal(priceTinybars(), "5000000");
      assert.equal(priceUsdcBaseUnits(), "10000");
      assert.equal(priceInHbar(), "0.05");
      assert.equal(priceInUsdc(), "0.01");
    });
  });

  it("converts USD cents to USDC base units 1:1 (6 decimals, exact)", () => {
    assert.equal(usdCentsToUsdcBaseUnits(1n), 10_000n);
    assert.equal(usdCentsToUsdcBaseUnits("50"), 500_000n); // $0.50 -> 500000
    assert.equal(usdCentsToUsdcBaseUnits(100n), 1_000_000n); // $1.00 -> 1 USDC
    assert.equal(usdCentsToUsdcBaseUnits(0n), 0n);
    assert.throws(() => usdCentsToUsdcBaseUnits(-1n), /negative/);
  });

  it("converts USD cents to tinybars via the env rate, rounding UP", () => {
    // exact: 3¢ @ 0.20 = 0.15 HBAR = 15,000,000 tinybars
    assert.equal(usdCentsToTinybars(3n, { num: 20n, den: 100n }), 15_000_000n);
    // fractional: 1¢ @ 0.30 = 3,333,333.33… tinybars -> ceil 3,333,334
    assert.equal(usdCentsToTinybars(1n, { num: 30n, den: 100n }), 3_333_334n);
    // the ceiling is what keeps the seller from being shorted:
    assert.ok(3_333_334n * 30n >= 1n * 100n * 100_000_000n / 100n);
    assert.equal(usdCentsToTinybars(0n, { num: 20n, den: 100n }), 0n);
    assert.throws(() => usdCentsToTinybars(-1n, { num: 20n, den: 100n }), /negative/);
  });

  it("parses HBAR_USD_PRICE as an exact decimal rational", () => {
    withEnv({ HBAR_USD_PRICE: "0.20" }, () =>
      assert.deepEqual(getHbarUsdPrice(), { num: 20n, den: 100n }));
    withEnv({ HBAR_USD_PRICE: "1.5" }, () =>
      assert.deepEqual(getHbarUsdPrice(), { num: 15n, den: 10n }));
    withEnv({ HBAR_USD_PRICE: "2" }, () =>
      assert.deepEqual(getHbarUsdPrice(), { num: 2n, den: 1n }));
    withEnv({ HBAR_USD_PRICE: "0" }, () =>
      assert.throws(() => getHbarUsdPrice(), /positive/));
    withEnv({ HBAR_USD_PRICE: "abc" }, () =>
      assert.throws(() => getHbarUsdPrice(), /HBAR_USD_PRICE/));
  });

  it("rejects a non-integer PRICE_USD_CENTS", () => {
    withEnv({ PRICE_USD_CENTS: "1.5" }, () =>
      assert.throws(() => getPriceUsdCents(), /PRICE_USD_CENTS/));
    withEnv({ PRICE_USD_CENTS: "-1" }, () =>
      assert.throws(() => getPriceUsdCents(), /PRICE_USD_CENTS/));
  });

  it("recomputes the HBAR rail price when the env rate changes", () => {
    withEnv({ PRICE_USD_CENTS: "1", HBAR_USD_PRICE: "0.10" }, () => {
      // 1¢ @ $0.10 = 0.10 HBAR = 10,000,000 tinybars; USDC rail unchanged
      assert.equal(priceTinybars(), "10000000");
      assert.equal(priceUsdcBaseUnits(), "10000");
    });
  });
});

describe("USDC token ids", () => {
  it("resolves the right USDC token id per network", () => {
    assert.equal(usdcAssetIdForNetwork(HEDERA_TESTNET_NETWORK), USDC_TESTNET_TOKEN_ID);
    assert.equal(usdcAssetIdForNetwork(HEDERA_TESTNET_NETWORK), "0.0.429274");
    assert.equal(usdcAssetIdForNetwork(HEDERA_MAINNET_NETWORK), USDC_MAINNET_TOKEN_ID);
    assert.equal(usdcAssetIdForNetwork(HEDERA_MAINNET_NETWORK), "0.0.456858");
    assert.throws(() => usdcAssetIdForNetwork("hedera:devnet"), /no USDC token id/);
  });

  it("classifies assets into rails", () => {
    assert.deepEqual(railForAsset(HBAR_ASSET_ID), {
      rail: "HBAR",
      unitsLabel: "tinybars",
      tokenId: null,
    });
    assert.deepEqual(railForAsset(USDC_TESTNET_TOKEN_ID), {
      rail: "USDC",
      unitsLabel: "USDC base units",
      tokenId: USDC_TESTNET_TOKEN_ID,
    });
    assert.deepEqual(railForAsset(USDC_MAINNET_TOKEN_ID), {
      rail: "USDC",
      unitsLabel: "USDC base units",
      tokenId: USDC_MAINNET_TOKEN_ID,
    });
    assert.throws(() => railForAsset("0.0.1234"), /unsupported asset/);
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
        {
          scheme: "exact",
          network: "hedera:testnet",
          amount: "10000",
          asset: "0.0.429274",
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

describe("facilitator config (fail-fast per network)", () => {
  it("defaults to Blocky402's testnet facilitator on testnet", () => {
    withEnv(
      { HEDERA_NETWORK: undefined, FACILITATOR_URL: undefined, FEE_PAYER_ACCOUNT: undefined },
      () => {
        assert.equal(getFacilitatorUrl(), "https://api.testnet.blocky402.com");
        assert.equal(getFeePayerAccount(), "0.0.7162784");
      },
    );
  });

  it("explicit env overrides win on any network", () => {
    withEnv(
      {
        HEDERA_NETWORK: "mainnet",
        FACILITATOR_URL: "https://facilitator.example",
        FEE_PAYER_ACCOUNT: "0.0.999",
      },
      () => {
        assert.equal(getFacilitatorUrl(), "https://facilitator.example");
        assert.equal(getFeePayerAccount(), "0.0.999");
      },
    );
  });

  it("throws on mainnet without an explicit facilitator (no silent testnet fallback)", () => {
    withEnv(
      { HEDERA_NETWORK: "mainnet", FACILITATOR_URL: undefined, FEE_PAYER_ACCOUNT: undefined },
      () => {
        assert.throws(() => getFacilitatorUrl(), /FACILITATOR_URL is not set/);
        assert.throws(() => getFeePayerAccount(), /FEE_PAYER_ACCOUNT is not set/);
      },
    );
  });

  it("reads the optional facilitator API key (X-Api-Key for mainnet)", () => {
    withEnv({ FACILITATOR_API_KEY: undefined }, () => {
      assert.equal(getFacilitatorApiKey(), null);
    });
    withEnv({ FACILITATOR_API_KEY: "b402_abc123" }, () => {
      assert.equal(getFacilitatorApiKey(), "b402_abc123");
    });
    withEnv({ FACILITATOR_API_KEY: "   " }, () => {
      assert.equal(getFacilitatorApiKey(), null);
    });
  });
});

describe("buyer key requirement (ECDSA)", () => {
  it("advertises the ECDSA buyer-key requirement in the 402", () => {
    withEnv({ PRICE_USD_CENTS: undefined, HBAR_USD_PRICE: undefined }, () => {
      const cfg = buildVibecodeRouteConfig("0.0.12345");
      assert.match(cfg.description, /ECDSA/);
      for (const a of cfg.accepts as { extra: Record<string, string> }[]) {
        assert.match(a.extra.buyerKeyType, /ECDSA/);
      }
    });
  });
});
