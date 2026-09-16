/**
 * A2A agent card — machine-readable discovery for the Vibecode x402 service.
 *
 * Served at the A2A 1.0 well-known URI `/.well-known/agent-card.json`
 * (a2a-protocol.org, §4.4.1), with `/.well-known/agent.json` as a compat
 * alias for older clients. Lets AI agents (and the Voicescape "Yellow
 * Pages of Agents" directory) discover the service and its payment terms
 * WITHOUT first triggering a 402.
 *
 * a2a-x402 PAYMENT EXTENSION: the card declares the official extension
 *   https://github.com/google-a2a/a2a-x402/v0.1
 * as required, and carries the LIVE payment requirements in the
 * extension's `params` (x402 v2, exact scheme, Hedera) — built from the
 * same route config as the 402, so the card can never advertise a stale
 * price or a suspended rail.
 *
 * HONEST FRAMING: this card uses the A2A AgentCard *format* for discovery.
 * The service speaks the x402 HTTP payment flow (402 Payment Required ->
 * PAYMENT-SIGNATURE -> 200 + PAYMENT-RESPONSE), not A2A JSON-RPC
 * message/send. The skill description says so explicitly — do not market
 * this as a full A2A JSON-RPC agent.
 */

import type { Express, Request, Response } from "express";
import {
  buildCopyReviewRouteConfig,
  buildVibecodeRouteConfig,
  getFacilitatorUrl,
  getSellerAccountId,
} from "./payment.js";
import { hederaNetworkId } from "./network.js";

/** Canonical a2a-x402 extension URI (spec v0.1). */
export const A2A_X402_EXTENSION_URI =
  "https://github.com/google-a2a/a2a-x402/v0.1" as const;

/** A2A 1.0 well-known discovery URI. */
export const AGENT_CARD_WELL_KNOWN_PATH = "/.well-known/agent-card.json" as const;

/** Compat alias for pre-1.0 clients. */
export const AGENT_CARD_ALIAS_PATH = "/.well-known/agent.json" as const;

/**
 * Agent version advertised in the card. MUST match package.json "version" —
 * test/agent-card.test.ts enforces this so the two can never drift.
 */
export const AGENT_CARD_VERSION = "0.1.0";

export interface AgentCardSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
}

export interface AgentCardPaymentTerms {
  scheme: "exact";
  network: string;
  asset: string;
  payTo: string;
  amount: string;
  maxTimeoutSeconds: number;
}

/** A2A 1.0 AgentCard shape (§4.4.1) — only the fields this service uses. */
export interface AgentCard {
  name: string;
  description: string;
  provider: { organization: string; url: string };
  version: string;
  documentationUrl: string;
  supportedInterfaces: Array<{
    url: string;
    protocolBinding: "HTTP+JSON";
    protocolVersion: string;
  }>;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    extensions: Array<{
      uri: string;
      description: string;
      required: boolean;
      params: {
        x402Version: 2;
        paymentFlow: "upfront";
        buyerKeyType: string;
        facilitator: string;
        serviceEndpoint: string;
        accepts: AgentCardPaymentTerms[];
      };
    }>;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentCardSkill[];
}

/**
 * Build the agent card from LIVE configuration. The payment terms come
 * from buildVibecodeRouteConfig / buildCopyReviewRouteConfig — the exact
 * same sources as the 402s — so a price-feed refresh or an HBAR-rail
 * suspension is reflected in the card on the very next request.
 *
 * The card carries one a2a-x402 extension entry PER paid endpoint
 * (vibecode, plus copy-review when COPY_REVIEW_SELLER_ACCOUNT_ID is set),
 * each with its own serviceEndpoint and accepts terms, plus one skill per
 * endpoint.
 */
