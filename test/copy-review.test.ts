/**
 * Copy-review endpoint tests — danny's paid blockpage copy review.
 *
 *   - route config: both rails advertised, payTo = danny's wallet, amounts
 *     match the shared USD price quote, fail-fast seller env
 *   - reviewCopy(): mocked Anthropic — valid review parses, bad JSON /
 *     off-schema output throws CopyReviewError
 *   - isValidCopyReview: shape validation unit tests
 *   - dry-run handshake on the mock stack: 402 on /copy-review, full paid
 *     flow on the HBAR rail -> 200 + { review } + PAYMENT-RESPONSE receipt
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@x402/hedera";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactHederaScheme as ExactHederaClientScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";

import {
  MOCK_BUYER,
  MOCK_COPY_REVIEW_SELLER,
  MOCK_RESOURCE_URL,
  mockCopyReview,
  startMockStack,
  type MockStack,
} from "../src/mock.js";
import { createStarterPage, isValidPage } from "../src/schema.js";
import {
  CopyReviewError,
  isValidCopyReview,
  reviewCopy,
  type CopyReview,
} from "../src/anthropic.js";
import {
  buildCopyReviewRouteConfig,
  buildVibecodeRouteConfig,
  decodePaymentRequiredHeader,
  getCopyReviewSellerAccountId,
  HBAR_ASSET_ID,
  HEDERA_TESTNET_NETWORK,
  priceTinybars,
  priceUsdcBaseUnits,
  USDC_TESTNET_TOKEN_ID,
} from "../src/payment.js";

const DANNY = "0.0.10857765";

/** Temporarily set env vars for one scope, then restore. */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k]!;
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const GOOD_REVIEW: CopyReview = {
  summary: "Tight page with a clear hook.",
  score: 7,
  strengths: ["Hero says what the page is for in five words."],
  suggestions: [
    { block: "bio", issue: "Lists facts, no hook.", fix: "Open with the outcome visitors get." },
  ],
  rewrittenBio: "I build tiny web3 pages from my phone.",
};

function mockAnthropic(replyText: string, status = 200) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => replyText,
    json: async () => JSON.parse(replyText),
  })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

function anthropicEnvelope(text: string): string {
  return JSON.stringify({ content: [{ type: "text", text }] });
}

describe("copy-review route config", () => {
  it("advertises BOTH rails with danny's payTo at the shared USD price", async () => {
    await withEnv({ HEDERA_NETWORK: undefined }, () => {
      const cfg = buildCopyReviewRouteConfig(DANNY, { includeHbarRail: true });
      const accepts = cfg.accepts as Array<{
        scheme: string;
        network: string;
        payTo: string;
        price: { asset: string; amount: string };
        maxTimeoutSeconds: number;
      }>;
      assert.equal(accepts.length, 2);
      const byAsset = new Map(accepts.map((a) => [a.price.asset, a]));
      const hbar = byAsset.get(HBAR_ASSET_ID)!;
      assert.equal(hbar.scheme, "exact");
      assert.equal(hbar.network, HEDERA_TESTNET_NETWORK);
      assert.equal(hbar.payTo, DANNY);
      assert.equal(hbar.price.amount, priceTinybars());
      const usdc = byAsset.get(USDC_TESTNET_TOKEN_ID)!;
      assert.equal(usdc.payTo, DANNY);
      assert.equal(usdc.price.amount, priceUsdcBaseUnits());
      assert.match(cfg.serviceName ?? "", /copy-review/i);
      assert.match(cfg.description ?? "", /copy-review/i);
    });
  });

  it("suspends the HBAR rail like /vibecode when asked", async () => {
    await withEnv({ HEDERA_NETWORK: undefined }, () => {
      const cfg = buildCopyReviewRouteConfig(DANNY, { includeHbarRail: false });
      const accepts = cfg.accepts as Array<{ price: { asset: string } }>;
      assert.equal(accepts.length, 1);
      assert.equal(accepts[0].price.asset, USDC_TESTNET_TOKEN_ID);
    });
  });

  it("getCopyReviewSellerAccountId fails fast when unset", async () => {
    await withEnv({ COPY_REVIEW_SELLER_ACCOUNT_ID: undefined }, () => {
      assert.throws(() => getCopyReviewSellerAccountId(), /COPY_REVIEW_SELLER_ACCOUNT_ID/);
    });
  });

  it("reads the seller from the environment", async () => {
    await withEnv({ COPY_REVIEW_SELLER_ACCOUNT_ID: DANNY }, () => {
      assert.equal(getCopyReviewSellerAccountId(), DANNY);
    });
  });

  it("is independent of the vibecode seller (no revenue misrouting)", async () => {
    await withEnv({ HEDERA_NETWORK: undefined }, () => {
      const vibecode = buildVibecodeRouteConfig("0.0.1111", { includeHbarRail: true });
      const review = buildCopyReviewRouteConfig(DANNY, { includeHbarRail: true });
      const payTos = (c: { accepts: unknown }) =>
        (c.accepts as Array<{ payTo: string }>).map((a) => a.payTo);
      assert.ok(payTos(vibecode).every((p) => p === "0.0.1111"));
      assert.ok(payTos(review).every((p) => p === DANNY));
    });
  });
});

