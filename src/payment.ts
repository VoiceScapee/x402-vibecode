/**
 * Shared x402 payment configuration for the Vibecode API.
 *
 * The Hedera network is driven by HEDERA_NETWORK (see src/network.ts):
 * testnet by default, mainnet when configured. Token selection follows the
 * configured network — the USDC token id is resolved per network, never
 * hardcoded, so a mainnet deploy cannot silently advertise the testnet token
 * (and a testnet deploy cannot advertise the mainnet one).
 *
 * Wire shapes confirmed against @x402/core@2.25.0 types at build time:
 * - v2 402 body: { x402Version: 2, resource: {...}, accepts: [{ scheme, network,
 *   amount, asset, payTo, maxTimeoutSeconds, extra }] }
 * - Wire headers: PAYMENT-REQUIRED (402 out), PAYMENT-SIGNATURE (buyer in),
 *   PAYMENT-RESPONSE (settle receipt out)
 *
 * MULTI-ASSET (Phase B): the 402 advertises TWO payment rails — native HBAR
 * and USDC — and the buyer picks its rail via spend controls. Prices are
 * quoted in USD terms so both rails charge the same dollar price:
 *   - USDC rail: settles 1:1 in token units (6 decimals), exact integer math.
 *   - HBAR rail: converts the USD quote to tinybars at the server-configured
 *     HBAR/USD rate, rounding UP to whole tinybars so the seller is never
 *     shorted.
 */

import type { RouteConfig } from "@x402/core/server";
import { hederaNetworkId, hederaNetworkName } from "./network.js";
import { getActiveRate, parseHbarUsdPrice } from "./price.js";

/** CAIP-2 network id for Hedera testnet (x402 hedera scheme). */
export const HEDERA_TESTNET_NETWORK = "hedera:testnet" as const;

/** CAIP-2 network id for Hedera mainnet (documented for the USDC token id table). */
export const HEDERA_MAINNET_NETWORK = "hedera:mainnet" as const;

/** x402 asset id for native HBAR. */
export const HBAR_ASSET_ID = "0.0.0";

/** USDC on Hedera mainnet (6 decimals). */
export const USDC_MAINNET_TOKEN_ID = "0.0.456858" as const;

/** USDC on Hedera testnet (6 decimals). */
export const USDC_TESTNET_TOKEN_ID = "0.0.429274" as const;

/** USDC decimal places on Hedera (both networks). */
export const USDC_DECIMALS = 6;

/** Tinybars per HBAR. */
export const TINYBARS_PER_HBAR = 100_000_000n;

/**
 * The USDC token id for a given Hedera network. Throws for unknown networks
 * so a misconfiguration can never silently advertise the wrong token.
 */
export function usdcAssetIdForNetwork(network: string): string {
  if (network === HEDERA_TESTNET_NETWORK) return USDC_TESTNET_TOKEN_ID;
  if (network === HEDERA_MAINNET_NETWORK) return USDC_MAINNET_TOKEN_ID;
  throw new Error(`usdcAssetIdForNetwork: no USDC token id for network "${network}"`);
}

/** Buyer-selectable payment rail. */
export type PaymentRail = "HBAR" | "USDC";

export interface RailInfo {
  rail: PaymentRail;
  /** Human label for the asset's base units (tinybars vs USDC base units). */
  unitsLabel: string;
  /** Token id for the USDC rail; null for native HBAR. */
  tokenId: string | null;
}

/** Classify an x402 asset id into its payment rail. Throws on unknown assets. */
export function railForAsset(asset: string): RailInfo {
  if (asset === HBAR_ASSET_ID) return { rail: "HBAR", unitsLabel: "tinybars", tokenId: null };
  if (asset === USDC_TESTNET_TOKEN_ID || asset === USDC_MAINNET_TOKEN_ID) {
    return { rail: "USDC", unitsLabel: "USDC base units", tokenId: asset };
  }
  throw new Error(`railForAsset: unsupported asset "${asset}"`);
}

/** Blocky402's open testnet facilitator. Only valid on testnet. */
const TESTNET_FACILITATOR_URL = "https://api.testnet.blocky402.com";

/** Blocky402's testnet fee-payer account. Only valid on testnet. */
const TESTNET_FEE_PAYER_ACCOUNT = "0.0.7162784";

/**
 * x402 facilitator URL for the configured network.
 *
 * An explicit FACILITATOR_URL env var always wins. On testnet the default is
 * Blocky402's open testnet facilitator. mainnet/previewnet have NO known
 * default — this throws LOUDLY at startup instead of silently settling
 * through the wrong network's facilitator. (Previously the testnet
 * facilitator was hardcoded, so HEDERA_NETWORK=mainnet would advertise
 * mainnet in the 402 while verifying/settling through testnet.)
 */
