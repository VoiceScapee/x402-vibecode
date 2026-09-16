/**
 * Vibecode x402 — pay-per-request AI page-builder API.
 *
 * POST /vibecode accepts { pageJson, instruction } and returns { pageJson }
 * with the AI-applied edit. Payment is enforced by the x402 protocol on
 * Hedera via the @x402/express middleware (network driven by HEDERA_NETWORK
 * — see src/network.ts; testnet by default, mainnet when configured):
 *
 *   1. Buyer POSTs without payment            -> 402 + PAYMENT-REQUIRED header
 *   2. Buyer builds a partially-signed Hedera TransferTransaction
 *      (buyer signature only, frozen, Blocky402's feePayer as payer) on the
 *      rail it chose — native HBAR or USDC, both advertised in the 402
 *   3. Buyer retries with PAYMENT-SIGNATURE: base64(paymentPayload)
 *   4. Middleware asks Blocky402 to verify, then settles (submits the tx)
 *   5. ONLY after settlement does the handler run (paymentFlow: "upfront"),
 *      because the Anthropic call is the expensive part
 *   6. Response carries the PAYMENT-RESPONSE settle receipt header
 *
 * Every settled payment is appended to a public HCS topic as an audit feed
 * (see audit.ts) — verifiable via the free mirror node REST API.
 */

import "dotenv/config";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { AfterSettleHook } from "@x402/core/server";
import { ExactHederaScheme as ExactHederaServerScheme } from "@x402/hedera/exact/server";

import { isValidPage } from "./schema.js";
import { vibecode, VibecodeError, reviewCopy, CopyReviewError } from "./anthropic.js";
import { buildAuditEntry, logSettledPayment } from "./audit.js";
import { forwardTreasuryShare } from "./treasury.js";
import { hederaNetworkId, hederaNetworkName } from "./network.js";
import {
  buildAgentCard,
  registerAgentCardRoutes,
} from "./agent-card.js";
import { getActiveRate, refreshPriceFeed, startPriceFeed } from "./price.js";
import { getMaxStalenessMs, isHbarRateStale } from "./price.js";
import { enforceStartupPriceFloor } from "./economics.js";
import {
  HBAR_ASSET_ID,
  buildCopyReviewRouteConfig,
  buildVibecodeRouteConfig,
  decodePaymentRequiredHeader,
  getFacilitatorApiKey,
  getFacilitatorUrl,
  getFeePayerAccount,
  getPriceUsdCents,
  getSellerAccountId,
  paymentResourceMatches,
  priceInHbar,
  priceInUsdc,
  priceTinybars,
  priceUsdcBaseUnits,
  usdcAssetIdForNetwork,
} from "./payment.js";

const PORT = Number(process.env.PORT || 3000);
// The public URL of THIS server. The 402 advertises it as the resource URL and
// the handler re-checks the buyer's payload against it (replay hygiene).
const PUBLIC_URL =
  process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const VIBECODE_RESOURCE_URL = `${PUBLIC_URL}/vibecode`;
const COPY_REVIEW_RESOURCE_URL = `${PUBLIC_URL}/copy-review`;

// The Hedera network is validated LOUDLY at startup (throws on garbage,
// never silently falls back) and logged so a log tail always shows where
// real money is going. Default: testnet.
const NETWORK_NAME = hederaNetworkName(); // fails fast on invalid HEDERA_NETWORK
const NETWORK = hederaNetworkId();

const sellerAccountId = getSellerAccountId(); // fails fast if unset
// Danny's (liaison agent's) wallet — receives /copy-review payments.
// Optional at boot: when unset, /copy-review is disabled (503, no 402
// advertised) instead of crashing the whole service — /health, /vibecode
// and the agent card keep working. The fail-fast guard inside
// getCopyReviewSellerAccountId() still throws if anything ever tries to
// build copy-review payment terms without a configured account, so
// danny's revenue can never be silently routed to the vibecode seller.
const copyReviewSellerAccountId: string | null =
  process.env.COPY_REVIEW_SELLER_ACCOUNT_ID?.trim() || null;