describe("isValidCopyReview", () => {
  it("accepts a well-formed review", () => {
    assert.equal(isValidCopyReview(GOOD_REVIEW), true);
  });

  it("accepts a review without rewrittenBio", () => {
    const { rewrittenBio: _omit, ...rest } = GOOD_REVIEW;
    assert.equal(isValidCopyReview(rest), true);
  });

  it("rejects bad scores, missing fields, and wrong types", () => {
    assert.equal(isValidCopyReview(null), false);
    assert.equal(isValidCopyReview({ ...GOOD_REVIEW, score: 0 }), false);
    assert.equal(isValidCopyReview({ ...GOOD_REVIEW, score: 11 }), false);
    assert.equal(isValidCopyReview({ ...GOOD_REVIEW, score: 7.5 }), false);
    assert.equal(isValidCopyReview({ ...GOOD_REVIEW, summary: "" }), false);
    assert.equal(isValidCopyReview({ ...GOOD_REVIEW, strengths: ["ok", 42] }), false);
    assert.equal(
      isValidCopyReview({ ...GOOD_REVIEW, suggestions: [{ block: "bio" }] }),
      false,
    );
  });
});

describe("reviewCopy (mocked Anthropic)", () => {
  it("parses a valid review and passes the focus through", async () => {
    const restore = mockAnthropic(anthropicEnvelope(JSON.stringify(GOOD_REVIEW)));
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      seen.push((init as { body: string }).body);
      return realFetch(url as never, init as never);
    }) as unknown as typeof fetch;
    try {
      await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
        const review = await reviewCopy(createStarterPage("danny"), "be harsh");
        assert.deepEqual(review, GOOD_REVIEW);
        assert.match(seen[0], /be harsh/);
        assert.match(seen[0], /"max_tokens":2048/);
      });
    } finally {
      globalThis.fetch = realFetch;
      restore();
    }
  });

  it("throws CopyReviewError when the model returns non-JSON", async () => {
    const restore = mockAnthropic(anthropicEnvelope("not json at all"));
    try {
      await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
        await assert.rejects(
          () => reviewCopy(createStarterPage("danny")),
          (e: unknown) => e instanceof CopyReviewError,
        );
      });
    } finally {
      restore();
    }
  });

  it("throws CopyReviewError when the JSON misses the review schema", async () => {
    const restore = mockAnthropic(anthropicEnvelope(JSON.stringify({ summary: "x" })));
    try {
      await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
        await assert.rejects(
          () => reviewCopy(createStarterPage("danny")),
          /review schema/,
        );
      });
    } finally {
      restore();
    }
  });

  it("throws CopyReviewError without an API key (never silently)", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
      await assert.rejects(
        () => reviewCopy(createStarterPage("danny")),
        /ANTHROPIC_API_KEY/,
      );
    });
  });
});

