#!/usr/bin/env npx tsx
/**
 * Buyer agent demo — "Vibecode x402".
 *
 * Simulates an autonomous AI agent that discovers the paid vibecode API,
 * pays per request in HBAR via the x402 handshake, and consumes the result.
 * No API keys, no accounts on the service side: the 402 IS the auth.
 *
 *   npm run demo               # live mode: pays real testnet HBAR
 *   npm run demo -- --dry-run  # mock mode: full handshake, no keys, no chain
 *
 * Live mode env:
 *   VIBECODE_URL        base URL of the server (default http://localhost:3000)
 *   BUYER_ACCOUNT_ID    Hedera testnet account, e.g. 0.0.12345
 *   BUYER_PRIVATE_KEY   ECDSA (secp256k1) private key for that account
 *                       (ED25519 keys do NOT work with the x402 tooling)
 */

import "dotenv/config";
import { PrivateKey } from "@x402/hedera";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactHederaScheme as ExactHederaClientScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";

import { createStarterPage } from "./schema.js";
import { decodePaymentRequiredHeader, HEDERA_TESTNET_NETWORK, PRICE_TINYBARS, splitPayment } from "./payment.js";
import { MOCK_BUYER, startMockStack } from "./mock.js";

const DRY_RUN = process.argv.includes("--dry-run");

function step(n: string, msg: string) {
  console.log(`\n[${n}] ${msg}`);
}

function b64json<T>(header: string): T {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as T;
}

