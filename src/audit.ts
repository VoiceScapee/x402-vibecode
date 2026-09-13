/**
 * HCS audit feed: one Hedera Consensus Service message per settled payment.
 *
 * Verifiable by anyone via the free mirror node REST API on the configured
 * network, e.g.:
 *   https://testnet.mirrornode.hedera.com/api/v1/topics/<HCS_TOPIC_ID>/messages
 * (use https://mainnet.mirrornode.hedera.com when HEDERA_NETWORK=mainnet).
 *
 * HONEST FRAMING: this feed is SELF-REPORTED by the same server that
 * collected the payment — it is an accounting log, not trustless proof. The
 * server writes "we settled X and forwarded Y"; nothing on-chain forces
 * those claims to be true. Treat it as a public record of what the operator
 * claims, and verify the 2% forward against the ledger (the forward tx id is
 * recorded in each entry) rather than taking the feed's word for it. Do not
 * market this as an independent audit.
 *
 * The audit writer needs its own operator credentials (AUDIT_OPERATOR_ID /
 * AUDIT_OPERATOR_KEY). Audit failures are logged but NEVER block serving the
 * paid request — the payment already settled, so the API response must win.
 *
 * NETWORK: driven by HEDERA_NETWORK (see src/network.ts) — testnet by
 * default, mainnet when configured.
 *
 * MULTI-ASSET (Phase B): every entry carries the paid asset ("0.0.0" for the
 * HBAR rail, the USDC token id for the USDC rail). Amounts are base units of
 * that asset (tinybars for HBAR, 10^-6 USDC for the USDC rail).
 */

import {
  PrivateKey,
  TopicCreateTransaction,
  TopicId,
  TopicMessageSubmitTransaction,
  type Client,
} from "@hiero-ledger/sdk";
import { newHederaClient, parseOperatorKey } from "./network.js";
import type { TreasuryForwardResult } from "./treasury.js";

export interface AuditEntry {
  /** x402 settle transaction id (Hedera tx id, e.g. 0.0.1234@1694...). */
  txId: string;
  payer: string;
  payTo: string;
  /** Settled amount, in base units of the paid asset. */
  amountBaseUnits: string;
  /** Paid asset: "0.0.0" (HBAR rail) or the USDC token id (USDC rail). */
  asset: string;
  network: string;
  endpoint: string;
  settledAt: string; // ISO-8601
  facilitator: string;
  /** Voicescape 98/2 split: base units kept by the operator (98%). */
  operatorShareBaseUnits?: string;
  /** Voicescape 98/2 split: base units forwarded to the treasury (2%). */
  treasuryShareBaseUnits?: string;
  /** Treasury account receiving the 2% share. */
  treasuryAccountId?: string | null;
  /** Consensus tx id of the 2% forward transfer (null if not attempted). */
  treasuryForwardTxId?: string | null;
}

function auditClient(): Client | null {
  const operatorId = process.env.AUDIT_OPERATOR_ID;
  const operatorKey = process.env.AUDIT_OPERATOR_KEY;
  if (!operatorId || !operatorKey) return null;
  // Network comes from HEDERA_NETWORK (see src/network.ts): testnet by
  // default, mainnet when configured. Never hardcoded.
  return newHederaClient(operatorId, parseOperatorKey(operatorKey), "audit");
}

/**
 * Assemble the audit entry for one settled payment from the x402 settle
 * context and the (best-effort) treasury forward result. Pure — unit-testable.
 */
export function buildAuditEntry(args: {
  txId: string;
  payer: string;
  payTo: string;
  amountBaseUnits: string;
  asset: string;
  network: string;
  endpoint: string;
  facilitator: string;
  forward: TreasuryForwardResult;
  treasuryAccountId: string | null;
}): AuditEntry {
  return {
    txId: args.txId,
    payer: args.payer,
    payTo: args.payTo,
    amountBaseUnits: args.amountBaseUnits,
    asset: args.asset,
    network: args.network,
    endpoint: args.endpoint,
    settledAt: new Date().toISOString(),
    facilitator: args.facilitator,
    operatorShareBaseUnits: args.forward.operatorShareUnits,
    treasuryShareBaseUnits: args.forward.treasuryShareUnits,
    treasuryAccountId: args.treasuryAccountId,
    treasuryForwardTxId: args.forward.txId,
  };
}

/** Submit one audit message. Returns the message sequence number, or null. */
export async function logSettledPayment(entry: AuditEntry): Promise<number | null> {
  const topicId = process.env.HCS_TOPIC_ID;
  if (!topicId) {
    console.warn("[audit] HCS_TOPIC_ID not set — skipping audit log");
    return null;
  }
  const client = auditClient();
  if (!client) {
    console.warn("[audit] AUDIT_OPERATOR_ID/KEY not set — skipping audit log");
    return null;
  }
  try {
    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(JSON.stringify(entry))
      .execute(client);
    const receipt = await tx.getReceipt(client);
    console.log(`[audit] logged settled payment tx=${entry.txId} seq=${receipt.topicSequenceNumber}`);
    client.close();
    return Number(receipt.topicSequenceNumber ?? 0);
  } catch (e) {
    // Audit is best-effort: never break the paid request over it.
    console.warn(`[audit] failed to write audit message: ${e instanceof Error ? e.message : String(e)}`);
    try {
      client.close();
    } catch {
      /* noop */
    }
    return null;
  }
}

/**
 * One-time setup helper: create the audit topic and print its id.
 * Put the printed id into HCS_TOPIC_ID. Run via `npm run audit:init`.
 */
export async function createAuditTopic(): Promise<string> {
  const operatorId = process.env.AUDIT_OPERATOR_ID;
  const operatorKey = process.env.AUDIT_OPERATOR_KEY;
  if (!operatorId || !operatorKey) {
    throw new Error("Set AUDIT_OPERATOR_ID and AUDIT_OPERATOR_KEY first (any key type the configured HEDERA_NETWORK account uses).");
  }
  const client = newHederaClient(
    operatorId,
    parseOperatorKey(operatorKey),
    "audit",
  );
  const tx = await new TopicCreateTransaction()
    .setTopicMemo("Vibecode x402 — settled payment audit feed (ETHOnline 2026)")
    .execute(client);
  const receipt = await tx.getReceipt(client);
  const topicId = receipt.topicId;
  client.close();
  if (!topicId) throw new Error("Topic creation returned no topic id.");
  return topicId.toString();
}
