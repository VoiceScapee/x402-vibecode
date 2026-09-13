/**
 * Hedera network selection for the x402 service (finding 4/HIGH fix).
 *
 * The operator client (treasury 2% forward) and the HCS audit writer must
 * NEVER point at a different network than the one the server advertises in
 * its 402. That used to be hardcoded testnet (Client.forTestnet()); now the
 * network comes from the HEDERA_NETWORK env var:
 *
 *   HEDERA_NETWORK=mainnet    production (real value)
 *   HEDERA_NETWORK=testnet    default — safe for development
 *   HEDERA_NETWORK=previewnet staging
 *
 * SAFETY RULES (enforced here, not by convention):
 *  1. The default is testnet — a bare dev checkout can never hit mainnet.
 *  2. An unrecognized value throws LOUDLY at startup/before first use. It
 *     is NEVER silently replaced by another network: "mainet" (typo) must
 *     crash, not quietly run on testnet while the operator thinks it is on
 *     mainnet (or vice versa). Both failure directions — real money to
 *     testnet, and test config hitting mainnet — are launch blockers, so
 *     the code refuses to guess.
 *  3. The active network is logged every time a client is built, e.g.
 *     "[treasury] x402 operator client: HEDERA_MAINNET", so a log tail
 *     always shows where the money is going.
 */

import { Client, PrivateKey } from "@hiero-ledger/sdk";

/** The only networks this service will ever talk to. */
export const SUPPORTED_HEDERA_NETWORKS = ["mainnet", "testnet", "previewnet"] as const;

export type HederaNetworkName = (typeof SUPPORTED_HEDERA_NETWORKS)[number];

/**
 * The configured Hedera network, validated strictly.
 *
 * Reads HEDERA_NETWORK (case/whitespace-insensitive). Unset -> "testnet".
 * Anything else that isn't one of SUPPORTED_HEDERA_NETWORKS throws —
 * silently falling back would risk forwarding real funds to the wrong
 * network, or pointing a mainnet deploy at testnet while the 402 claims
 * mainnet.
 */
export function hederaNetworkName(): HederaNetworkName {
  const raw = process.env.HEDERA_NETWORK ?? "testnet";
  const name = raw.trim().toLowerCase();
  if (
    name === "mainnet" ||
    name === "testnet" ||
    name === "previewnet"
  ) {
    return name;
  }
  throw new Error(
    `HEDERA_NETWORK must be one of ${SUPPORTED_HEDERA_NETWORKS.join(
      ", ",
    )} (got "${raw}"). Refusing to guess — fix the env var.`,
  );
}

/** CAIP-2 network id used by the x402 "hedera" scheme, e.g. "hedera:mainnet". */
export function hederaNetworkId(): `hedera:${HederaNetworkName}` {
  return `hedera:${hederaNetworkName()}`;
}

/**
 * Parse an operator private key without the deprecated PrivateKey.fromString.
 *
 * The Hiero SDK deprecated the type-sniffing fromString(); the explicit
 * constructors are the supported path. The DER wrapper decides the type —
 * this check MUST come before ECDSA, because fromStringECDSA does not
 * validate the wrapper and would silently misread ED25519 key material as
 * secp256k1 (producing invalid signatures, not an error):
 *   - ED25519 DER (RFC 8410): starts with 302e020100300506032b657004220420
 *   - anything else (ECDSA DER forms, raw 64-char hex) -> ECDSA, the key type
 *     the x402 facilitator flow requires throughout this service.
 */
export function parseOperatorKey(raw: string): PrivateKey {
  const s = raw.trim().toLowerCase();
  if (s.startsWith("302e020100300506032b657004220420")) {
    return PrivateKey.fromStringED25519(raw);
  }
  return PrivateKey.fromStringECDSA(raw);
}

/**
 * Build an SDK client for the CONFIGURED network and make the active
 * network obvious in the logs. Used by both the treasury forwarder and the
 * HCS audit writer so neither can drift back to a hardcoded network.
 */
export function newHederaClient(
  operatorId: string,
  operatorKey: PrivateKey,
  /** Log label, e.g. "treasury" or "audit" — shows up in the log line. */
  label: string,
): Client {
  const name = hederaNetworkName();
  const client = Client.forName(name); // throws for unknown names (defense in depth)
  client.setOperator(operatorId, operatorKey);
  console.log(`[${label}] x402 operator client: HEDERA_${name.toUpperCase()}`);
  return client;
}