describe("mockCopyReview (dry-run stand-in)", () => {
  it("returns a valid review shaped like the real one", () => {
    const review = mockCopyReview(createStarterPage("danny"), "tone");
    assert.equal(isValidCopyReview(review), true);
    assert.ok(review.summary.includes("danny"));
  });
});

// ---------------------------------------------------------------------------
// Dry-run handshake on the mock stack
// ---------------------------------------------------------------------------

let stack: MockStack;

before(async () => {
  stack = await startMockStack();
});

after(async () => {
  await stack.close();
});

describe("dry-run handshake for /copy-review", () => {
  it("issues a 402 advertising BOTH rails with the mock danny payTo", async () => {
    const res = await fetch(`${MOCK_RESOURCE_URL}/copy-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageJson: createStarterPage("danny") }),
    });
    assert.equal(res.status, 402);
    const header = res.headers.get("PAYMENT-REQUIRED");
    assert.ok(header, "missing PAYMENT-REQUIRED header");
    const pr = decodePaymentRequiredHeader(header!) as {
      x402Version: number;
      resource: { url: string };
      accepts: Array<{ asset: string; payTo: string; amount: string }>;
    };
    assert.equal(pr.x402Version, 2);
    assert.equal(pr.resource.url, `${MOCK_RESOURCE_URL}/copy-review`);
    assert.equal(pr.accepts.length, 2);
    for (const term of pr.accepts) {
      assert.equal(term.payTo, MOCK_COPY_REVIEW_SELLER);
    }
    const byAsset = new Map(pr.accepts.map((t) => [t.asset, t]));
    assert.equal(byAsset.get(HBAR_ASSET_ID)!.amount, priceTinybars());
    assert.equal(byAsset.get(USDC_TESTNET_TOKEN_ID)!.amount, priceUsdcBaseUnits());
  });

  it("completes the paid flow on the HBAR rail: pay -> settle -> 200 + review", async () => {
    const asset = HBAR_ASSET_ID;
    const amount = priceTinybars();
    const key = PrivateKey.generateECDSA();
    const signer = createClientHederaSigner(MOCK_BUYER, key, {
      network: HEDERA_TESTNET_NETWORK,
    });
    const client = new x402Client()
      .register(HEDERA_TESTNET_NETWORK, new ExactHederaClientScheme(signer))
      .setSpendControls({
        allowedAssets: [
          { network: HEDERA_TESTNET_NETWORK, asset, maxAmountPerPayment: amount },
        ],
      });
    const fetchWithPay = wrapFetchWithPayment(fetch, client);

    const res = await fetchWithPay(`${MOCK_RESOURCE_URL}/copy-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageJson: createStarterPage("danny"), focus: "tone" }),
    });
    assert.equal(res.status, 200);

    const receiptHeader = res.headers.get("PAYMENT-RESPONSE");
    assert.ok(receiptHeader, "missing PAYMENT-RESPONSE settle receipt");
    const receipt = JSON.parse(
      Buffer.from(receiptHeader!, "base64").toString("utf8"),
    ) as { success: boolean; transaction: string };
    assert.equal(receipt.success, true);

    const body = (await res.json()) as { review: unknown };
    assert.equal(isValidCopyReview(body.review), true);
  });

  it("rejects a page that fails schema validation (400, no payment taken)", async () => {
    // Unpaid first: the 402 must still list danny's payTo, proving the
    // route config — not a fallback — serves this endpoint.
    const res = await fetch(`${MOCK_RESOURCE_URL}/copy-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageJson: { nope: true } }),
    });
    assert.equal(res.status, 402);
  });

  it("the /vibecode flow still pays the vibecode seller (no cross-route leak)", async () => {
    const res = await fetch(`${MOCK_RESOURCE_URL}/vibecode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageJson: null, instruction: "x" }),
    });
    assert.equal(res.status, 402);
    const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!) as {
      accepts: Array<{ payTo: string }>;
    };
    for (const term of pr.accepts) {
      assert.notEqual(term.payTo, MOCK_COPY_REVIEW_SELLER);
    }
    assert.ok(isValidPage(createStarterPage("danny")));
  });
});