if (!copyReviewSellerAccountId) {
  console.warn(
    "[copy-review] COPY_REVIEW_SELLER_ACCOUNT_ID not set — /copy-review disabled (503). Set it to enable danny's paid copy review.",
  );
}
// Hot key for danny's 2% treasury forwards. Optional at boot: without it
// the forward is skipped (reason "operator-key-missing") and danny keeps
// the full payment — best-effort, never breaks a paid request.
const copyReviewSellerPrivateKey = process.env.COPY_REVIEW_SELLER_PRIVATE_KEY?.trim() || null;

// ---------------------------------------------------------------------------
// x402 wiring
// ---------------------------------------------------------------------------

const FACILITATOR_URL = getFacilitatorUrl(); // fails fast when misconfigured
const FEE_PAYER_ACCOUNT = getFeePayerAccount();

// Blocky402 mainnet requires an API key (X-Api-Key header); testnet is
// open. FACILITATOR_API_KEY is optional — when unset, no auth headers are
// sent (correct for testnet, will 401 on mainnet until the key exists).
const facilitatorApiKey = getFacilitatorApiKey();
if (facilitatorApiKey) console.log("[facilitator] API key configured (X-Api-Key will be sent)");
const facilitator = new HTTPFacilitatorClient({
  url: FACILITATOR_URL,
  createAuthHeaders: async () => {
    if (!facilitatorApiKey) return {};
    const h = { "X-Api-Key": facilitatorApiKey };
    return { verify: h, settle: h, supported: h };
  },
});

const resourceServer = new x402ResourceServer(facilitator).register(
  NETWORK,
  new ExactHederaServerScheme(),
);

// Post-settlement economics: (1) forward the 2% platform share to the
// treasury on-chain IN THE ASSET THAT WAS PAID, then (2) log the full
// payment + split to the HCS audit feed. Both are best-effort by design —
// audit.ts / treasury.ts swallow failures so economics can never break a
// paid request.
const auditHook: AfterSettleHook = async (ctx) => {
  if (!ctx.result.success) return;
  // Which endpoint was paid? The payload commits to the 402's resource URL.
  const resourceUrl =
    (ctx.paymentPayload as { resource?: { url?: unknown } }).resource?.url;
  const isCopyReview = typeof resourceUrl === "string" && resourceUrl.endsWith("/copy-review");
  const endpoint = isCopyReview ? "/copy-review" : "/vibecode";
  const treasury = await forwardTreasuryShare({
    amount: ctx.requirements.amount,
    asset: ctx.requirements.asset,
    sourceTxId: ctx.result.transaction,
    endpointLabel: isCopyReview ? "copy-review" : "vibecode",
    // The 2% forward is signed by whoever received the settled payment:
    // danny's key for /copy-review, the SELLER_* env pair for /vibecode.
    // (A /copy-review payment can only settle when the endpoint is
    // configured — no 402 is advertised otherwise — so ?? undefined is
    // unreachable in practice; it only satisfies the type checker.)
    ...(isCopyReview
      ? {
          operatorAccountId: copyReviewSellerAccountId ?? undefined,
          operatorPrivateKey: copyReviewSellerPrivateKey,
        }
      : {}),
  });
  await logSettledPayment(
    buildAuditEntry({
      txId: ctx.result.transaction,
      payer: ctx.result.payer ?? "unknown",
      payTo: ctx.requirements.payTo,
      amountBaseUnits: ctx.requirements.amount,
      asset: ctx.requirements.asset,
      network: ctx.requirements.network,
      endpoint,
      facilitator: FACILITATOR_URL,
      forward: treasury,
      treasuryAccountId: process.env.TREASURY_ACCOUNT_ID ?? null,
    }),
  );
};
resourceServer.onAfterSettle(auditHook);

