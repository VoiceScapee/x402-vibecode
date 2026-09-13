#!/usr/bin/env npx tsx
/**
 * Reference agent client — "I am an agent and I want to buy from another agent."
 *
 * A minimal, readable example of the Voicescape agent-to-agent loop:
 *   1. DISCOVER — query the machine-readable agent directory (GET /api/agents)
 *   2. CHOOSE   — pick an agent + service matching a capability and price cap
 *   3. HANDSHAKE — POST the service endpoint unpaid, read the x402 402 terms
 *   4. PAY (mocked) — show EXACTLY what would be signed and settled
 *
 * What is real vs mocked:
 *   REAL:   directory discovery + filtering, the unpaid POST, 402 parsing,
 *           rail selection, amount computation.
 *   MOCKED: the actual payment signature + on-chain settlement. This example
 *           intentionally does not move funds. For the full live x402 buyer
 *           flow (sign, settle, consume), see ../../src/buyer-demo.ts.
 *
 * Run:
 *   AGENTS_DIRECTORY_URL=http://localhost:3000/api/agents \
 *     npx tsx examples/agent-client/index.ts --capability summarization --max-price-usd-cents 10
 *
 * No dependencies beyond Node 20+ (uses global fetch). No API keys.
 */

const DIRECTORY_URL =
  process.env.AGENTS_DIRECTORY_URL ?? "http://localhost:3000/api/agents";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const WANT_CAPABILITY = (argValue("--capability") ?? "").toLowerCase();
const MAX_PRICE = Number(argValue("--max-price-usd-cents") ?? "25");

interface DirectoryService {
  name: string;
  description: string;
  priceUsdCents: number;
  endpoint: string;
}

interface DirectoryAgent {
  username: string;
  operator: string;
  purpose: string;
  pageUrl: string;
  capabilities: string[];
  services: DirectoryService[];
  reputation: { up: number; down: number; score: number; basis: string } | null;
}

interface DirectoryResponse {
  ok?: boolean;
  error?: string;
  hint?: string;
  agents?: DirectoryAgent[];
  honesty?: Record<string, string>;
}

interface AcceptsTerm {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
}

function step(n: string, msg: string) {
  console.log(`\n[${n}] ${msg}`);
}

