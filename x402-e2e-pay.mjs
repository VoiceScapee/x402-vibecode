/**
 * x402 builder E2E — paid edit from a TEST page (Bacon the Dino).
 * Brandon: "Go" (2026-09-19) + "You do it" + "Do from one of your test pages".
 * Pays EXACTLY the 402-advertised HBAR amount from the liaison test wallet
 * (0.0.10857765), verifies settlement via the mirror node, saves the edited
 * page JSON. Never blocks on getReceipt (VM hang lesson).
 */
import fs from "node:fs";
import { PrivateKey } from "@hiero-ledger/sdk";
import { createClientHederaSigner } from "@x402/hedera";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

const VIBECODE = "https://voicescape-x402-vibecode.onrender.com/vibecode";
const BUYER = "0.0.10857765";

function loadKey() {
  const raw = fs.readFileSync(
    process.env.HOME + "/workspace/ops/agent-outreach/operator.key", "utf8").trim();
  if (raw.startsWith("302e020100300506032b657004220420")) return PrivateKey.fromStringED25519(raw);
  return PrivateKey.fromStringECDSA(raw);
}

const pageJson = JSON.parse(fs.readFileSync("/tmp/bacon-page.json", "utf8"));
const instruction =
  "TEST EDIT — change ONLY the hero block subtitle to exactly: 'x402 builder test — please ignore'. Do not change anything else.";

console.log("1. probing 402 (unpaid)...");
const unpaid = await fetch(VIBECODE, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ pageJson, instruction }),
});
console.log("   status:", unpaid.status);
if (unpaid.status !== 402) throw new Error(`expected 402, got ${unpaid.status}`);
const terms = JSON.parse(Buffer.from(unpaid.headers.get("PAYMENT-REQUIRED"), "base64").toString("utf8"));
const rail = terms.accepts.find((a) => a.network === "hedera:mainnet" && a.asset === "0.0.0");
if (!rail) throw new Error("no hedera:mainnet HBAR rail in 402 terms");
console.log(`   rail: ${rail.network} asset=${rail.asset} amount=${rail.amount} -> ${rail.payTo}`);
if (rail.amount !== "125000000") throw new Error(`quote changed: ${rail.amount} tinybar, expected 125000000 — refusing`);

console.log("2. paying EXACTLY 125000000 tinybar (1.25 HBAR) from", BUYER);
const buyerKey = loadKey();
const signer = createClientHederaSigner(BUYER, buyerKey, { network: "hedera:mainnet" });
const client = new x402Client()
  .register("hedera:mainnet", new ExactHederaScheme(signer))
  .setSpendControls({
    allowedAssets: [{ network: "hedera:mainnet", asset: rail.asset, maxAmountPerPayment: rail.amount }],
  });
const fetchWithPay = wrapFetchWithPayment(fetch, client);
const paid = await fetchWithPay(VIBECODE, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ pageJson, instruction }),
});
const settleHeader = paid.headers.get("PAYMENT-RESPONSE");
let settleTx = null;
if (settleHeader) {
  try {
    const r = JSON.parse(Buffer.from(settleHeader, "base64").toString("utf8"));
    settleTx = r.transaction; console.log("   settled tx:", settleTx, "payer:", r.payer);
  } catch { console.log("   PAYMENT-RESPONSE present, undecodable"); }
}
const bodyText = await paid.text();
console.log("   paid status:", paid.status);
if (paid.status !== 200) throw new Error(`paid ${paid.status} AFTER settlement: ${bodyText.slice(0, 200)}`);
const data = JSON.parse(bodyText);
if (!data.pageJson || !Array.isArray(data.pageJson.blocks)) throw new Error("invalid pageJson in response");
fs.writeFileSync("/tmp/bacon-page-edited.json", JSON.stringify(data.pageJson, null, 1));
const newSub = data.pageJson.blocks.find((b) => b.type === "hero")?.subtitle;
console.log("   edited hero subtitle:", JSON.stringify(newSub));
console.log("   settle tx for mirror verification:", settleTx);
console.log("E2E-PAY-OK");