async function main() {
  let baseUrl = process.env.VIBECODE_URL || "http://localhost:3000";
  let closeMock: (() => Promise<void>) | null = null;

  if (DRY_RUN) {
    console.log("=== BUYER AGENT DEMO — DRY-RUN MODE (mock facilitator, mock chain) ===");
    const stack = await startMockStack();
    closeMock = () => stack.close();
    baseUrl = "http://127.0.0.1:4100";
  } else {
    console.log("=== BUYER AGENT DEMO — LIVE MODE (Hedera testnet, real HBAR) ===");
  }

  try {
    // --- 1. Discovery: what is this service and what does it cost? ---
    step("1/6", `agent discovers the service: GET ${baseUrl}/`);
    const info = (await (await fetch(`${baseUrl}/`)).json()) as {
      service?: string;
      price?: { tinybars?: string; hbar?: string };
      payTo?: string;
      network?: string;
    };
    console.log(`      service: ${info.service}`);
    console.log(`      price:   ${info.price?.tinybars} tinybars (~${info.price?.hbar} HBAR) per request`);
    console.log(`      payTo:   ${info.payTo} on ${info.network}`);

    // --- 2. Try unpaid: learn the payment terms from the 402 ---
    step("2/6", "agent tries POST /vibecode with NO payment (expects 402)...");
    const unpaid = await fetch(`${baseUrl}/vibecode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageJson: null, instruction: "hello" }),
    });
    console.log(`      status: ${unpaid.status} ${unpaid.status === 402 ? "(payment required, as expected)" : ""}`);
    const requiredHeader = unpaid.headers.get("PAYMENT-REQUIRED");
    if (!requiredHeader || unpaid.status !== 402) {
      throw new Error("expected a 402 with a PAYMENT-REQUIRED header");
    }
    const paymentRequired = decodePaymentRequiredHeader(requiredHeader) as {
      x402Version: number;
      resource: { url: string };
      accepts: { scheme: string; network: string; amount: string; asset: string; payTo: string }[];
    };
    const terms = paymentRequired.accepts[0];
    console.log(`      x402 v${paymentRequired.x402Version} | scheme=${terms.scheme} network=${terms.network}`);
    console.log(`      pay ${terms.amount} tinybars of asset ${terms.asset} -> ${terms.payTo}`);
    console.log(`      resource: ${paymentRequired.resource.url}`);

    // --- 3. Build the payment: partially-signed HBAR transfer ---
    step("3/6", "agent builds the HBAR payment (buyer signature only)...");
    let buyerAccountId: string;
    let buyerKey: PrivateKey;
    if (DRY_RUN) {
      buyerKey = PrivateKey.generateECDSA();
      buyerAccountId = MOCK_BUYER;
      console.log("      (dry-run: throwaway ECDSA key, no real account)");
    } else {
      const id = process.env.BUYER_ACCOUNT_ID;
      const keyStr = process.env.BUYER_PRIVATE_KEY;
      if (!id || !keyStr) {
        throw new Error("live mode needs BUYER_ACCOUNT_ID and BUYER_PRIVATE_KEY env vars");
      }
      buyerAccountId = id;
      try {
        buyerKey = PrivateKey.fromStringECDSA(keyStr);
      } catch {
        throw new Error("BUYER_PRIVATE_KEY must be an ECDSA (secp256k1) key — ED25519 is not supported by x402 tooling");
      }
    }
    const signer = createClientHederaSigner(buyerAccountId, buyerKey, {
      network: HEDERA_TESTNET_NETWORK,
    });
    console.log(`      signer ready for buyer ${signer.accountId} (tx frozen with facilitator feePayer as payer)`);

    // --- 4. Pay + retry via the x402 fetch wrapper ---
    step("4/6", "agent pays and retries with PAYMENT-SIGNATURE...");
    const client = new x402Client()
      .register(HEDERA_TESTNET_NETWORK, new ExactHederaClientScheme(signer))
      // HBAR is not in the SDK's default-asset table (USDC only), so the
      // agent explicitly whitelists it with a per-payment cap of 1 HBAR.
      .setSpendControls({
        allowedAssets: [
          { network: HEDERA_TESTNET_NETWORK, asset: "0.0.0", maxAmountPerPayment: "100000000" },
        ],
      });
    const fetchWithPay = wrapFetchWithPayment(fetch, client);

    const pageJson = createStarterPage("agent");
    const instruction =
      "Make the page feel like a neon arcade: punchy hero subtitle and an arcade-emoji avatar.";
    console.log(`      instruction: "${instruction}"`);

    const paid = await fetchWithPay(`${baseUrl}/vibecode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageJson, instruction }),
    });
    console.log(`      status: ${paid.status}`);
    if (paid.status !== 200) {
      console.log("      body:", (await paid.text()).slice(0, 500));
      throw new Error(`paid request failed with ${paid.status}`);
    }

    // --- 5. Settle receipt + the 98/2 platform split ---
    step("5/6", "agent reads the PAYMENT-RESPONSE settle receipt...");
    const settleHeader = paid.headers.get("PAYMENT-RESPONSE");
    if (settleHeader) {
      const receipt = b64json<{ success: boolean; transaction: string; payer?: string }>(settleHeader);
      console.log(`      settled: ${receipt.success} | tx=${receipt.transaction} | payer=${receipt.payer}`);
    } else {
      console.log("      (no PAYMENT-RESPONSE header present)");
    }
    // Voicescape economics: the operator keeps 98% of every payment and the
    // platform treasury takes 2%, forwarded on-chain after settlement.
    const { operator, treasury } = splitPayment(PRICE_TINYBARS);
    console.log(
      `      split:   operator keeps ${operator} tinybars (98%) | treasury +${treasury} tinybars (2%)` +
        (DRY_RUN ? " (simulated in dry-run)" : ""),
    );

    // --- 6. The goods ---
    step("6/6", "agent receives the AI-edited page JSON:");
    const result = (await paid.json()) as { pageJson: unknown };
    console.log(JSON.stringify(result.pageJson, null, 2).slice(0, 2000));

    console.log(
      `\nDone. One request, one HBAR micropayment${DRY_RUN ? " (mocked)" : ""}, zero API keys.`,
    );
  } finally {
    if (closeMock) await closeMock();
  }
}

main().catch((e) => {
  console.error("\nDemo failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