// Resolve the HBAR/USD rate BEFORE the 402 is built: live feed first,
// HBAR_USD_PRICE env fallback, built-in default last. Never throws — the
// worst case is a degraded (non-live) source, logged by the feed.
// The price feed feeds BOTH the 402 and the economics floor check below.
await refreshPriceFeed();

// Fail fast: never sell below the break-even floor (worst-case AI cost +
// operator overhead). Mock ($0) mode skips the enforcement; real AI mode
// refuses to boot when PRICE_USD_CENTS is too low.
enforceStartupPriceFloor();

// Fail fast on a garbage PRICE_MAX_STALENESS_MS (the HBAR-rail staleness
// bound): a misconfigured bound must not silently disable the fail-closed
// pricing rule. Throws LOUDLY here, before the 402 is built.
const maxStalenessMs = getMaxStalenessMs();
console.log(
  `[price] HBAR rail suspends after ${Math.round(maxStalenessMs / 60_000)} min without a live rate (USDC rail unaffected)`,
);

function hbarRailAvailable(): boolean {
  const stale = isHbarRateStale();
  if (stale) {
    console.warn(
      "[price] price feed stale beyond PRICE_MAX_STALENESS_MS — HBAR rail suspended, 402 is USDC-only until the live rate recovers",
    );
  }
  return !stale;
}

let routeConfig = buildVibecodeRouteConfig(sellerAccountId, {
  includeHbarRail: hbarRailAvailable(),
});
routeConfig.resource = VIBECODE_RESOURCE_URL;

let copyReviewRouteConfig = copyReviewSellerAccountId
  ? buildCopyReviewRouteConfig(copyReviewSellerAccountId, {
      includeHbarRail: hbarRailAvailable(),
    })
  : null;
if (copyReviewRouteConfig) copyReviewRouteConfig.resource = COPY_REVIEW_RESOURCE_URL;

// The payment middleware is rebuilt whenever the price feed refreshes so
// the 402 always advertises a fresh HBAR-rail price; a delegating wrapper
// lets the swap happen without restarting the server.
function paymentRoutes() {
  return {
    "POST /vibecode": routeConfig,
    ...(copyReviewRouteConfig ? { "POST /copy-review": copyReviewRouteConfig } : {}),
  };
}
let paymentMw = paymentMiddleware(paymentRoutes(), resourceServer);
function rebuildPayments(): void {
  routeConfig = buildVibecodeRouteConfig(sellerAccountId, {
    includeHbarRail: hbarRailAvailable(),
  });
  routeConfig.resource = VIBECODE_RESOURCE_URL;
  copyReviewRouteConfig = copyReviewSellerAccountId
    ? buildCopyReviewRouteConfig(copyReviewSellerAccountId, {
        includeHbarRail: hbarRailAvailable(),
      })
    : null;
  if (copyReviewRouteConfig)
    copyReviewRouteConfig.resource = COPY_REVIEW_RESOURCE_URL;
  paymentMw = paymentMiddleware(paymentRoutes(), resourceServer);
  const rate = getActiveRate();
  console.log(
    `[payments] 402 rebuilt: ${priceTinybars()} tinybars (HBAR/USD $${rate.usd}, source=${rate.source})`,
  );
}
startPriceFeed({ onRefresh: () => rebuildPayments() });

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

// Fail closed: without an AI backend there is nothing real to deliver, so
// the paid endpoints must never demand or settle a payment. (The mock
// server in mock.ts is the only place mock edits/reviews are served — a
// localhost dry-run.)
const AI_BACKEND_ENABLED = Boolean(process.env.ANTHROPIC_API_KEY);
const AI_PAID_ROUTES = new Set(["POST /vibecode", "POST /copy-review"]);

const app = express();
app.use(express.json({ limit: "256kb" }));