export function getFacilitatorUrl(): string {
  const explicit = process.env.FACILITATOR_URL?.trim();
  if (explicit) return explicit;
  if (hederaNetworkName() === "testnet") return TESTNET_FACILITATOR_URL;
  throw new Error(
    `FACILITATOR_URL is not set and there is no default x402 facilitator for ` +
      `HEDERA_NETWORK="${process.env.HEDERA_NETWORK}". Set FACILITATOR_URL ` +
      `to a ${hederaNetworkName()} facilitator before taking payments.`,
  );
}

/**
 * Fee-payer account the buyer's partial transaction is frozen with (the
 * facilitator adds its signature and submits). Same fail-fast rules as
 * getFacilitatorUrl: explicit FEE_PAYER_ACCOUNT wins, testnet defaults to
 * Blocky402's testnet fee payer, anything else throws.
 */
export function getFeePayerAccount(): string {
  const explicit = process.env.FEE_PAYER_ACCOUNT?.trim();
  if (explicit) return explicit;
  if (hederaNetworkName() === "testnet") return TESTNET_FEE_PAYER_ACCOUNT;
  throw new Error(
    `FEE_PAYER_ACCOUNT is not set and there is no default fee payer for ` +
      `HEDERA_NETWORK="${process.env.HEDERA_NETWORK}". Set FEE_PAYER_ACCOUNT ` +
      `to the ${hederaNetworkName()} facilitator's fee-payer account.`,
  );
}

/**
 * Optional API key for the facilitator (Blocky402 mainnet requires an
 * X-Api-Key header; testnet is open). Sent on verify/settle/supported when
 * FACILITATOR_API_KEY is set. Never logged.
 */
export function getFacilitatorApiKey(): string | null {
  const key = process.env.FACILITATOR_API_KEY?.trim();
  return key ? key : null;
}

/**
 * Price math — quoted in USD, settled per rail.
 *
 *   PRICE_USD_CENTS  integer USD cents per request (default "1" ~= $0.01)
 *   HBAR_USD_PRICE   operator override for the HBAR/USD rate (default "0.20").
 *                    The live price feed (src/price.ts) refreshes the active
 *                    rate from CoinGecko and falls back to this env var when
 *                    the API is unreachable; until the first refresh, the env
 *                    var (or default) is the active rate.
 *
 * USDC rail: 1 cent = 0.01 USDC = 10_000 base units (6 decimals), so
 *   usdcBaseUnits = usdCents * 10_000 — exact integer math, 1:1 with USD.
 *
 * HBAR rail: tinybars = ceil( (usdCents/100) / hbarUsdPrice * 1e8 ).
 * The ceiling rounds UP to whole tinybars so the seller is never shorted by
 * the conversion. The rate is an exact decimal rational (num/den) and all
 * math is BigInt — no floating point anywhere.
 */
export function getPriceUsdCents(): bigint {
  const raw = process.env.PRICE_USD_CENTS ?? "1";
  if (!/^\d+$/.test(raw)) {
    throw new Error(`PRICE_USD_CENTS must be a non-negative integer (got "${raw}")`);
  }
  return BigInt(raw);
}

/** Parse the HBAR/USD rate into an exact { num, den } rational. */
export function getHbarUsdPrice(): { num: bigint; den: bigint } {
  const raw = process.env.HBAR_USD_PRICE ?? "0.20";
  try {
    return parseHbarUsdPrice(raw);
  } catch {
    throw new Error(`HBAR_USD_PRICE must be a positive decimal number (got "${raw}")`);
  }
}

/**
 * USD cents -> USDC base units. 1 cent = 10_000 base units (6 decimals):
 * $0.50 -> 500_000 base units. Exact integer math.
 */
export function usdCentsToUsdcBaseUnits(usdCents: string | bigint): bigint {
  const cents = typeof usdCents === "bigint" ? usdCents : BigInt(usdCents);
  if (cents < 0n) throw new Error("usdCentsToUsdcBaseUnits: price cannot be negative");
  return cents * 10n ** BigInt(USDC_DECIMALS) / 100n;
}

/**
 * USD cents -> tinybars at the given HBAR/USD rate, rounding UP so the
 * seller is never shorted. Exact BigInt math:
 *   ceil(usdCents * den * 1e8 / (100 * num))
 */
export function usdCentsToTinybars(
  usdCents: string | bigint,
  rate: { num: bigint; den: bigint },
): bigint {
  const cents = typeof usdCents === "bigint" ? usdCents : BigInt(usdCents);
  if (cents < 0n) throw new Error("usdCentsToTinybars: price cannot be negative");
  if (rate.num <= 0n || rate.den <= 0n) throw new Error("usdCentsToTinybars: rate must be positive");
  const a = cents * rate.den * TINYBARS_PER_HBAR;
  const b = 100n * rate.num;
  return (a + b - 1n) / b; // integer ceil
}

/** Current price on the HBAR rail, in tinybars (string). Uses the live price feed when refreshed. */
export function priceTinybars(): string {
  const rate = getActiveRate();
  return usdCentsToTinybars(getPriceUsdCents(), { num: rate.num, den: rate.den }).toString();
}

