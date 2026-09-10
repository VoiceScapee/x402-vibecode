/**
 * Mock x402 stack for `--dry-run` demos and tests.
 *
 * Spins up, on localhost:
 *  1. a MOCK FACILITATOR (GET /supported, POST /verify, POST /settle) that
 *     approves everything without touching Hedera, and
 *  2. a MOCK RESOURCE SERVER running the REAL @x402/express middleware +
 *     REAL server-side ExactHederaScheme, pointed at the mock facilitator.
 *     Its /vibecode handler returns a deterministic canned "AI edit" instead
 *     of calling Anthropic.
 *
 * This exercises the entire protocol path — 402 issuance, requirement
 * selection, partially-signed Hedera tx construction (signed locally with a
 * throwaway ECDSA key), PAYMENT-SIGNATURE retry, verify -> settle -> serve —
 * with zero keys, zero network, zero HBAR.
 */

import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { AfterSettleHook } from "@x402/core/server";
import { ExactHederaScheme as ExactHederaServerScheme } from "@x402/hedera/exact/server";
import { isValidPage, VoicescapePage } from "./schema.js";
import { forwardTreasuryShare } from "./treasury.js";
import {
  FACILITATOR_URL,
  FEE_PAYER_ACCOUNT,
  HEDERA_TESTNET_NETWORK,
  PRICE_TINYBARS,
  buildVibecodeRouteConfig,
} from "./payment.js";

export const MOCK_FACILITATOR_PORT = 4101;
export const MOCK_RESOURCE_PORT = 4100;
export const MOCK_FACILITATOR_URL = `http://127.0.0.1:${MOCK_FACILITATOR_PORT}`;
export const MOCK_RESOURCE_URL = `http://127.0.0.1:${MOCK_RESOURCE_PORT}`;
export const MOCK_SELLER = "0.0.8888";
export const MOCK_BUYER = "0.0.9999";
export const MOCK_TREASURY = "0.0.7777";

/** Deterministic stand-in for the Anthropic call: recolors the accent. */
export function mockVibecodeEdit(page: VoicescapePage, instruction: string): VoicescapePage {
  return {
    ...page,
    theme: { ...page.theme, accent: "#22d3ee" },
    blocks: [
      ...page.blocks,
      { type: "bio", text: `[mock AI] Applied: ${instruction.slice(0, 120)}` },
    ],
  };
}

function startMockFacilitator(): Promise<import("http").Server> {
  const app = express();
  app.use(express.json());

  app.get("/supported", (_req, res) => {
    res.json({
      kinds: [{ x402Version: 2, scheme: "exact", network: HEDERA_TESTNET_NETWORK }],
      extensions: [],
      signers: {},
    });
  });

  app.post("/verify", (req, res) => {
    const body = req.body as { paymentPayload?: { accepted?: { payTo?: string } } };
    console.log("[mock-facilitator] verify: payment accepted for", body.paymentPayload?.accepted?.payTo);
    res.json({ isValid: true, payer: MOCK_BUYER });
  });

  app.post("/settle", (req, res) => {
    const body = req.body as { paymentPayload?: { accepted?: { payTo?: string; amount?: string } } };
    const accepted = body.paymentPayload?.accepted;
    console.log(
      `[mock-facilitator] settle: ${accepted?.amount} tinybars -> ${accepted?.payTo} (no chain tx in dry-run)`,
    );
    res.json({
      success: true,
      transaction: "0.0.9999@1234567890.000000001-mock",
      network: HEDERA_TESTNET_NETWORK,
      payer: MOCK_BUYER,
    });
  });

  return new Promise((resolve) => {
    const server = app.listen(MOCK_FACILITATOR_PORT, "127.0.0.1", () => {
      console.log(`[mock] facilitator on ${MOCK_FACILITATOR_URL}`);
      resolve(server);
    });
  });
}

function startMockResourceServer(): Promise<import("http").Server> {
  const facilitator = new HTTPFacilitatorClient({ url: MOCK_FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitator).register(
    HEDERA_TESTNET_NETWORK,
    new ExactHederaServerScheme(),
  );

  // Mirror the real server's economics: after (mock) settlement, simulate
  // the 2% treasury forward so the dry-run exercises the split logic too.
  const mockEconomicsHook: AfterSettleHook = async (ctx) => {
    if (!ctx.result.success) return;
    await forwardTreasuryShare({
      amountTinybars: ctx.requirements.amount,
      sourceTxId: ctx.result.transaction,
      treasuryAccountId: MOCK_TREASURY,
      dryRun: true,
    });
  };
  resourceServer.onAfterSettle(mockEconomicsHook);

  const routeConfig = buildVibecodeRouteConfig(MOCK_SELLER);
  routeConfig.resource = `${MOCK_RESOURCE_URL}/vibecode`;
  routeConfig.description = "[MOCK] Vibecode vibecode endpoint (dry-run)";

  const app = express();
  app.use(express.json());
  app.use(paymentMiddleware({ "POST /vibecode": routeConfig }, resourceServer));

  app.get("/", (_req, res) => {
    res.json({
      service: "Vibecode x402",
      description: "[MOCK] Pay-per-request AI page builder (dry-run).",
      network: HEDERA_TESTNET_NETWORK,
      price: { tinybars: PRICE_TINYBARS, hbar: "0.05", note: "mock" },
      asset: "0.0.0",
      payTo: MOCK_SELLER,
      facilitator: MOCK_FACILITATOR_URL,
      feePayer: FEE_PAYER_ACCOUNT,
      endpoint: "POST /vibecode",
      mock: true,
    });
  });

  app.post("/vibecode", (req, res) => {
    const { pageJson, instruction } = req.body as {
      pageJson?: unknown;
      instruction?: unknown;
    };
    if (!isValidPage(pageJson) || typeof instruction !== "string" || !instruction.trim()) {
      res.status(400).json({ error: "pageJson + non-empty instruction required" });
      return;
    }
    // NOTE: the real server calls Anthropic here. The mock applies a
    // deterministic edit so the dry-run needs no API key.
    res.json({ pageJson: mockVibecodeEdit(pageJson, instruction) });
  });

  return new Promise((resolve) => {
    const server = app.listen(MOCK_RESOURCE_PORT, "127.0.0.1", () => {
      console.log(`[mock] resource server on ${MOCK_RESOURCE_URL}`);
      resolve(server);
    });
  });
}

export interface MockStack {
  facilitator: import("http").Server;
  resource: import("http").Server;
  close(): Promise<void>;
}

/** Start mock facilitator first (the resource server syncs to it on boot). */
export async function startMockStack(): Promise<MockStack> {
  const facilitator = await startMockFacilitator();
  const resource = await startMockResourceServer();
  return {
    facilitator,
    resource,
    close: () =>
      new Promise<void>((resolve) => {
        resource.close(() => facilitator.close(() => resolve()));
      }),
  };
}

export function mockStackInfo() {
  return {
    facilitatorUrl: MOCK_FACILITATOR_URL,
    resourceUrl: MOCK_RESOURCE_URL,
    realFacilitator: FACILITATOR_URL,
    feePayer: FEE_PAYER_ACCOUNT,
    priceTinybars: PRICE_TINYBARS,
  };
}
