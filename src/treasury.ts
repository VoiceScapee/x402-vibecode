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
 * ASSET-AWARE (Phase B): the forward pays EXACTLY 2% of the settled amount
 * in whatever asset the buyer paid — an HBAR transfer for the HBAR rail, an
 * HTS token transfer for the USDC rail. Exact integer math in both cases.
 *
 * HONEST FRAMING: the 2% forward is BEST-EFFORT REVENUE ACCOUNTING, not a
 * trustless guarantee. The operator key below belongs to Voicescape's own
 * server — this is the platform paying itself. If the forward fails, the
 * loser is the Voicescape treasury, not the user: the buyer already
 * received the service and no user funds are custodied here. Do not describe
 * this as "enforced on-chain" — the atomic 98/2 split only exists where a
 * smart contract performs it (VoicescapeTips / VoicescapeEscrow).
 *
 * HOT KEY WARNING: SELLER_PRIVATE_KEY is a hot server key. It must be able
 * to sign forwards, so a full server compromise could spend whatever HBAR /
 * tokens sit in the operator account. Keep the operator account LEAN — sweep
 * forwarded funds to cold storage regularly (a small operational balance is
 * all it needs: just enough to cover its own transaction fees). The blast
 * radius of a key leak is bounded by what you leave in the account.
 *
 * NETWORK: driven by HEDERA_NETWORK (see src/network.ts) — testnet by
 * default, mainnet when configured. Env:
 *   HEDERA_NETWORK      mainnet | testnet | previewnet (default testnet)
 *   SELLER_ACCOUNT_ID   operator account (also the x402 payTo)
 *   SELLER_PRIVATE_KEY  operator private key, any key type (forwards the 2%)
 *   TREASURY_ACCOUNT_ID Voicescape treasury (receives the 2%)
 */

import {
  Hbar,
  PrivateKey,
  TokenId,
  TransferTransaction,
  type Client,
} from "@hiero-ledger/sdk";
import { newHederaClient, parseOperatorKey } from "./network.js";
import {
  getTreasuryAccountId,
  HBAR_ASSET_ID,
  railForAsset,
  splitPayment,
} from "./payment.js";
import { getForwardFeeTinybars } from "./economics.js";
import { getActiveRate } from "./price.js";

export interface TreasuryForwardResult {
  /** True when a forward was attempted (or simulated in dry-run). */
  attempted: boolean;
  /** Set in dry-run: nothing touched the chain. */
  simulated?: boolean;
  /** Consensus tx id of the forward transfer, when one was submitted. */
  txId: string | null;
  /** x402 asset id of the paid asset ("0.0.0" for HBAR, USDC token id otherwise). */
  asset: string;
  /** Base units of the paid asset forwarded to the treasury (2%). */
  treasuryShareUnits: string;
  /** Base units of the paid asset kept by the operator (98%). */
  operatorShareUnits: string;
  /** Why nothing was attempted (when attempted=false). */
  reason?: string;
}

function operatorClient(): Client | null {
  const operatorId = process.env.SELLER_ACCOUNT_ID;
  const operatorKey = process.env.SELLER_PRIVATE_KEY;
  if (!operatorId || !operatorKey) return null;
  // Network comes from HEDERA_NETWORK (see src/network.ts): testnet by
  // default, mainnet when configured. Never hardcoded.
  return newHederaClient(operatorId, parseOperatorKey(operatorKey), "treasury");
}

/**
 * Forward the 2% platform share to the treasury, in the asset that was
 * paid. Never throws — returns a result describing what happened so the
 * audit feed can record it.
 */