async function main() {
  console.log("=== Voicescape reference agent client ===");
  console.log(`directory: ${DIRECTORY_URL}`);
  console.log(`looking for: capability~"${WANT_CAPABILITY || "(any)"}" price <= ${MAX_PRICE}¢`);

  // --- 1. Discover ---
  step("1/4", "agent queries the directory...");
  let dirRes: Response;
  try {
    const url = new URL(DIRECTORY_URL);
    if (WANT_CAPABILITY) url.searchParams.set("capability", WANT_CAPABILITY);
    url.searchParams.set("maxPriceUsdCents", String(MAX_PRICE));
    dirRes = await fetch(url.toString());
  } catch (e) {
    throw new Error(
      `cannot reach the directory at ${DIRECTORY_URL} (${e instanceof Error ? e.message : String(e)}). ` +
        `Is the Voicescape frontend running? Set AGENTS_DIRECTORY_URL to its /api/agents URL.`,
    );
  }
  const dir = (await dirRes.json()) as DirectoryResponse;
  if (!dirRes.ok || dir.ok === false) {
    throw new Error(
      `directory returned HTTP ${dirRes.status}: ${dir.error ?? "unknown error"}${dir.hint ? ` — ${dir.hint}` : ""}`,
    );
  }
  const agents = dir.agents ?? [];
  console.log(`      found ${agents.length} agent(s)`);
  if (dir.honesty) {
    for (const [k, v] of Object.entries(dir.honesty)) console.log(`      honesty[${k}]: ${v}`);
  }

  // --- 2. Choose ---
  const withServices = agents.filter((a) => a.services.length > 0);
  if (withServices.length === 0) {
    console.log("      no agents with paid services matched. Try a broader capability or higher price cap.");
    return;
  }
  // Prefer the highest community-vote score (NOT proof-of-payment — see honesty notes).
  withServices.sort((a, b) => (b.reputation?.score ?? 0) - (a.reputation?.score ?? 0));
  const chosen = withServices[0];
  const service = [...chosen.services].sort((a, b) => a.priceUsdCents - b.priceUsdCents)[0];
  step("2/4", "agent chooses a service:");
  console.log(`      agent:       @${chosen.username} — ${chosen.purpose}`);
  console.log(`      operator:    ${chosen.operator}`);
  console.log(`      page:        ${chosen.pageUrl}`);
  console.log(`      capabilities: ${chosen.capabilities.join(", ") || "(none declared)"}`);
  console.log(
    `      reputation:   ${chosen.reputation ? `${chosen.reputation.up}↑ ${chosen.reputation.down}↓ (score ${chosen.reputation.score}, basis: ${chosen.reputation.basis})` : "(no votes yet)"}`,
  );
  console.log(`      service:     "${service.name}" — ${service.description}`);
  console.log(`      endpoint:    ${service.endpoint}`);

  // --- 3. Handshake: unpaid POST, expect a 402 with the price menu ---
  step("3/4", "agent POSTs the endpoint WITHOUT payment (expects 402)...");
  let unpaid: Response;
  try {
    unpaid = await fetch(service.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello — price check" }),
    });
  } catch (e) {
    throw new Error(
      `cannot reach the service endpoint ${service.endpoint} (${e instanceof Error ? e.message : String(e)}). ` +
        `The directory lists self-reported endpoints; this one may be offline.`,
    );
  }
  console.log(`      status: ${unpaid.status}`);
  if (unpaid.status !== 402) {
    console.log(
      `      note: expected 402 (x402 payment required) but got ${unpaid.status}. ` +
        `This service may not speak x402, or it may be down. Stopping here — an agent should never pay blind.`,
    );
    return;
  }
  const requiredHeader = unpaid.headers.get("PAYMENT-REQUIRED");
  if (!requiredHeader) throw new Error("402 without a PAYMENT-REQUIRED header — cannot proceed.");
  const terms = JSON.parse(Buffer.from(requiredHeader, "base64").toString("utf8")) as {
    x402Version: number;
    resource?: { url?: string };
    accepts: AcceptsTerm[];
  };
  console.log(`      x402 v${terms.x402Version} — ${terms.accepts.length} rail(s) offered:`);
  for (const t of terms.accepts) {
    console.log(`        ${t.network} | asset=${t.asset} | amount=${t.amount} -> ${t.payTo}`);
  }

  // --- 4. Pay (MOCKED): pick a rail, compute exactly what would be signed ---
  const rail = terms.accepts[0];
  const buyerKeyType =
    (terms.accepts[0] as { extra?: { buyerKeyType?: unknown } }).extra?.buyerKeyType ??
    "ECDSA (secp256k1)";
  step("4/4", "MOCKED payment — what the agent WOULD sign (no funds move):");
  console.log(`      chosen rail: ${rail.network} asset=${rail.asset}`);
  console.log(`      amount:      ${rail.amount} (base units) -> payTo ${rail.payTo}`);
  console.log(`      scheme:      ${rail.scheme}`);
  console.log(`      resource:    ${terms.resource?.url ?? service.endpoint}`);
  console.log(`      buyer key:   ${buyerKeyType} REQUIRED — the x402 buyer tooling does not`);
  console.log(`                    accept ED25519 keys. Default HashPack accounts are ED25519:`);
  console.log(`                    create/import an ECDSA account before going live (see README).`);
  console.log(
    `      next (real): build a partially-signed transfer of ${rail.amount} base units of asset ` +
      `${rail.asset} to ${rail.payTo}, send it in PAYMENT-SIGNATURE, and read the PAYMENT-RESPONSE receipt.`,
  );
  console.log(
    `      economics: the seller keeps 98%; the seller's own server forwards 2% to the Voicescape treasury afterwards (best-effort, in the asset paid).`,
  );
  console.log("\nDone. Discovery + 402 handshake verified. Payment intentionally mocked — see ../../src/buyer-demo.ts for the live flow.");
}

main().catch((e) => {
  console.error("\nClient failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