export function buildAgentCard(opts: {
  publicUrl: string;
  includeHbarRail: boolean;
  /** danny's wallet receiving /copy-review payments; null disables the copy-review skill. */
  copyReviewSellerAccountId: string | null;
}): AgentCard {
  const vibecodeTerms = termsFor(
    buildVibecodeRouteConfig(getSellerAccountId(), {
      includeHbarRail: opts.includeHbarRail,
    }),
  );
  const copyReviewTerms = opts.copyReviewSellerAccountId
    ? termsFor(
        buildCopyReviewRouteConfig(opts.copyReviewSellerAccountId, {
          includeHbarRail: opts.includeHbarRail,
        }),
      )
    : null;
  const copyReviewDescription =
    "danny the liaison agent's blockpage copy review (copy-review)";
  return {
    name: "Vibecode x402",
    description:
      "Pay-per-request AI services for Voicescape blockpages, operated on " +
      "Hedera via x402. " +
      (copyReviewTerms
        ? "Two skills: an AI page builder (vibecode) and " + copyReviewDescription + ". "
        : "One skill: an AI page builder (vibecode). ") +
      "Every request is paid in a single on-chain x402 transfer on Hedera " +
      "(native HBAR or USDC rails); the platform keeps a 2% share forwarded " +
      "on-chain to the Voicescape treasury.",
    provider: {
      organization: "Voicescape",
      url: "https://voicescape.vercel.app",
    },
    version: AGENT_CARD_VERSION,
    documentationUrl: "https://github.com/VoiceScapee/x402-vibecode",
    supportedInterfaces: [
      {
        url: opts.publicUrl,
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        x402ExtensionEntry(
          opts.publicUrl,
          "vibecode",
          "Monetization via the x402 protocol (v2, exact scheme) on " +
            "Hedera. Clients MUST complete the x402 payment flow before " +
            "the vibecode skill runs.",
          vibecodeTerms,
        ),
        ...(copyReviewTerms
          ? [
              x402ExtensionEntry(
                opts.publicUrl,
                "copy-review",
                "Monetization via the x402 protocol (v2, exact scheme) on " +
                  "Hedera. Clients MUST complete the x402 payment flow before " +
                  "the copy-review skill runs. Payments settle to danny's " +
                  "(the Voicescape liaison agent's) wallet.",
                copyReviewTerms,
              ),
            ]
          : []),
      ],
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "vibecode",
        name: "AI page builder",
        description:
          "POST { pageJson, instruction } to /vibecode and receive " +
          "{ pageJson } with the AI-applied edit. Payment settles on-chain " +
          "BEFORE the AI runs (upfront flow): 402 Payment Required -> " +
          "retry with PAYMENT-SIGNATURE -> 200 plus PAYMENT-RESPONSE " +
          "settle receipt. This card uses the A2A AgentCard format for " +
          "discovery; the service speaks the x402 HTTP payment flow, not " +
          "A2A JSON-RPC message/send.",
        tags: ["web3", "hedera", "x402", "ai", "page-builder", "micropayments"],
        examples: [
          "Add a music block with my latest track to my blockpage",
          "Restyle my page header with a neon sound-wave theme",
        ],
      },
      ...(copyReviewTerms
        ? [
            {
              id: "copy-review",
              name: "Blockpage copy review (danny)",
              description:
                "POST { pageJson, focus? } to /copy-review and receive " +
                "{ review } — danny the Voicescape liaison agent's structured " +
                "copy critique: summary, honest 1-10 score, strengths, per-block " +
                "suggestions with concrete fixes, and a rewritten bio draft. " +
                "Payment settles on-chain BEFORE the AI runs (upfront flow): " +
                "402 Payment Required -> retry with PAYMENT-SIGNATURE -> 200 " +
                "plus PAYMENT-RESPONSE settle receipt. This card uses the A2A " +
                "AgentCard format for discovery; the service speaks the x402 " +
                "HTTP payment flow, not A2A JSON-RPC message/send.",
              tags: [
                "web3",
                "hedera",
                "x402",
                "ai",
                "copywriting",
                "blockpage",
                "micropayments",
              ],
              examples: [
                "Review my blockpage copy and tell me what to fix",
                "Score my bio and rewrite it tighter",
              ],
            },
          ]
        : []),
    ],
  };
}

/** One a2a-x402 extension entry for a paid endpoint. */
function x402ExtensionEntry(
  publicUrl: string,
  endpoint: string,
  description: string,
  accepts: AgentCardPaymentTerms[],
): AgentCard["capabilities"]["extensions"][number] {
  return {
    uri: A2A_X402_EXTENSION_URI,
    description,
    required: true,
    params: {
      x402Version: 2,
      paymentFlow: "upfront",
      buyerKeyType: "ECDSA (secp256k1)",
      facilitator: getFacilitatorUrl(),
      serviceEndpoint: `POST ${publicUrl}/${endpoint}`,
      accepts,
    },
  };
}

/**
 * Extract concrete exact-scheme payment terms from a route config.
 * RouteConfig.accepts is typed PaymentOption | PaymentOption[] by
 * @x402/core; our builders (same codebase) always produce an array of
 * concrete exact-scheme options — assert that concrete shape here so a
 * single-option future shape can't slip a non-array (or a dynamic
 * price/payTo) into the card.
 */
function termsFor(routeConfig: {
  accepts: unknown;
}): AgentCardPaymentTerms[] {
  type ConcreteOption = {
    scheme: "exact";
    network: string;
    payTo: string;
    price: { asset: string; amount: string };
    maxTimeoutSeconds: number;
  };
  const options = (
    Array.isArray(routeConfig.accepts)
      ? routeConfig.accepts
      : [routeConfig.accepts]
  ) as ConcreteOption[];
  return options.map((a) => ({
    scheme: "exact",
    network: a.network,
    asset: a.price.asset,
    payTo: a.payTo,
    amount: a.price.amount,
    maxTimeoutSeconds: a.maxTimeoutSeconds,
  }));
}

/**
 * Mount the agent card on an Express app. `buildCard` is a thunk so every
 * request reflects live pricing/rail state (the HBAR rail suspends when
 * the price feed goes stale — the card must say so too).
 */
export function registerAgentCardRoutes(
  app: Express,
  buildCard: () => AgentCard,
): void {
  const handler = (_req: Request, res: Response) => {
    res.type("application/json").send(JSON.stringify(buildCard()));
  };
  app.get(AGENT_CARD_WELL_KNOWN_PATH, handler);
  app.get(AGENT_CARD_ALIAS_PATH, handler);
}
