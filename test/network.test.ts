/**
 * Hedera network selection (finding 4/HIGH fix) — env-driven, strict.
 *
 * The failure mode under test: the x402 service used to hardcode
 * Client.forTestnet(), so a mainnet deploy would silently forward real
 * value (the 2% treasury forward) and write the HCS audit feed to testnet.
 * These tests pin the replacement contract:
 *   - default is testnet (a bare dev checkout can never hit mainnet),
 *   - garbage HEDERA_NETWORK throws LOUDLY (never silently falls back),
 *   - mainnet selection really yields a mainnet client (ledger id),
 *   - the 402 route config (network id + USDC token) follows the config.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@hiero-ledger/sdk";

import {
  hederaNetworkId,
  hederaNetworkName,
  newHederaClient,
  parseOperatorKey,
} from "../src/network.js";
import {
  buildVibecodeRouteConfig,
  USDC_MAINNET_TOKEN_ID,
  USDC_TESTNET_TOKEN_ID,
} from "../src/payment.js";

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
      else process.env[k] = saved[k]!;
    }
  }
}

describe("hederaNetworkName", () => {
  it("defaults to testnet when HEDERA_NETWORK is unset (safe dev default)", () => {
    withEnv({ HEDERA_NETWORK: undefined }, () => {
      assert.equal(hederaNetworkName(), "testnet");
      assert.equal(hederaNetworkId(), "hedera:testnet");
    });
  });

  it("accepts mainnet, testnet, previewnet (case/whitespace tolerant)", () => {
    withEnv({ HEDERA_NETWORK: "mainnet" }, () => {
      assert.equal(hederaNetworkName(), "mainnet");
      assert.equal(hederaNetworkId(), "hedera:mainnet");
    });
    withEnv({ HEDERA_NETWORK: "testnet" }, () => {
      assert.equal(hederaNetworkName(), "testnet");
    });
    withEnv({ HEDERA_NETWORK: "previewnet" }, () => {
      assert.equal(hederaNetworkName(), "previewnet");
      assert.equal(hederaNetworkId(), "hedera:previewnet");
    });
    withEnv({ HEDERA_NETWORK: "  MainNet  " }, () => {
      assert.equal(hederaNetworkName(), "mainnet");
    });
  });

  it("THROWS on an unrecognized value — never silently falls back", () => {
    for (const bad of ["mainet", "MAIN-NET", "devnet", "", "prod", "mainnet2"]) {
      withEnv({ HEDERA_NETWORK: bad }, () => {
        // A typo like "mainet" must crash, not quietly run on testnet while
        // the operator thinks it is on mainnet (or vice versa).
        assert.throws(() => hederaNetworkName(), /HEDERA_NETWORK/);
      });
    }
  });
});

describe("parseOperatorKey", () => {
  it("parses an ECDSA key without the deprecated fromString", () => {
    const key = PrivateKey.generateECDSA();
    const parsed = parseOperatorKey(key.toString());
    assert.ok(Buffer.from(parsed.toBytes()).equals(Buffer.from(key.toBytes())));
  });

  it("parses an ED25519 key (key-type-agnostic operators keep working)", () => {
    const key = PrivateKey.generateED25519();
    const parsed = parseOperatorKey(key.toString());
    assert.ok(Buffer.from(parsed.toBytes()).equals(Buffer.from(key.toBytes())));
  });

  it("throws on garbage instead of silently producing a key", () => {
    assert.throws(() => parseOperatorKey("not-a-key"), /./);
  });
});

describe("newHederaClient", () => {
  it("yields a REAL mainnet client when HEDERA_NETWORK=mainnet (ledger id check)", () => {
    withEnv({ HEDERA_NETWORK: "mainnet" }, () => {
      const key = PrivateKey.generateECDSA();
      const client = newHederaClient("0.0.12345", key, "test");
      try {
        assert.equal(client.ledgerId.toString(), "mainnet");
      } finally {
        client.close();
      }
    });
  });

  it("yields a testnet client by default (never a mainnet client on a bare checkout)", () => {
    withEnv({ HEDERA_NETWORK: undefined }, () => {
      const key = PrivateKey.generateECDSA();
      const client = newHederaClient("0.0.12345", key, "test");
      try {
        assert.equal(client.ledgerId.toString(), "testnet");
      } finally {
        client.close();
      }
    });
  });
});

describe("route config follows the configured network", () => {
  it("advertises hedera:testnet + the testnet USDC token by default", () => {
    withEnv({ HEDERA_NETWORK: undefined }, () => {
      const cfg = buildVibecodeRouteConfig("0.0.12345");
      const accepts = Array.isArray(cfg.accepts) ? cfg.accepts : [cfg.accepts];
      for (const a of accepts) {
        assert.equal(a.network, "hedera:testnet");
      }
      const assets = accepts.map((a) => (a.price as { asset: string }).asset);
      assert.ok(assets.includes(USDC_TESTNET_TOKEN_ID), "expected testnet USDC token");
      assert.ok(!assets.includes(USDC_MAINNET_TOKEN_ID), "mainnet USDC token must NOT appear on testnet");
    });
  });

  it("advertises hedera:mainnet + the MAINNET USDC token when HEDERA_NETWORK=mainnet", () => {
    withEnv(
      {
        HEDERA_NETWORK: "mainnet",
        // mainnet has no default facilitator — the operator must supply one
        FACILITATOR_URL: "https://facilitator.example",
        FEE_PAYER_ACCOUNT: "0.0.999",
      },
      () => {
        const cfg = buildVibecodeRouteConfig("0.0.12345");
      const accepts = Array.isArray(cfg.accepts) ? cfg.accepts : [cfg.accepts];
      for (const a of accepts) {
        assert.equal(a.network, "hedera:mainnet");
      }
      const assets = accepts.map((a) => (a.price as { asset: string }).asset);
      assert.ok(assets.includes(USDC_MAINNET_TOKEN_ID), "expected mainnet USDC token 0.0.456858");
      assert.ok(!assets.includes(USDC_TESTNET_TOKEN_ID), "testnet USDC token must NOT appear on mainnet");
    });
  });
});
