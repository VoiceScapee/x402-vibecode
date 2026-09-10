/**
 * Treasury forwarding — the on-chain half of the Voicescape 98/2 split.
 *
 * The x402 "exact" scheme settles ONE transfer: buyer -> operator, for the
 * full price. That transfer is atomic and protocol-enforced. The platform's
 * 2% is then forwarded on-chain by the operator to the treasury account, so
 * the split is visible on the ledger and in the HCS audit feed:
 *
 *   buyer --(x402 settle)--> operator --(2% forward)--> treasury
 *
 * Forwarding is best-effort by design — like the audit feed, it can never
 * break a paid request. Env:
 *   SELLER_ACCOUNT_ID   operator account (also the x402 payTo)
 *   SELLER_PRIVATE_KEY  ECDSA key for the operator (forwards the 2%)
 *   TREASURY_ACCOUNT_ID Voicescape treasury (receives the 2%)
 *
 * TESTNET ONLY. Nothing here touches mainnet.
 */

import {
  Client,
  Hbar,
  PrivateKey,
  TransferTransaction,
} from "@hashgraph/sdk";
import { getTreasuryAccountId, splitPayment } from "./payment.js";

export interface TreasuryForwardResult {
  /** True when a forward was attempted (or simulated in dry-run). */
  attempted: boolean;
  /** Set in dry-run: nothing touched the chain. */
  simulated?: boolean;
  /** Consensus tx id of the forward transfer, when one was submitted. */
  txId: string | null;
  treasuryShareTinybars: string;
  operatorShareTinybars: string;
  /** Why nothing was attempted (when attempted=false). */
  reason?: string;
}

function operatorClient(): Client | null {
  const operatorId = process.env.SELLER_ACCOUNT_ID;
  const operatorKey = process.env.SELLER_PRIVATE_KEY;
  if (!operatorId || !operatorKey) return null;
  const client = Client.forTestnet();
  client.setOperator(operatorId, PrivateKey.fromStringECDSA(operatorKey));
  return client;
}

/**
 * Forward the 2% platform share to the treasury. Never throws — returns a
 * result describing what happened so the audit feed can record it.
 */
export async function forwardTreasuryShare(opts: {
  amountTinybars: string;
  /** x402 settle tx id, for log correlation. */
  sourceTxId: string;
  /** Explicit treasury override (used by the dry-run mock). */
  treasuryAccountId?: string;
  /** When true, compute + log the split without touching the chain. */
  dryRun?: boolean;
}): Promise<TreasuryForwardResult> {
  const { operator, treasury } = splitPayment(opts.amountTinybars);
  const operatorShareTinybars = operator.toString();
  const treasuryShareTinybars = treasury.toString();

  const treasuryAccountId = opts.treasuryAccountId ?? getTreasuryAccountId();
  if (!treasuryAccountId) {
    console.warn("[treasury] TREASURY_ACCOUNT_ID not set — skipping 2% forward");
    return {
      attempted: false,
      txId: null,
      treasuryShareTinybars,
      operatorShareTinybars,
      reason: "treasury-not-configured",
    };
  }
  if (treasury === 0n) {
    console.log("[treasury] treasury share is 0 tinybars (dust) — nothing to forward");
    return {
      attempted: false,
      txId: null,
      treasuryShareTinybars,
      operatorShareTinybars,
      reason: "dust",
    };
  }

  if (opts.dryRun) {
    console.log(
      `[treasury] (dry-run) would forward ${treasuryShareTinybars} tinybars (2%) -> ${treasuryAccountId} [source tx ${opts.sourceTxId}]`,
    );
    return {
      attempted: true,
      simulated: true,
      txId: null,
      treasuryShareTinybars,
      operatorShareTinybars,
    };
  }

  const client = operatorClient();
  if (!client) {
    console.warn("[treasury] SELLER_PRIVATE_KEY not set — cannot forward 2% share");
    return {
      attempted: false,
      txId: null,
      treasuryShareTinybars,
      operatorShareTinybars,
      reason: "operator-key-missing",
    };
  }
  const operatorId = process.env.SELLER_ACCOUNT_ID!;
  try {
    const share = Hbar.fromTinybars(Number(treasuryShareTinybars));
    const tx = await new TransferTransaction()
      .addHbarTransfer(operatorId, share.negated())
      .addHbarTransfer(treasuryAccountId, share)
      .setTransactionMemo("Vibecode x402 — 2% platform treasury share")
      .execute(client);
    const receipt = await tx.getReceipt(client);
    const txId = tx.transactionId.toString();
    console.log(
      `[treasury] forwarded ${treasuryShareTinybars} tinybars (2%) -> ${treasuryAccountId} tx=${txId} status=${receipt.status}`,
    );
    return {
      attempted: true,
      txId,
      treasuryShareTinybars,
      operatorShareTinybars,
    };
  } catch (e) {
    // Best-effort: the buyer's payment already settled; the API response wins.
    console.warn(
      `[treasury] forward failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return {
      attempted: true,
      txId: null,
      treasuryShareTinybars,
      operatorShareTinybars,
      reason: "forward-failed",
    };
  } finally {
    try {
      client.close();
    } catch {
      /* noop */
    }
  }
}
