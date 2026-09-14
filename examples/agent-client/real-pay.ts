/**
 * --real-pay support for the reference agent client.
 *
 * The default client path is intentionally dependency-free and NEVER moves
 * funds. This module is the opt-in live path: it pays EXACTLY the amount the
 * 402 advertises on the chosen rail, through the full 402 handshake
 * (unpaid POST -> 402 -> sign -> retry with PAYMENT-SIGNATURE -> settle),
 * signed by a real ECDSA buyer key.
 *
 * Refusals (all throw BEFORE any money moves — see checkRealPayEligibility):
 *   - 402 advertises an unknown network
 *   - 402 advertises hedera:mainnet without --allow-mainnet
 *   - directory price exceeds --max-price-usd-cents
 *   - the service is not the vibecode { pageJson, instruction } shape
 *     ("never pay blind": we must know the request schema or the service
 *     would reject the paid request AFTER settlement)
 * Spend controls additionally cap the payment at the 402-quoted amount —
 * the service cannot charge more than the quote.
 */

export interface RealPayRail {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
}

export interface RealPayEligibility {
  /** Network string from the 402 rail, e.g. "hedera:testnet". */
  network: string;
  serviceName: string;
  serviceEndpoint: string;
  /** Self-reported directory price, USD cents. */
  priceUsdCents: number;
  maxPriceUsdCents: number;
  allowMainnet: boolean;
}

/**
 * Pure pre-flight check. Returns null when --real-pay may proceed, otherwise
 * the human-readable refusal reason. No network, no funds, no side effects.
 */
export function checkRealPayEligibility(req: RealPayEligibility): string | null {
  if (!/^hedera:(testnet|mainnet|previewnet)$/.test(req.network)) {
    return `refusing: 402 advertises unsupported network "${req.network}"`;
  }
  if (req.network === "hedera:mainnet" && !req.allowMainnet) {
    return "refusing: 402 advertises hedera:mainnet (real money) — pass --allow-mainnet to proceed";
  }
  if (!(req.priceUsdCents >= 0) || req.priceUsdCents > req.maxPriceUsdCents) {
    return `refusing: service price ${req.priceUsdCents}¢ exceeds --max-price-usd-cents ${req.maxPriceUsdCents}¢`;
  }
  const looksVibecode =
    /\/vibecode\/?$/.test(req.serviceEndpoint) || /vibecode/i.test(req.serviceName);
  if (!looksVibecode) {
    return (
      `refusing: unknown request schema for service "${req.serviceName}" — ` +
      "refusing to pay blind (--real-pay only supports the vibecode { pageJson, instruction } shape)"
    );
  }
  return null;
}

export interface RealPayParams {
  rail: RealPayRail;
  /** The URL to POST the paid request to (the 402's resource URL). */
  resourceUrl: string;
  serviceName: string;
  serviceEndpoint: string;
  priceUsdCents: number;
  maxPriceUsdCents: number;
  allowMainnet: boolean;
}

export async function realPay(params: RealPayParams): Promise<void> {
  const refusal = checkRealPayEligibility({
    network: params.rail.network,
    serviceName: params.serviceName,
    serviceEndpoint: params.serviceEndpoint,
    priceUsdCents: params.priceUsdCents,
    maxPriceUsdCents: params.maxPriceUsdCents,
    allowMainnet: params.allowMainnet,
  });
  if (refusal) throw new Error(`--real-pay ${refusal}`);

  const buyerId = process.env.BUYER_ACCOUNT_ID;
  const buyerKeyStr = process.env.BUYER_PRIVATE_KEY;
  if (!buyerId || !buyerKeyStr) {
    throw new Error(
      "--real-pay needs BUYER_ACCOUNT_ID and BUYER_PRIVATE_KEY env vars " +
        "(ECDSA secp256k1 key for the buyer account — never a treasury/operator key)",
    );
  }

  // Dynamic imports: the default mocked path stays dependency-free; the x402
  // buyer stack loads only when real money is explicitly requested.
  const { PrivateKey, createClientHederaSigner } = await import("@x402/hedera");
  const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
  const { ExactHederaClientScheme } = await import("@x402/hedera/exact/client");
  const { createStarterPage, isValidPage } = await import("../../src/schema.js");

  let buyerKey;
  try {
    buyerKey = PrivateKey.fromStringECDSA(buyerKeyStr);
  } catch {
    throw new Error(
      "BUYER_PRIVATE_KEY must be an ECDSA (secp256k1) key — ED25519 keys do not work with the x402 tooling",
    );
  }

  // The network comes from the 402 terms, never from local env — the client
  // pays on the network the service quoted, not the one the operator assumed.
  // checkRealPayEligibility (run above) guarantees the hedera:<name> shape
  // when it returns null; the cast below only narrows the type for the SDK.
  const network = params.rail.network as `${string}:${string}`;
  const signer = createClientHederaSigner(buyerId, buyerKey, { network });
  const client = new x402Client()
    .register(network, new ExactHederaClientScheme(signer))
    // The buyer whitelists ONLY the chosen asset at EXACTLY the quoted
    // amount: the x402 client cannot be maneuvered into paying more.
    .setSpendControls({
      allowedAssets: [
        { network, asset: params.rail.asset, maxAmountPerPayment: params.rail.amount },
      ],
    });
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  if (params.rail.asset !== "0.0.0") {
    console.log(
      "      note: non-HBAR rail — the buyer account must be ASSOCIATED with the token " +
        "and hold a balance, or settlement fails (see README: first-time USDC buyers).",
    );
  }

  const pageJson = createStarterPage("agent");
  const instruction =
    "Real-pay probe: set the hero subtitle to 'Bought and paid for via x402.'";
  console.log(
    `      paying EXACTLY ${params.rail.amount} base units of asset ${params.rail.asset}`,
  );
  console.log(
    `        -> ${params.rail.payTo} on ${network} ` +
      "(spend controls cap the payment at the 402 quote)",
  );
  console.log(`      buyer: ${signer.accountId}`);

  const paid = await fetchWithPay(params.resourceUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pageJson, instruction }),
  });
  const bodyText = await paid.text();

  // The settle receipt is the refund credential — print it before anything else.
  const settleHeader = paid.headers.get("PAYMENT-RESPONSE");
  if (settleHeader) {
    try {
      const receipt = JSON.parse(
        Buffer.from(settleHeader, "base64").toString("utf8"),
      ) as { transaction?: string; payer?: string };
      console.log(
        `      settled: tx ${receipt.transaction ?? "(see PAYMENT-RESPONSE header)"} ` +
          `payer ${receipt.payer ?? signer.accountId}`,
      );
    } catch {
      console.log("      settled: PAYMENT-RESPONSE header present (could not decode)");
    }
  }

  // Upfront flow: the payment above already settled. A non-200 here means the
  // buyer paid and got an error — say so plainly.
  if (paid.status !== 200) {
    console.log(`      service returned ${paid.status}: ${bodyText.slice(0, 300)}`);
    throw new Error(
      `paid request failed with ${paid.status} AFTER settlement — ` +
        "contact the service operator for a refund (your settle tx is in the PAYMENT-RESPONSE header above)",
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(bodyText) as unknown;
  } catch {
    throw new Error(
      "paid request returned non-JSON after settlement — contact the service operator for a refund",
    );
  }
  if (!isValidPage((data as { pageJson?: unknown }).pageJson)) {
    throw new Error(
      "paid request returned an invalid page after settlement — contact the service operator for a refund",
    );
  }
  console.log("      success: service returned a valid edited page. Payment complete.");
}