// The payment middleware protects only the routes in the config map;
// everything else (/, /health) passes through untouched. The wrapper
// indirection is what allows hot-swapping the middleware on price refresh.
app.use((req, res, next) => {
  if (!AI_BACKEND_ENABLED && AI_PAID_ROUTES.has(`${req.method} ${req.path}`)) {
    // No 402, no settlement: serving a mock behind a paywall is forbidden.
    res.status(503).json({
      error:
        "Service unavailable: the AI backend is not configured (ANTHROPIC_API_KEY unset). No payment was requested or settled.",
    });
    return;
  }
  paymentMw(req, res, next);
});

// Machine-readable discovery: A2A agent card (a2a-x402 payment extension)
// at the A2A 1.0 well-known URI + a compat alias. Built per-request from
// live config so prices/rails always match the 402.
registerAgentCardRoutes(app, () =>
  buildAgentCard({
    publicUrl: PUBLIC_URL,
    includeHbarRail: hbarRailAvailable(),
    copyReviewSellerAccountId,
  }),
);

app.get("/", (_req, res) => {
  // The 402 is the authority on which rails accept payment; this listing
  // mirrors it so we never advertise an HBAR price we won't honor (the
  // HBAR rail suspends when the price feed goes stale — see src/price.ts).
  const hbarRail = !isHbarRateStale();
  res.json({
    service: "Vibecode x402",
    description:
      "Pay-per-request AI services for Voicescape blockpages. POST { pageJson, instruction } to /vibecode for an AI page edit" +
      (copyReviewSellerAccountId
        ? "; POST { pageJson, focus? } to /copy-review for danny the liaison agent's structured copy review."
        : ".") +
      " No API keys, no accounts — just an x402 payment per request on the HBAR or USDC rail.",
    network: NETWORK,
    buyerKeyType:
      "ECDSA (secp256k1) — the x402 buyer tooling does not accept ED25519 keys. See examples/agent-client/README.md for the HashPack workaround.",
    price: {
      usdCents: getPriceUsdCents().toString(),
      hbar: hbarRail
        ? { tinybars: priceTinybars(), hbar: priceInHbar() }
        : { suspended: true, reason: "HBAR/USD price feed stale — USDC rail only" },
      hbarUsdSource: getActiveRate().source,
      usdc: {
        baseUnits: priceUsdcBaseUnits(),
        usdc: priceInUsdc(),
        tokenId: usdcAssetIdForNetwork(NETWORK),
      },
      note: "quoted in USD; HBAR rail converts at the live CoinGecko HBAR/USD rate (10-min cache), falling back to HBAR_USD_PRICE then $0.20; rounds UP to whole tinybars so the seller is never shorted",
    },
    assets: hbarRail ? [HBAR_ASSET_ID, usdcAssetIdForNetwork(NETWORK)] : [usdcAssetIdForNetwork(NETWORK)],
    payTo: sellerAccountId,
    copyReviewPayTo: copyReviewSellerAccountId,
    facilitator: FACILITATOR_URL,
    feePayer: FEE_PAYER_ACCOUNT,
    endpoints: copyReviewSellerAccountId
      ? ["POST /vibecode", "POST /copy-review"]
      : ["POST /vibecode"],
    auditTopic: process.env.HCS_TOPIC_ID || "(not configured)",
    docs: "See README.md for the full handshake walkthrough.",
  });
});

