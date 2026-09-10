/**
 * Vibecode x402 — pay-per-request AI page-builder API.
 *
 * POST /vibecode accepts { pageJson, instruction } and returns { pageJson }
 * with the AI-applied edit. Payment is enforced by the x402 protocol on
 * Hedera testnet via the @x402/express middleware:
 *
 *   1. Buyer POSTs without payment            -> 402 + PAYMENT-REQUIRED header
 *   2. Buyer builds a partially-signed HBAR TransferTransaction
 *      (buyer signature only, frozen, Blocky402's feePayer as payer)
 *   3. Buyer retries with PAYMENT-SIGNATURE: base64(paymentPayload)
 *   4. Middleware asks Blocky402 to verify, then settles (submits the tx)
 *   5. ONLY after settlement does the handler run (paymentFlow: "upfront"),
 *      because the Anthropic call is the expensive part
 *   6. Response carries the PAYMENT-RESPONSE settle receipt header
 *
 * Every settled payment is appended to a public HCS topic as an audit feed
 * (see audit.ts) — verifiable via the free mirror node REST API.
 *
 * TESTNET ONLY. Nothing here touches mainnet.
 */

import "dotenv/config";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { AfterSettleHook } from "@x402/core/server";
import { ExactHederaScheme as ExactHederaServerScheme } from "@x402/hedera/exact/server";

import { isValidPage } from "./schema.js";
import { vibecode, VibecodeError } from "./anthropic.js";
import { logSettledPayment } from "./audit.js";
import { forwardTreasuryShare } from "./treasury.js";
import {
  FACILITATOR_URL,
  FEE_PAYER_ACCOUNT,
  HBAR_ASSET_ID,
  HEDERA_TESTNET_NETWORK,
  PRICE_TINYBARS,
  buildVibecodeRouteConfig,
  decodePaymentRequiredHeader,
  getSellerAccountId,
  paymentResourceMatches,
  priceInHbar,
} from "./payment.js";

const PORT = Number(process.env.PORT || 3000);
// The public URL of THIS server. The 402 advertises it as the resource URL and
// the handler re-checks the buyer's payload against it (replay hygiene).
const PUBLIC_URL =
  process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const VIBECODE_RESOURCE_URL = `${PUBLIC_URL}/vibecode`;

const sellerAccountId = getSellerAccountId(); // fails fast if unset

// ---------------------------------------------------------------------------
// x402 wiring
// ---------------------------------------------------------------------------

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

const resourceServer = new x402ResourceServer(facilitator).register(
  HEDERA_TESTNET_NETWORK,
  new ExactHederaServerScheme(),
);

// Post-settlement economics: (1) forward the 2% platform share to the
// treasury on-chain, then (2) log the full payment + split to the HCS audit
// feed. Both are best-effort by design — audit.ts / treasury.ts swallow
// failures so economics can never break a paid request.
const auditHook: AfterSettleHook = async (ctx) => {
  if (!ctx.result.success) return;
  const treasury = await forwardTreasuryShare({
    amountTinybars: ctx.requirements.amount,
    sourceTxId: ctx.result.transaction,
  });
  await logSettledPayment({
    txId: ctx.result.transaction,
    payer: ctx.result.payer ?? "unknown",
    payTo: ctx.requirements.payTo,
    amountTinybars: ctx.requirements.amount,
    asset: ctx.requirements.asset,
    network: ctx.requirements.network,
    endpoint: "/vibecode",
    settledAt: new Date().toISOString(),
    facilitator: FACILITATOR_URL,
    operatorShareTinybars: treasury.operatorShareTinybars,
    treasuryShareTinybars: treasury.treasuryShareTinybars,
    treasuryAccountId: process.env.TREASURY_ACCOUNT_ID ?? null,
    treasuryForwardTxId: treasury.txId,
  });
};
resourceServer.onAfterSettle(auditHook);

