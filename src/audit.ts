/**
 * HCS audit feed: one Hedera Consensus Service message per settled payment.
 *
 * Verifiable by anyone via the free mirror node REST API:
 *   https://testnet.mirrornode.hedera.com/api/v1/topics/<HCS_TOPIC_ID>/messages
 *
 * The audit writer needs its own operator credentials (AUDIT_OPERATOR_ID /
 * AUDIT_OPERATOR_KEY). Audit failures are logged but NEVER block serving the
 * paid request — the payment already settled, so the API response must win.
 */

import {
  Client,
  PrivateKey,
  TopicCreateTransaction,
  TopicId,
  TopicMessageSubmitTransaction,
} from "@hashgraph/sdk";

export interface AuditEntry {
  /** x402 settle transaction id (Hedera tx id, e.g. 0.0.1234@1694...). */
  txId: string;
  payer: string;
  payTo: string;
  amountTinybars: string;
  asset: string;
  network: string;
  endpoint: string;
  settledAt: string; // ISO-8601
  facilitator: string;
  /** Voicescape 98/2 split: tinybars kept by the operator (98%). */
  operatorShareTinybars?: string;
  /** Voicescape 98/2 split: tinybars forwarded to the treasury (2%). */
  treasuryShareTinybars?: string;
  /** Treasury account receiving the 2% share. */
  treasuryAccountId?: string | null;
  /** Consensus tx id of the 2% forward transfer (null if not attempted). */
  treasuryForwardTxId?: string | null;
}

function auditClient(): Client | null {
  const operatorId = process.env.AUDIT_OPERATOR_ID;
  const operatorKey = process.env.AUDIT_OPERATOR_KEY;
  if (!operatorId || !operatorKey) return null;
  const client = Client.forTestnet();
  client.setOperator(operatorId, PrivateKey.fromString(operatorKey));
  return client;
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
    throw new Error("Set AUDIT_OPERATOR_ID and AUDIT_OPERATOR_KEY (any testnet key type) first.");
  }
  const client = Client.forTestnet();
  client.setOperator(operatorId, PrivateKey.fromString(operatorKey));
  const tx = await new TopicCreateTransaction()
    .setTopicMemo("Vibecode x402 — settled payment audit feed (ETHOnline 2026)")
    .execute(client);
  const receipt = await tx.getReceipt(client);
  const topicId = receipt.topicId;
  client.close();
  if (!topicId) throw new Error("Topic creation returned no topic id.");
  return topicId.toString();
}
