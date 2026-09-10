/**
 * End-to-end dry-run handshake test — no keys, no network, no HBAR.
 *
 * Spins up the mock facilitator + mock resource server (which runs the REAL
 * @x402/express middleware and the REAL server-side ExactHederaScheme), then
 * drives the full buyer flow: 402 -> decode -> build partially-signed Hedera
 * tx (signed locally with a throwaway ECDSA key) -> PAYMENT-SIGNATURE retry
 * -> 200 with valid page JSON + PAYMENT-RESPONSE settle receipt.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@x402/hedera";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactHederaScheme as ExactHederaClientScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";

import {
  MOCK_BUYER,
  MOCK_FACILITATOR_URL,
  MOCK_RESOURCE_URL,
  startMockStack,
  type MockStack,
} from "../src/mock.js";
import { createStarterPage, isValidPage } from "../src/schema.js";
import {
  decodePaymentRequiredHeader,
  HEDERA_TESTNET_NETWORK,
  HBAR_ASSET_ID,
} from "../src/payment.js";

let stack: MockStack;

before(async () => {
  stack = await startMockStack();
});

after(async () => {
  await stack.close();
});

describe("mock facilitator", () => {
  it("advertises exact/hedera:testnet on /supported", async () => {
    const res = await fetch(`${MOCK_FACILITATOR_URL}/supported`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      kinds: { x402Version: number; scheme: string; network: string }[];
    };
    assert.ok(
      body.kinds.some(
        (k) =>
          k.x402Version === 2 && k.scheme === "exact" && k.network === "hedera:testnet",
      ),
      "expected exact/hedera:testnet kind",
    );
  });
});

describe("dry-run handshake", () => {
  it("issues a 402 with a well-formed PAYMENT-REQUIRED header", async () => {
    const res = await fetch(`${MOCK_RESOURCE_URL}/vibecode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageJson: null, instruction: "x" }),
    });
    assert.equal(res.status, 402);
    const header = res.headers.get("PAYMENT-REQUIRED");
    assert.ok(header, "missing PAYMENT-REQUIRED header");
    const pr = decodePaymentRequiredHeader(header!) as {
      x402Version: number;
      resource: { url: string };
      accepts: {
        scheme: string;
        network: string;
        amount: string;
        asset: string;
        payTo: string;
        maxTimeoutSeconds: number;
        extra: { feePayer: string };
      }[];
    };
    assert.equal(pr.x402Version, 2);
    assert.equal(pr.resource.url, `${MOCK_RESOURCE_URL}/vibecode`);
    const terms = pr.accepts[0];
    assert.equal(terms.scheme, "exact");
    assert.equal(terms.network, "hedera:testnet");
    assert.equal(terms.asset, HBAR_ASSET_ID);
    assert.ok(BigInt(terms.amount) > 0n);
    assert.match(terms.payTo, /^0\.0\.\d+$/);
    assert.ok(terms.extra.feePayer, "feePayer missing from extra");
  });

  it("completes the paid flow: pay -> settle -> 200 + valid page JSON", async () => {
    const key = PrivateKey.generateECDSA();
    const signer = createClientHederaSigner(MOCK_BUYER, key, {
      network: HEDERA_TESTNET_NETWORK,
    });
    const client = new x402Client()
      .register(HEDERA_TESTNET_NETWORK, new ExactHederaClientScheme(signer))
      .setSpendControls({
        allowedAssets: [
          { network: HEDERA_TESTNET_NETWORK, asset: "0.0.0", maxAmountPerPayment: "100000000" },
        ],
      });
    const fetchWithPay = wrapFetchWithPayment(fetch, client);

    const res = await fetchWithPay(`${MOCK_RESOURCE_URL}/vibecode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pageJson: createStarterPage("test-agent"),
        instruction: "make it neon",
      }),
    });
    assert.equal(res.status, 200);

    const receiptHeader = res.headers.get("PAYMENT-RESPONSE");
    assert.ok(receiptHeader, "missing PAYMENT-RESPONSE settle receipt");
    const receipt = JSON.parse(
      Buffer.from(receiptHeader!, "base64").toString("utf8"),
    ) as { success: boolean; transaction: string };
    assert.equal(receipt.success, true);
    assert.ok(receipt.transaction.length > 0);

    const body = (await res.json()) as { pageJson: unknown };
    assert.equal(isValidPage(body.pageJson), true);
  });
});
