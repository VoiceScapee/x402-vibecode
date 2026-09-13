#!/usr/bin/env npx tsx
/**
 * Buyer agent demo — "Vibecode x402".
 *
 * Simulates an autonomous AI agent that discovers the paid vibecode API,
 * pays per request via the x402 handshake, and consumes the result.
 * No API keys, no accounts on the service side: the 402 IS the auth.
 *
 * The 402 advertises TWO payment rails — native HBAR and USDC, both priced
 * from the same USD quote. The buyer picks its rail with --rail:
 *
 *   npm run demo -- --dry-run --rail usdc  # mock mode, pay on the USDC rail
 *   npm run demo -- --dry-run              # mock mode, pay HBAR (default)
 *   npm run demo                           # live mode: pays real funds on the
 *                                          # configured HEDERA_NETWORK
 *
 * Live mode env:
 *   VIBECODE_URL        base URL of the server (default http://localhost:3000)
 *   BUYER_ACCOUNT_ID    Hedera account on the configured HEDERA_NETWORK, e.g. 0.0.12345
 *   BUYER_PRIVATE_KEY   ECDSA (secp256k1) private key for that account
 *                       (ED25519 keys do NOT work with the x402 tooling)
 * Live USDC mode also requires the buyer account to be associated with the
 * USDC token of the configured network (0.0.429274 on testnet, 0.0.456858 on
 * mainnet) and to hold a balance.
 */

import "dotenv/config";
import { PrivateKey } from "@x402/hedera";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactHederaScheme as ExactHederaClientScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";

import { createStarterPage } from "./schema.js";
import { hederaNetworkId } from "./network.js";
import {
  decodePaymentRequiredHeader,
  HBAR_ASSET_ID,
  getPriceUsdCents,
  priceTinybars,
  priceUsdcBaseUnits,
  railForAsset,
  splitPayment,
  usdcAssetIdForNetwork,
  type PaymentRail,
} from "./payment.js";
import { MOCK_BUYER, startMockStack } from "./mock.js";

const DRY_RUN = process.argv.includes("--dry-run");

/** Which rail the buyer pays on: --rail usdc | --rail hbar (default hbar). */
function railArg(): PaymentRail {
  const idx = process.argv.indexOf("--rail");
  const raw = idx >= 0 ? (process.argv[idx + 1] ?? "").toLowerCase() : "hbar";
  if (raw === "usdc") return "USDC";
  if (raw === "hbar" || raw === "") return "HBAR";
  throw new Error(`--rail must be "hbar" or "usdc" (got "${raw}")`);
}

const RAIL = railArg();
const USDC_ASSET = usdcAssetIdForNetwork(hederaNetworkId());
const CHOSEN_ASSET = RAIL === "USDC" ? USDC_ASSET : HBAR_ASSET_ID;
const CHOSEN_AMOUNT = RAIL === "USDC" ? priceUsdcBaseUnits() : priceTinybars();

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
    console.log(`=== BUYER AGENT DEMO — LIVE MODE (${hederaNetworkId()}, real funds) ===`);
  }
  console.log(`=== buyer rail: ${RAIL} (asset ${CHOSEN_ASSET}) ===`);

  try {
    // --- 1. Discovery: what is this service and what does it cost? ---
    step("1/6", `agent discovers the service: GET ${baseUrl}/`);
    const info = (await (await fetch(`${baseUrl}/`)).json()) as {
      service?: string;
      price?: {
        usdCents?: string;
        hbar?: { tinybars?: string };
        usdc?: { baseUnits?: string; tokenId?: string };
      };
      payTo?: string;
      network?: string;
    };
    console.log(`      service: ${info.service}`);
    console.log(
      `      price:   ${info.price?.usdCents}¢ USD = ${info.price?.hbar?.tinybars} tinybars (HBAR) or ` +
        `${info.price?.usdc?.baseUnits} base units (USDC ${info.price?.usdc?.tokenId}) per request`,
    );
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
    console.log(`      x402 v${paymentRequired.x402Version} — ${paymentRequired.accepts.length} payment rail(s):`);
    for (const terms of paymentRequired.accepts) {
      const rail = railForAsset(terms.asset);
      const chosen = terms.asset === CHOSEN_ASSET ? "  <-- buyer chooses this one" : "";
      console.log(
        `        rail=${rail.rail} asset=${terms.asset} amount=${terms.amount} ${rail.unitsLabel} -> ${terms.payTo}${chosen}`,
      );
    }
    const chosen = paymentRequired.accepts.find((a) => a.asset === CHOSEN_ASSET);
    if (!chosen) {
      throw new Error(`402 does not advertise the ${RAIL} rail (asset ${CHOSEN_ASSET})`);
    }
    console.log(`      resource: ${paymentRequired.resource.url}`);

    // --- 3. Build the payment: partially-signed Hedera transfer ---
    step("3/6", `agent builds the ${RAIL} payment (buyer signature only)...`);
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
      network: hederaNetworkId(),
    });
    console.log(`      signer ready for buyer ${signer.accountId} (tx frozen with facilitator feePayer as payer)`);

    // --- 4. Pay + retry via the x402 fetch wrapper ---
    step("4/6", `agent pays on the ${RAIL} rail and retries with PAYMENT-SIGNATURE...`);
    const client = new x402Client()
      .register(hederaNetworkId(), new ExactHederaClientScheme(signer))
      // The buyer selects its rail by whitelisting ONLY the chosen asset:
      // the x402 client picks the 402's accepted option matching the spend
      // controls. HBAR is not in the SDK's default-asset table (USDC only),
      // so HBAR must be whitelisted explicitly too.
      .setSpendControls({
        allowedAssets: [
          {
            network: hederaNetworkId(),
            asset: CHOSEN_ASSET,
            maxAmountPerPayment: CHOSEN_AMOUNT,
          },
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
    // platform treasury takes 2%, forwarded on-chain after settlement — in
    // the asset that was paid.
    const { operator, treasury } = splitPayment(chosen.amount);
    const rail = railForAsset(chosen.asset);
    console.log(
      `      split:   operator keeps ${operator} ${rail.unitsLabel} (98%) | treasury +${treasury} ${rail.unitsLabel} (2%)` +
        (DRY_RUN ? " (simulated in dry-run)" : ""),
    );

    // --- 6. The goods ---
    step("6/6", "agent receives the AI-edited page JSON:");
    const result = (await paid.json()) as { pageJson: unknown };
    console.log(JSON.stringify(result.pageJson, null, 2).slice(0, 2000));

    console.log(
      `\nDone. One request, one ${RAIL} micropayment of ${getPriceUsdCents()}¢${DRY_RUN ? " (mocked)" : ""}, zero API keys.`,
    );
  } finally {
    if (closeMock) await closeMock();
  }
}

main().catch((e) => {
  console.error("\nDemo failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
