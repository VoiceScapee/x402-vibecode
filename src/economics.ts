/**
 * Platform economics — "the platform never loses money when users interact".
 *
 * Two hard rules, enforced in code (not just documented):
 *
 *   1. STARTUP PRICE FLOOR: the service refuses to boot when the configured
 *      x402 price (PRICE_USD_CENTS) is below the break-even floor for the
 *      configured Anthropic model. The floor prices the worst-case Anthropic
 *      call (MAX_INPUT_TOKENS in, MAX_OUTPUT_TOKENS out) plus a 1.5x safety
 *      margin, plus the operator's per-request on-chain overhead (settle tx
 *      fee via the facilitator's fee payer, the 2% treasury forward tx fee,
 *      and the HCS audit tx fee — all paid by US, not the buyer). The
 *      buyer pays once; if that price can't cover the worst-case AI cost,
 *      the request would lose money, so the server fails LOUDLY at startup
 *      instead of bleeding per-request. Mock ($0) mode — no
 *      ANTHROPIC_API_KEY — has no AI cost, so the floor does not apply.
 *
 *   2. TREASURY FORWARD SKIP: forwarding the 2% platform share costs a
 *      transaction fee (FORWARD_FEE_TINYBARS). When the share is worth less
 *      than 2x that fee, the forward is skipped — never pay $0.0005 of
 *      chain fees to collect $0.0002 of platform revenue.
 *
 * All money math is exact BigInt arithmetic — no floating point anywhere.
 */

import { getActiveRate } from "./price.js";
import { getPriceUsdCents } from "./payment.js";
import { DEFAULT_MODEL } from "./anthropic.js";

// ---------------------------------------------------------------------------
// Model rate table
// ---------------------------------------------------------------------------

/** USD-per-million-tokens rate, as an exact { num, den } rational. */
export interface UsdPerMtokRate {
  num: bigint;
  den: bigint;
}

export interface ModelRates {
  /** The model these rates apply to. */
  model: string;
  /** USD per million input tokens. */
  input: UsdPerMtokRate;
  /** USD per million output tokens. */
  output: UsdPerMtokRate;
  /** "env" when ANTHROPIC_*_USD_PER_MTOK overrides were used, "builtin" otherwise. */
  source: "builtin" | "env";
}

/** The Anthropic model the server actually calls (ANTHROPIC_MODEL override or default). */
export function getAnthropicModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * Parse a "$ per million tokens" rate string into an exact rational.
 * Throws on anything that isn't a positive decimal number.
 */
export function parseUsdPerMtokRate(raw: string): UsdPerMtokRate {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!m) {
    throw new Error(
      `Model rate must be a positive decimal number in USD per million tokens (got "${raw}")`,
    );
  }
  const decimals = m[2] ?? "";
  const num = BigInt(m[1] + decimals);
  const den = 10n ** BigInt(decimals.length);
  if (num <= 0n) {
    throw new Error(
      `Model rate must be positive in USD per million tokens (got "${raw}")`,
    );
  }
  return { num, den };
}

/** Built-in rate for the default sonnet-class model: $3 / $15 per MTok. */
const SONNET_RATE: { input: UsdPerMtokRate; output: UsdPerMtokRate } = {
  input: { num: 3n, den: 1n },
  output: { num: 15n, den: 1n },
};

/** Built-in rate for haiku-class models: $1 / $5 per MTok. */
const HAIKU_RATE: { input: UsdPerMtokRate; output: UsdPerMtokRate } = {
  input: { num: 1n, den: 1n },
  output: { num: 5n, den: 1n },
};

/**
 * Resolve the per-MTok rates for a model. Loud, fail-fast behavior:
 *  - Explicit env overrides (BOTH ANTHROPIC_INPUT_USD_PER_MTOK and
 *    ANTHROPIC_OUTPUT_USD_PER_MTOK) always win and apply to any model.
 *  - Sonnet-class models (the default, or any model id containing
 *    "sonnet") use the $3/$15 table.
 *  - Haiku-class models (any model id containing "haiku") use the $1/$5 table.
 *  - Anything else with no explicit overrides THROWS at startup, naming
 *    the model and the exact fix. Silently assuming a rate would let an
 *    expensive model run at a cheap model's price — a direct loss vector.
 */
