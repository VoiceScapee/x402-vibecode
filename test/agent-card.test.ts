/**
 * A2A agent card tests — machine-readable discovery for the x402 service.
 *
 * Pins the contract:
 *   - the card carries every required A2A 1.0 AgentCard field (§4.4.1),
 *   - it declares the official a2a-x402 extension as required,
 *   - the payment terms in the extension params EXACTLY match the live 402
 *     route config (same network, payTo, per-rail amounts) — the card can
 *     never advertise a price the 402 won't honor,
 *   - a suspended HBAR rail disappears from the card too,
 *   - both well-known URIs serve the card over HTTP.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createRequire } from "node:module";

import {
  A2A_X402_EXTENSION_URI,
  AGENT_CARD_ALIAS_PATH,
  AGENT_CARD_VERSION,
  AGENT_CARD_WELL_KNOWN_PATH,
  buildAgentCard,
  registerAgentCardRoutes,
  type AgentCard,
} from "../src/agent-card.js";
import {
  buildVibecodeRouteConfig,
  HBAR_ASSET_ID,
  HEDERA_TESTNET_NETWORK,
} from "../src/payment.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/** Temporarily set env vars for one test, then restore. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k]!;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const SELLER = "0.0.12345";
const PUBLIC_URL = "https://example.com";

function card(includeHbarRail = true): AgentCard {
  let c: AgentCard | undefined;
  withEnv(
    { SELLER_ACCOUNT_ID: SELLER, HEDERA_NETWORK: undefined },
    () => {
      c = buildAgentCard({ publicUrl: PUBLIC_URL, includeHbarRail });
    },
  );
  return c!;
}

describe("agent card structure (A2A 1.0 §4.4.1)", () => {
  it("carries every required AgentCard field", () => {
    const c = card();
    assert.ok(c.name.length > 0);
    assert.ok(c.description.length > 0);
    assert.ok(c.provider.organization.length > 0);
    assert.ok(c.version.length > 0);
    assert.ok(c.supportedInterfaces.length > 0);
    const iface = c.supportedInterfaces[0];
    assert.equal(iface.url, PUBLIC_URL);
    assert.equal(iface.protocolBinding, "HTTP+JSON");
    assert.ok(iface.protocolVersion.length > 0);
    assert.ok(Array.isArray(c.defaultInputModes) && c.defaultInputModes.length > 0);
    assert.ok(Array.isArray(c.defaultOutputModes) && c.defaultOutputModes.length > 0);
    assert.ok(Array.isArray(c.skills) && c.skills.length > 0);
    for (const s of c.skills) {
      assert.ok(s.id.length > 0 && s.name.length > 0 && s.description.length > 0);
      assert.ok(Array.isArray(s.tags) && s.tags.length > 0);
    }
  });

  it("version matches package.json (no drift)", () => {
    assert.equal(AGENT_CARD_VERSION, pkg.version);
    assert.equal(card().version, pkg.version);
  });

  it("declares the official a2a-x402 extension as required", () => {
    const exts = card().capabilities.extensions;
    assert.equal(exts.length, 1);
    assert.equal(exts[0].uri, A2A_X402_EXTENSION_URI);
    assert.equal(exts[0].required, true);
    assert.ok(exts[0].description.length > 0);
  });

  it("is honest about the wire protocol (x402 HTTP flow, not A2A JSON-RPC)", () => {
    const text = JSON.stringify(card());
    assert.match(text, /not A2A JSON-RPC message\/send/);
  });
});

describe("payment terms match the live 402", () => {
  it("extension params mirror buildVibecodeRouteConfig exactly", () => {
    withEnv(
      { SELLER_ACCOUNT_ID: SELLER, HEDERA_NETWORK: undefined },
      () => {
        const c = buildAgentCard({ publicUrl: PUBLIC_URL, includeHbarRail: true });
        const params = c.capabilities.extensions[0].params;
        assert.equal(params.x402Version, 2);
        const expected = buildVibecodeRouteConfig(SELLER, { includeHbarRail: true });
        assert.equal(params.accepts.length, expected.accepts.length);
        for (let i = 0; i < expected.accepts.length; i++) {
          const want = expected.accepts[i];
          const got = params.accepts[i];
          assert.equal(got.scheme, "exact");
          assert.equal(got.network, want.network);
          assert.equal(got.network, HEDERA_TESTNET_NETWORK);
          assert.equal(got.asset, want.price.asset);
          assert.equal(got.payTo, want.payTo);
          assert.equal(got.payTo, SELLER);
          assert.equal(got.amount, want.price.amount);
          assert.equal(got.maxTimeoutSeconds, want.maxTimeoutSeconds);
        }
      },
    );
  });

  it("a suspended HBAR rail disappears from the card too", () => {
    const c = card(false);
    const assets = c.capabilities.extensions[0].params.accepts.map((a) => a.asset);
    assert.ok(!assets.includes(HBAR_ASSET_ID), "HBAR rail must be absent when suspended");
    assert.ok(assets.length >= 1, "USDC rail stays advertised");
  });

  it("advertises both rails when the price feed is live", () => {
    const c = card(true);
    const assets = c.capabilities.extensions[0].params.accepts.map((a) => a.asset);
    assert.ok(assets.includes(HBAR_ASSET_ID));
    assert.equal(assets.length, 2);
  });
});

describe("well-known HTTP routes", () => {
  let server: ReturnType<ReturnType<typeof express.listen>> | undefined;
  let port = 0;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    // Hold the env for the server's whole lifetime — the card is built
    // per-request from live config.
    for (const k of ["SELLER_ACCOUNT_ID", "HEDERA_NETWORK"]) saved[k] = process.env[k];
    process.env.SELLER_ACCOUNT_ID = SELLER;
    delete process.env.HEDERA_NETWORK;
    const app = express();
    registerAgentCardRoutes(app, () =>
      buildAgentCard({ publicUrl: PUBLIC_URL, includeHbarRail: true }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        port = (server!.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("serves the identical card at both well-known URIs", async () => {
    const [a, b] = await Promise.all([
      fetch(`http://127.0.0.1:${port}${AGENT_CARD_WELL_KNOWN_PATH}`),
      fetch(`http://127.0.0.1:${port}${AGENT_CARD_ALIAS_PATH}`),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.match(a.headers.get("content-type") ?? "", /application\/json/);
    const ja = (await a.json()) as AgentCard;
    const jb = (await b.json()) as AgentCard;
    assert.deepEqual(ja, jb);
    assert.equal(ja.capabilities.extensions[0].uri, A2A_X402_EXTENSION_URI);
  });
});