app.get("/health", (_req, res) => {
  const rate = getActiveRate();
  res.json({
    status: "ok",
    network: NETWORK,
    priceUsdCents: getPriceUsdCents().toString(),
    priceTinybars: priceTinybars(),
    priceUsdcBaseUnits: priceUsdcBaseUnits(),
    hbarUsdRate: rate.usd,
    hbarUsdSource: rate.source,
    hbarUsdUpdatedAtMs: rate.fetchedAtMs,
    hbarRailSuspended: isHbarRateStale(),
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

  // --- Fail closed: the middleware above must never let a paid request reach
  // here without an AI backend, but if one ever does, refuse rather than
  // serve a mock after the buyer paid.
  if (!AI_BACKEND_ENABLED) {
    console.error(
      "[vibecode] request reached handler without ANTHROPIC_API_KEY — refusing (never serve a mock behind a paywall)",
    );
    res.status(503).json({
      error:
        "Service unavailable: the AI backend is not configured. Contact the operator for a refund.",
    });
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

app.post("/copy-review", async (req, res) => {
  // --- Disabled when unconfigured: no 402 is advertised for this route,
  // so refuse before any payment logic runs (never take money for an
  // endpoint with nowhere to settle it).
  if (!copyReviewSellerAccountId) {
    res.status(503).json({
      error:
        "Service unavailable: /copy-review is not configured (COPY_REVIEW_SELLER_ACCOUNT_ID unset). No payment was requested or settled.",
    });
    return;
  }
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
    declaredResource = decodePaymentRequiredHeader(sigHeader);
  } catch {
    res.status(400).json({ error: "Could not decode PAYMENT-SIGNATURE header." });
    return;
  }
  if (!paymentResourceMatches(declaredResource, COPY_REVIEW_RESOURCE_URL)) {
    res.status(402).json({
      error: "Payment payload resource mismatch — this payment was not minted for /copy-review.",
    });
    return;
  }

  // --- Body validation (payment already settled: "upfront" flow).
  const { pageJson, focus } = req.body as {
    pageJson?: unknown;
    focus?: unknown;
  };
  if (!pageJson) {
    res.status(400).json({ error: "Request must include pageJson." });
    return;
  }
  if (!isValidPage(pageJson)) {
    res.status(400).json({ error: "pageJson does not match the Voicescape page schema." });
    return;
  }
  if (focus !== undefined && (typeof focus !== "string" || !focus.trim())) {
    res.status(400).json({ error: "focus, when provided, must be a non-empty string." });
    return;
  }

  // --- Fail closed: the middleware above must never let a paid request reach
  // here without an AI backend, but if one ever does, refuse rather than
  // serve a mock after the buyer paid.
  if (!AI_BACKEND_ENABLED) {
    console.error(
      "[copy-review] request reached handler without ANTHROPIC_API_KEY — refusing (never serve a mock behind a paywall)",
    );
    res.status(503).json({
      error:
        "Service unavailable: the AI backend is not configured. Contact the operator for a refund.",
    });
    return;
  }
  // --- The expensive part: call the AI. Runs only after on-chain settlement.
  try {
    const review = await reviewCopy(pageJson, typeof focus === "string" ? focus : undefined);
    res.json({ review });
  } catch (e) {
    const message = e instanceof CopyReviewError ? e.message : "Copy review failed unexpectedly.";
    // Note: the payment has already settled (upfront flow). We return a clear
    // error rather than burning a retry the buyer can't distinguish.
    res.status(502).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Vibecode x402 listening on :${PORT}`);
  console.log(`x402 operator client: HEDERA_${NETWORK_NAME.toUpperCase()}`);
  console.log(`  network:     ${NETWORK}`);
  console.log(`  price:       ${getPriceUsdCents()}¢ USD -> ${priceTinybars()} tinybars (HBAR) | ${priceUsdcBaseUnits()} base units (USDC)`);
  console.log(`  payTo:       ${sellerAccountId} (/vibecode)`);
  if (copyReviewSellerAccountId) {
    console.log(`  payTo:       ${copyReviewSellerAccountId} (/copy-review, danny)`);
  } else {
    console.log(`  payTo:       (not configured — /copy-review disabled)`);
  }
  console.log(`  facilitator: ${FACILITATOR_URL} (feePayer ${FEE_PAYER_ACCOUNT})`);
  console.log(`  resources:   ${VIBECODE_RESOURCE_URL}, ${COPY_REVIEW_RESOURCE_URL}`);
});