/** Current price on the USDC rail, in token base units (string). */
export function priceUsdcBaseUnits(): string {
  return usdCentsToUsdcBaseUnits(getPriceUsdCents()).toString();
}

/** Price on the HBAR rail, in HBAR (display only). */
export function priceInHbar(): string {
  return (Number(priceTinybars()) / Number(TINYBARS_PER_HBAR)).toString();
}

/** Price on the USDC rail, in USDC (display only). */
export function priceInUsdc(): string {
  return (Number(priceUsdcBaseUnits()) / 10 ** USDC_DECIMALS).toString();
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
 *
 * The split is asset-agnostic: it operates on base units of whichever asset
 * was paid (tinybars for HBAR, 10^-6 USDC for the USDC rail).
 */
export const TREASURY_FEE_BPS = 200; // 2% = 200 / 10_000

/** Optional: the Voicescape treasury account receiving the 2% platform share. */
export function getTreasuryAccountId(): string | null {
  return process.env.TREASURY_ACCOUNT_ID || null;
}

export interface PaymentSplit {
  /** Base units the service operator keeps (98%). */
  operator: bigint;
  /** Base units forwarded to the treasury (2%). */
  treasury: bigint;
}

/**
 * Pure, auditable split math. The treasury share rounds DOWN (floor), so
 * any dust stays with the operator — the audit feed records both shares.
 */
export function splitPayment(amount: string | bigint): PaymentSplit {
  const value = typeof amount === "bigint" ? amount : BigInt(amount);
  if (value < 0n) throw new Error("splitPayment: amount cannot be negative");
  const treasury = (value * BigInt(TREASURY_FEE_BPS)) / 10_000n;
  return { operator: value - treasury, treasury };
}

/**
 * The route-level payment options served on POST /vibecode.
 *
 * Advertises BOTH rails — native HBAR and USDC — as separate `accepts`
 * entries priced from the same USD quote. The buyer picks its rail via its
 * x402 spend controls; the server honors whichever rail the settled payment
 * arrives on.
 *
 * STALE-RATE FAIL-CLOSED: pass { includeHbarRail: false } to advertise
 * USDC only. The server does this when isHbarRateStale() (see src/price.ts):
 * pricing tinybars at an ancient fallback rate during a prolonged price-feed
 * outage can collect less USD value than the quote while the Anthropic cost
 * stays in USD. USDC pricing is USD-exact, so USDC-only keeps the
 * "never loses money" invariant while the feed is down.
 *
 * `extra.paymentFlow: "upfront"` forces verify -> settle -> serve ordering,
 * so the (LLM-expensive) handler never runs before the payment has settled
 * on-chain. `extra.feePayer` points the buyer's SDK at Blocky402's account.
 */
export function buildVibecodeRouteConfig(
  payTo: string,
  opts: { includeHbarRail?: boolean } = {},
): RouteConfig {
  // The network AND the USDC token id both follow HEDERA_NETWORK (default
  // testnet): usdcAssetIdForNetwork throws for unknown networks, so a
  // misconfiguration can never silently advertise the wrong token.
  const network = hederaNetworkId();
  const usdcAsset = usdcAssetIdForNetwork(network);
  const includeHbarRail = opts.includeHbarRail ?? true;
  const extra = {
    feePayer: getFeePayerAccount(),
    paymentFlow: "upfront",
    // Earliest possible signal to buyers: the standard x402 buyer tooling
    // (and this service's reference client) requires an ECDSA (secp256k1)
    // buyer key. Default HashPack ED25519 accounts fail confusingly
    // client-side — see the buyer key docs in examples/agent-client/README.md.
    buyerKeyType: "ECDSA (secp256k1)",
  };
  const accepts: RouteConfig["accepts"] = [];
  if (includeHbarRail) {
    accepts.push({
      scheme: SCHEME,
      payTo,
      network,
      price: { asset: HBAR_ASSET_ID, amount: priceTinybars() },
      maxTimeoutSeconds: 180,
      extra,
    });
  } else {
    console.warn(
      "[payments] HBAR rail SUSPENDED in the 402 (price feed stale) — advertising USDC only until the live rate recovers",
    );
  }
  accepts.push({
    scheme: SCHEME,
    payTo,
    network,
    price: { asset: usdcAsset, amount: priceUsdcBaseUnits() },
    maxTimeoutSeconds: 180,
    extra,
  });
  return {
    resource: "https://x402-vibecode.local/vibecode",
    description:
      "Vibecode: AI page-builder for Voicescape. POST { pageJson, instruction } -> { pageJson } (AI-edited). " +
      "Buyer keys must be ECDSA (secp256k1); ED25519 keys are not supported by the x402 buyer tooling.",
    mimeType: "application/json",
    serviceName: "Vibecode x402",
    accepts,
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

/** x402 "exact" scheme name. */
export const SCHEME = "exact" as const;