export function resolveModelRates(model: string): ModelRates {
  const inputOverride = process.env.ANTHROPIC_INPUT_USD_PER_MTOK;
  const outputOverride = process.env.ANTHROPIC_OUTPUT_USD_PER_MTOK;
  if ((inputOverride !== undefined) !== (outputOverride !== undefined)) {
    throw new Error(
      `Set BOTH ANTHROPIC_INPUT_USD_PER_MTOK and ANTHROPIC_OUTPUT_USD_PER_MTOK, ` +
        `or neither — refusing to mix an override with the rate table.`,
    );
  }
  if (inputOverride !== undefined && outputOverride !== undefined) {
    try {
      return {
        model,
        input: parseUsdPerMtokRate(inputOverride),
        output: parseUsdPerMtokRate(outputOverride),
        source: "env",
      };
    } catch (e) {
      throw new Error(
        `Invalid ANTHROPIC_*_USD_PER_MTOK override: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const lower = model.toLowerCase();
  if (lower.includes("sonnet")) {
    return { model, ...SONNET_RATE, source: "builtin" };
  }
  if (lower.includes("haiku")) {
    return { model, ...HAIKU_RATE, source: "builtin" };
  }
  throw new Error(
    `Unknown ANTHROPIC_MODEL "${model}": no built-in rate table entry. ` +
      `The price floor cannot be computed, so the server refuses to guess. ` +
      `Fix: set ANTHROPIC_INPUT_USD_PER_MTOK and ANTHROPIC_OUTPUT_USD_PER_MTOK ` +
      `(USD per million tokens for this model), or use a known model ` +
      `(${DEFAULT_MODEL} or a haiku-class model).`,
  );
}

// ---------------------------------------------------------------------------
// Worst-case token budget
// ---------------------------------------------------------------------------

/** Worst-case input tokens per request: system prompt (~4k) + pageJson + instruction. */
export const DEFAULT_MAX_INPUT_TOKENS = 20_000n;

/** Worst-case output tokens per request: matches the max_tokens param in src/anthropic.ts. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096n;

function parsePositiveIntEnv(
  name: string,
  def: bigint,
  opts: { allowZero?: boolean } = {},
): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || (BigInt(trimmed) <= 0n && !opts.allowZero)) {
    throw new Error(
      `${name} must be a ${opts.allowZero ? "non-negative" : "positive"} integer (got "${raw}")`,
    );
  }
  return BigInt(trimmed);
}

export function getMaxInputTokens(): bigint {
  return parsePositiveIntEnv("MAX_INPUT_TOKENS", DEFAULT_MAX_INPUT_TOKENS);
}

export function getMaxOutputTokens(): bigint {
  return parsePositiveIntEnv("MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS);
}

/** Safety margin multiplier on the worst-case AI cost (1.5x). */
const SAFETY_MARGIN_NUM = 3n;
const SAFETY_MARGIN_DEN = 2n;

// ---------------------------------------------------------------------------
// Operator overhead
// ---------------------------------------------------------------------------

/**
 * Per-request operator overhead in tinybars (default 1_000_000 = 0.01 HBAR).
 * Covers: the settle tx fee (paid by the facilitator's fee payer — our own
 * self-hosted facilitator, so US), the operator's treasury-forward tx fee,
 * and the HCS audit tx fee when configured. Conservative: ~$0.0001 each,
 * this budgets roughly 10x that at $0.20/HBAR.
 */
export function getOperatorOverheadTinybars(): bigint {
  return parsePositiveIntEnv("OPERATOR_OVERHEAD_TINYBARS", 1_000_000n, { allowZero: true });
}

/**
 * Forward-tx fee budget used by the treasury forward skip rule: a 2% share
 * cheaper than 2x this fee is never forwarded (default 500_000 tinybars,
 * ≈$0.001 at $0.20/HBAR — conservative vs the actual ~$0.0001).
 */
export function getForwardFeeTinybars(): bigint {
  return parsePositiveIntEnv("FORWARD_FEE_TINYBARS", 500_000n, { allowZero: true });
}

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

export interface PriceFloor {
  /** The model the floor was computed for. */
  model: string;
  /** Worst-case AI cost in USD cents, ceil-ed, including the 1.5x margin. */
  aiCostCents: bigint;
  /** Operator per-request overhead in USD cents, ceil-ed at the active HBAR/USD rate. */
  overheadCents: bigint;
  /** The break-even price: aiCostCents + overheadCents. */
  floorCents: bigint;
}

/**
 * Compute the break-even price floor in USD cents.
 *
 *   aiCostUsd = (inT × inRate + outT × outRate) / 1e6 × 1.5
 *   aiCostCents = ceil(aiCostUsd × 100)
 *   overheadCents = ceil(overheadTinybars / 1e8 × hbarUsd × 100)
 *   floorCents = aiCostCents + overheadCents
 *
 * Pure BigInt math, no floats. Rates come from resolveModelRates (which
 * throws for unknown models), the HBAR/USD rate from the active price feed.
 */
export function computeMinPriceCents(): PriceFloor {
  const model = getAnthropicModel();
  const rates = resolveModelRates(model);
  const inT = getMaxInputTokens();
  const outT = getMaxOutputTokens();

  // aiCostCents = ceil( ((inT×inNum×outDen + outT×outNum×inDen) × 3 × 100) / (1e6 × inDen × outDen × 2) )
  const inNum = inT * rates.input.num * rates.output.den;
  const outNum = outT * rates.output.num * rates.input.den;
  const costNum = (inNum + outNum) * SAFETY_MARGIN_NUM * 100n;
  const costDen = 1_000_000n * rates.input.den * rates.output.den * SAFETY_MARGIN_DEN;
  const aiCostCents = (costNum + costDen - 1n) / costDen; // integer ceil

  // overheadCents = ceil( overheadTinybars × hbarUsdNum × 100 / (1e8 × hbarUsdDen) )
  const rate = getActiveRate();
  const overheadTinybars = getOperatorOverheadTinybars();
  const ohNum = overheadTinybars * rate.num * 100n;
  const ohDen = 100_000_000n * rate.den;
  const overheadCents = (ohNum + ohDen - 1n) / ohDen; // integer ceil

  return {
    model,
    aiCostCents,
    overheadCents,
    floorCents: aiCostCents + overheadCents,
  };
}

/**
 * Enforce the startup price floor. Call AFTER refreshPriceFeed() and BEFORE
 * building the 402.
 *
 * Always logs the computed floor. When ANTHROPIC_API_KEY is set (real AI
 * mode) and the configured price is below the floor, THROWS — the server
 * refuses to boot rather than sell below cost. In mock ($0) mode the floor
 * does not apply: there is no AI cost to lose.
 */
export function enforceStartupPriceFloor(): void {
  const floor = computeMinPriceCents(); // throws for unknown model w/o overrides
  console.log(
    `[economics] price floor: ${floor.floorCents}¢/request ` +
      `(model=${floor.model}, worst-case AI=${floor.aiCostCents}¢ incl. 1.5x margin, ` +
      `operator overhead=${floor.overheadCents}¢)`,
  );
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[economics] no ANTHROPIC_API_KEY — mock ($0) mode, price floor does not apply");
    return;
  }
  const price = getPriceUsdCents();
  if (price < floor.floorCents) {
    throw new Error(
      `[economics] REFUSING TO START: PRICE_USD_CENTS=${price}¢ is below the ` +
        `break-even floor of ${floor.floorCents}¢/request for model "${floor.model}" ` +
        `(worst-case AI cost ${floor.aiCostCents}¢ + operator overhead ${floor.overheadCents}¢). ` +
        `Fix: raise PRICE_USD_CENTS to at least ${floor.floorCents}, or set ` +
        `ANTHROPIC_MODEL to a cheaper (haiku-class) model.`,
    );
  }
  console.log(
    `[economics] configured price ${price}¢/request >= floor ${floor.floorCents}¢ — ok`,
  );
}