export async function forwardTreasuryShare(opts: {
  /** Settled amount, in base units of the paid asset. */
  amount: string;
  /** x402 asset id of the paid asset (HBAR_ASSET_ID or a USDC token id). */
  asset: string;
  /** x402 settle tx id, for log correlation. */
  sourceTxId: string;
  /** Explicit treasury override (used by the dry-run mock). */
  treasuryAccountId?: string;
  /** When true, compute + log the split without touching the chain. */
  dryRun?: boolean;
}): Promise<TreasuryForwardResult> {
  const rail = railForAsset(opts.asset); // throws on unsupported asset
  const { operator, treasury } = splitPayment(opts.amount);
  const operatorShareUnits = operator.toString();
  const treasuryShareUnits = treasury.toString();

  const base: Pick<TreasuryForwardResult, "asset" | "operatorShareUnits" | "treasuryShareUnits"> = {
    asset: opts.asset,
    operatorShareUnits,
    treasuryShareUnits,
  };

  const treasuryAccountId = opts.treasuryAccountId ?? getTreasuryAccountId();
  if (!treasuryAccountId) {
    console.warn("[treasury] TREASURY_ACCOUNT_ID not set — skipping 2% forward");
    return { attempted: false, txId: null, ...base, reason: "treasury-not-configured" };
  }
  if (treasury === 0n) {
    console.log(`[treasury] treasury share is 0 ${rail.unitsLabel} (dust) — nothing to forward`);
    return { attempted: false, txId: null, ...base, reason: "dust" };
  }

  // Never pay a chain fee to collect dust: when the 2% share is worth less
  // than 2x the forward-tx fee budget, skip the forward. Exact integer
  // math, no floats — on the HBAR rail the HBAR/USD rate cancels out, so
  // compare tinybars directly; on the USDC rail convert via the active
  // rate (USDC = $1): skip iff share/1e6 < fee×2/1e8 × hbarUsd.
  {
    const feeTinybars = getForwardFeeTinybars();
    const skip = (() => {
      if (feeTinybars === 0n) return false; // fee budget disabled
      if (opts.asset === HBAR_ASSET_ID) {
        return treasury < feeTinybars * 2n;
      }
      const rate = getActiveRate();
      const lhs = treasury * 100_000_000n * rate.den; // share (base units) × 1e8 × rateDen
      const rhs = feeTinybars * 2n * rate.num * 1_000_000n; // fee×2 × rateNum × 1e6
      return lhs < rhs;
    })();
    if (skip) {
      console.log(
        `[treasury] treasury share ${treasuryShareUnits} ${rail.unitsLabel} ` +
          `(asset ${opts.asset}) is worth less than 2x the forward fee — skipping forward`,
      );
      return { attempted: false, txId: null, ...base, reason: "below-forward-fee" };
    }
  }

  if (opts.dryRun) {
    console.log(
      `[treasury] (dry-run) would forward ${treasuryShareUnits} ${rail.unitsLabel} of asset ${opts.asset} (2%) -> ${treasuryAccountId} [source tx ${opts.sourceTxId}]`,
    );
    return { attempted: true, simulated: true, txId: null, ...base };
  }

  const client = operatorClient();
  if (!client) {
    console.warn("[treasury] SELLER_PRIVATE_KEY not set — cannot forward 2% share");
    return { attempted: false, txId: null, ...base, reason: "operator-key-missing" };
  }
  const operatorId = process.env.SELLER_ACCOUNT_ID!;
  try {
    const tx = new TransferTransaction().setTransactionMemo(
      "Vibecode x402 — 2% platform treasury share",
    );
    if (opts.asset === HBAR_ASSET_ID) {
      const share = Hbar.fromTinybars(Number(treasuryShareUnits));
      tx.addHbarTransfer(operatorId, share.negated()).addHbarTransfer(treasuryAccountId, share);
    } else {
      // USDC rail: HTS token transfer of the 2% share.
      const tokenId = TokenId.fromString(rail.tokenId!);
      tx.addTokenTransfer(tokenId, operatorId, -treasury)
        .addTokenTransfer(tokenId, treasuryAccountId, treasury);
    }
    const submitted = await tx.execute(client);
    const receipt = await submitted.getReceipt(client);
    const txId = submitted.transactionId.toString();
    console.log(
      `[treasury] forwarded ${treasuryShareUnits} ${rail.unitsLabel} of asset ${opts.asset} (2%) -> ${treasuryAccountId} tx=${txId} status=${receipt.status}`,
    );
    return { attempted: true, txId, ...base };
  } catch (e) {
    // Best-effort: the buyer's payment already settled; the API response wins.
    console.warn(
      `[treasury] forward failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { attempted: true, txId: null, ...base, reason: "forward-failed" };
  } finally {
    try {
      client.close();
    } catch {
      /* noop */
    }
  }
}
