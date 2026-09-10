/**
 * Shared x402 payment configuration for the Vibecode API (Hedera testnet).
 *
 * Wire shapes confirmed against @x402/core@2.25.0 types at build time:
 * - v2 402 body: { x402Version: 2, resource: {...}, accepts: [{ scheme, network,
 *   amount, asset, payTo, maxTimeoutSeconds, extra }] }
 * - Wire headers: PAYMENT-REQUIRED (402 out), PAYMENT-SIGNATURE (buyer in),
 *   PAYMENT-RESPONSE (settle receipt out)
 */

import type { RouteConfig } from "@x402/core/server";

/** CAIP-2 network id for Hedera testnet (x402 hedera scheme). */
export const HEDERA_TESTNET_NETWORK = "hedera:testnet" as const;

/** x402 asset id for native HBAR. */
export const HBAR_ASSET_ID = "0.0.0";

/** Blocky402 testnet facilitator (open access, no API key). */
export const FACILITATOR_URL = "https://api.testnet.blocky402.com";

/**
 * Fee-payer account advertised to the facilitator. Blocky402's testnet
 * fee-payer; the buyer's partial tx is frozen with this account as payer and
 * Blocky402 adds its signature + submits.
 */
export const FEE_PAYER_ACCOUNT = "0.0.7162784";

/**
 * Price math — keep this honest and auditable.
 *
 * 1 HBAR = 100,000,000 tinybars (1e8).
 * Target price: ~$0.01 per vibecode request.
 * At an assumed HBAR price of ~$0.20:
 *   $0.01 = 0.05 HBAR = 0.05 * 1e8 = 5,000,000 tinybars.
 * Override with PRICE_TINYBARS as the market moves.
 */
export const PRICE_TINYBARS: string =
  process.env.PRICE_TINYBARS || "5000000";

/** x402 "exact" scheme name. */
export const SCHEME = "exact" as const;

export function priceInHbar(): string {
  return (Number(PRICE_TINYBARS) / 100_000_000).toString();
}

export function getSellerAccountId(): string {
  const id = process.env.SELLER_ACCOUNT_ID;
  if (!id) throw new Error("SELLER_ACCOUNT_ID is not set (the account receiving payments).");
  return id;
}

/**
 * Platform economics — the Voicescape 98/2 split.
 *
 * Every platform-mediated payment splits 98% to the service operator and
 * 2% to the Voicescape treasury. The x402 "exact" scheme settles a single
 * buyer -> operator transfer, so the operator forwards the 2% on-chain
 * after settlement (see src/treasury.ts). Basis points keep the math exact.
 */
export const TREASURY_FEE_BPS = 200; // 2% = 200 / 10_000

/** Optional: the Voicescape treasury account receiving the 2% platform share. */
export function getTreasuryAccountId(): string | null {
  return process.env.TREASURY_ACCOUNT_ID || null;
}

export interface PaymentSplit {
  /** Tinybars the service operator keeps (98%). */
  operator: bigint;
  /** Tinybars forwarded to the treasury (2%). */
  treasury: bigint;
}

/**
 * Pure, auditable split math. The treasury share rounds DOWN (floor), so
 * any dust stays with the operator — the audit feed records both shares.
 */
export function splitPayment(amountTinybars: string | bigint): PaymentSplit {
  const amount = typeof amountTinybars === "bigint" ? amountTinybars : BigInt(amountTinybars);
  if (amount < 0n) throw new Error("splitPayment: amount cannot be negative");
  const treasury = (amount * BigInt(TREASURY_FEE_BPS)) / 10_000n;
  return { operator: amount - treasury, treasury };
}

/**
 * The route-level payment option served on POST /vibecode.
 *
 * `extra.paymentFlow: "upfront"` forces verify -> settle -> serve ordering,
 * so the (LLM-expensive) handler never runs before the payment has settled
 * on-chain. `extra.feePayer` points the buyer's SDK at Blocky402's account.
 */
export function buildVibecodeRouteConfig(payTo: string): RouteConfig {
  return {
    resource: "https://x402-vibecode.local/vibecode",
    description:
      "Vibecode: AI page-builder for Voicescape. POST { pageJson, instruction } -> { pageJson } (AI-edited).",
    mimeType: "application/json",
    serviceName: "Vibecode x402",
    accepts: {
      scheme: SCHEME,
      payTo,
      network: HEDERA_TESTNET_NETWORK,
      price: { asset: HBAR_ASSET_ID, amount: PRICE_TINYBARS },
      maxTimeoutSeconds: 180,
      extra: {
        feePayer: FEE_PAYER_ACCOUNT,
        paymentFlow: "upfront",
      },
    },
  };
}

/** Decode the base64 PAYMENT-REQUIRED header into a JSON object. */
export function decodePaymentRequiredHeader(header: string): unknown {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

/**
 * Replay hygiene helper: the payload the buyer signed commits to a resource
 * URL. The server should only honor payments whose declared resource matches
 * the endpoint actually called.
 */
export function paymentResourceMatches(
  paymentRequired: unknown,
  expectedUrl: string,
): boolean {
  if (typeof paymentRequired !== "object" || paymentRequired === null) return false;
  const resource = (paymentRequired as { resource?: { url?: unknown } }).resource;
  return typeof resource?.url === "string" && resource.url === expectedUrl;
}