const routeConfig = buildVibecodeRouteConfig(sellerAccountId);
routeConfig.resource = VIBECODE_RESOURCE_URL;

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "256kb" }));

// The payment middleware protects only the routes in the config map;
// everything else (/, /health) passes through untouched.
app.use(paymentMiddleware({ "POST /vibecode": routeConfig }, resourceServer));

app.get("/", (_req, res) => {
  res.json({
    service: "Vibecode x402",
    description:
      "Pay-per-request AI page builder for Voicescape. POST { pageJson, instruction } to /vibecode and get back the AI-edited page JSON. No API keys, no accounts — just an x402 HBAR payment per request.",
    network: HEDERA_TESTNET_NETWORK,
    price: {
      tinybars: PRICE_TINYBARS,
      hbar: priceInHbar(),
      note: "~$0.01 at ~$0.20/HBAR; see src/payment.ts for the math",
    },
    asset: HBAR_ASSET_ID,
    payTo: sellerAccountId,
    facilitator: FACILITATOR_URL,
    feePayer: FEE_PAYER_ACCOUNT,
    endpoint: "POST /vibecode",
    auditTopic: process.env.HCS_TOPIC_ID || "(not configured)",
    docs: "See README.md for the full handshake walkthrough.",
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    network: HEDERA_TESTNET_NETWORK,
    priceTinybars: PRICE_TINYBARS,
    facilitator: FACILITATOR_URL,
    seller: sellerAccountId,
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
  });
});

app.post("/vibecode", async (req, res) => {
  // --- Replay hygiene: the payment payload commits to a resource URL.
  // Only honor payments that were minted for THIS endpoint.
  const sigHeader = req.header("PAYMENT-SIGNATURE");
  if (!sigHeader) {
    // Should be unreachable (middleware rejects unpaid requests), but stay safe.
    res.status(402).json({ error: "Payment required (PAYMENT-SIGNATURE missing)." });
    return;
  }
  let declaredResource: unknown = null;
  try {
    declaredResource = decodePaymentRequiredHeader(
      // PAYMENT-SIGNATURE is base64(JSON(paymentPayload)); payload.resource.url echoes the 402's resource.
      sigHeader,
    );
  } catch {
    res.status(400).json({ error: "Could not decode PAYMENT-SIGNATURE header." });
    return;
  }
  if (!paymentResourceMatches(declaredResource, VIBECODE_RESOURCE_URL)) {
    res.status(402).json({
      error: "Payment payload resource mismatch — this payment was not minted for /vibecode.",
    });
    return;
  }

  // --- Body validation (payment already settled: "upfront" flow).
  const { pageJson, instruction } = req.body as {
    pageJson?: unknown;
    instruction?: unknown;
  };
  if (!pageJson || typeof instruction !== "string" || !instruction.trim()) {
    res.status(400).json({
      error: "Request must include pageJson and a non-empty instruction string.",
    });
    return;
  }
  if (!isValidPage(pageJson)) {
    res.status(400).json({ error: "pageJson does not match the Voicescape page schema." });
    return;
  }

  // --- The expensive part: call the AI. Runs only after on-chain settlement.
  try {
    const updated = await vibecode(pageJson, instruction);
    res.json({ pageJson: updated });
  } catch (e) {
    const message = e instanceof VibecodeError ? e.message : "Vibecode failed unexpectedly.";
    // Note: the payment has already settled (upfront flow). We return a clear
    // error rather than burning a retry the buyer can't distinguish.
    res.status(502).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Vibecode x402 listening on :${PORT}`);
  console.log(`  network:     ${HEDERA_TESTNET_NETWORK}`);
  console.log(`  price:       ${PRICE_TINYBARS} tinybars (~${priceInHbar()} HBAR)`);
  console.log(`  payTo:       ${sellerAccountId}`);
  console.log(`  facilitator: ${FACILITATOR_URL} (feePayer ${FEE_PAYER_ACCOUNT})`);
  console.log(`  resource:    ${VIBECODE_RESOURCE_URL}`);
});
