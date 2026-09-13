/**
 * HBAR/USD price feed for the x402 HBAR rail.
 *
 * The 402 advertises the HBAR rail priced in USD terms, converted to
 * tinybars at an HBAR/USD rate. A manually-set rate drifts silently, so
 * this module resolves the rate from a free live source with a graceful
 * fallback chain:
 *
 *   1. "live"    — CoinGecko free API (no key), cached for PRICE_TTL_MS
 *   2. "env"     — the HBAR_USD_PRICE env var (operator override)
 *   3. "default" — built-in DEFAULT_HBAR_USD_PRICE ("0.20")
 *
 * Every refresh logs which source is in use, so a log tail always shows
 * whether prices are live or degraded. Failures never throw: the worst
 * case is the operator's manual rate.
 *
 * Usage in the server:
 *   await refreshPriceFeed();          // at startup, before building the 402
 *   startPriceFeed({ onRefresh });     // background refresh + 402 hot-swap
 *
 * The pure math (parse + conversion) lives here so payment.ts stays thin;
 * payment.ts's getHbarUsdPrice() delegates to parseHbarUsdPrice().
 */

export type PriceSource = "live" | "env" | "default";

export interface HbarRate {
  num: bigint;
  den: bigint;
  /** Human-readable decimal, for logs and /health. */
  usd: number;
  source: PriceSource;
  fetchedAtMs: number;
}

/** Fallback rate when neither the live API nor the env var yields a rate. */
export const DEFAULT_HBAR_USD_PRICE = "0.20";

/** CoinGecko free endpoint (no API key). HBAR's CoinGecko id is "hedera-hashgraph". */
export const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=hedera-hashgraph&vs_currencies=usd";

/** How long a live rate is trusted before the next refresh (10 minutes). */
export const PRICE_TTL_MS = 10 * 60_000;

/**
 * Fail-closed staleness bound for the HBAR rail.
 *
 * The HBAR rail converts a USD quote to tinybars at the served HBAR/USD
 * rate, so a stale rate is a money risk: if HBAR crashes while the feed is
 * down, the server collects fewer USD-cents of value than the quote while
 * the Anthropic cost stays in USD. The 10-minute TTL bounds this while the
 * feed is healthy, and the 1.5x price-floor margin absorbs one TTL of drift.
 * A CoinGecko OUTAGE removes the TTL bound — without a cap, the server
 * would price at the env/default fallback indefinitely.
 *
 * Rule: when the live feed has not confirmed a rate for longer than
 * PRICE_MAX_STALENESS_MS (default 1 hour), the HBAR rail is UNSAFE and the
 * server suspends it — the 402 advertises USDC only until the live feed
 * recovers. USDC pricing is USD-exact (1 cent = 10_000 base units), so it
 * carries no FX risk and the "never loses money" invariant holds.
 */
export const DEFAULT_MAX_STALENESS_MS = 60 * 60_000;

/**
 * Maximum age of the last live-confirmed rate before the HBAR rail is
 * suspended. Env override PRICE_MAX_STALENESS_MS (milliseconds, positive
 * integer). Throws on garbage so a misconfiguration fails LOUDLY at boot
 * instead of silently disabling the safety bound.
 */
export function getMaxStalenessMs(): number {
  const raw = process.env.PRICE_MAX_STALENESS_MS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_STALENESS_MS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || BigInt(trimmed) <= 0n) {
    throw new Error(
      `PRICE_MAX_STALENESS_MS must be a positive integer of milliseconds (got "${raw}")`,
    );
  }
  return Number(BigInt(trimmed));
}

/** HTTP timeout for the live price fetch (8s — never block startup long). */
export const PRICE_FETCH_TIMEOUT_MS = 8_000;

/**
 * Parse a decimal HBAR/USD rate string into an exact { num, den } rational.
 * No floating point anywhere: "0.1983" -> { num: 1983n, den: 10000n }.
 * Throws on anything that isn't a positive decimal number.
 */
export function parseHbarUsdPrice(raw: string): { num: bigint; den: bigint } {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!m) {
    throw new Error(`HBAR/USD rate must be a positive decimal number (got "${raw}")`);
  }
  const decimals = m[2] ?? "";
  const num = BigInt(m[1] + decimals);
  const den = 10n ** BigInt(decimals.length);
  if (num <= 0n) {
    throw new Error(`HBAR/USD rate must be positive (got "${raw}")`);
  }
  return { num, den };
}

/** Minimal fetch shape the feed needs (lets tests inject a stub). */
export type PriceFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Fetch the live HBAR/USD rate from CoinGecko. Returns null on ANY
 * failure (network, timeout, bad payload, non-positive price) — the
 * caller falls back to env/default. Never throws.
 */
export async function fetchLiveHbarUsdPrice(
  fetchFn: PriceFetch = fetch as unknown as PriceFetch,
  timeoutMs: number = PRICE_FETCH_TIMEOUT_MS,
): Promise<{ num: bigint; den: bigint; usd: number } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(COINGECKO_URL, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    const usd = (data as { "hedera-hashgraph"?: { usd?: unknown } })?.[
      "hedera-hashgraph"
    ]?.usd;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return null;
    // Convert via the decimal string to keep the rational exact. Reject
    // exponent notation (can't happen at sane HBAR prices) rather than
    // silently rounding.
    const str = usd.toString();
    if (/[eE]/.test(str)) return null;
    const { num, den } = parseHbarUsdPrice(str);
    return { num, den, usd };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The operator's manual override, or null when unset/unparseable. */
function envRate(): { num: bigint; den: bigint; usd: number } | null {
  const raw = process.env.HBAR_USD_PRICE;
  if (!raw || !raw.trim()) return null;
  try {
    const { num, den } = parseHbarUsdPrice(raw);
    return { num, den, usd: Number(num) / Number(den) };
  } catch {
    return null;
  }
}

// Module state: the last successfully refreshed rate, or null when the
// feed has never refreshed (server then reads the env/default directly).
let activeRate: HbarRate | null = null;

// ms epoch of the last SUCCESSFUL live refresh, or null when the live feed
// has never confirmed a rate since the module loaded. This is the
// fail-closed staleness baseline: isHbarRateStale() measures from here, so a
// prolonged CoinGecko outage suspends the HBAR rail instead of pricing at
// an arbitrarily old fallback forever.
const FEED_BOOT_MS = Date.now();
let lastLiveAtMs: number | null = null;

/** Clear the refreshed state (tests). After this, getActiveRate() reads env/default. */
export function resetPriceFeed(): void {
  activeRate = null;
  lastLiveAtMs = null;
}

/**
 * Resolve the currently active rate WITHOUT doing I/O: the last refreshed
 * rate if there is one, else the env var, else the built-in default.
 * This is what priceTinybars() uses, so existing env-based behavior is
 * identical until the first refresh lands.
 */
export function getActiveRate(): {
  num: bigint;
  den: bigint;
  usd: number;
  source: PriceSource;
  /** ms epoch of the last refresh, or null when never refreshed. */
  fetchedAtMs: number | null;
} {
  if (activeRate) {
    return {
      num: activeRate.num,
      den: activeRate.den,
      usd: activeRate.usd,
      source: activeRate.source,
      fetchedAtMs: activeRate.fetchedAtMs,
    };
  }
  const env = envRate();
  if (env) return { ...env, source: "env" as const, fetchedAtMs: null };
  const { num, den } = parseHbarUsdPrice(DEFAULT_HBAR_USD_PRICE);
  return {
    num,
    den,
    usd: Number(num) / Number(den),
    source: "default" as const,
    fetchedAtMs: null,
  };
}

/**
 * Fail-closed staleness check for the HBAR rail.
 *
 * Returns false while the active rate is live-confirmed. Otherwise measures
 * the time since the last live confirmation (or since module load when the
 * live feed never confirmed a rate) against PRICE_MAX_STALENESS_MS. When
 * true, the HBAR rail must be suspended (USDC only) — pricing tinybars at
 * an ancient fallback rate can collect less USD value than the quote while
 * the Anthropic cost stays in USD.
 */
export function isHbarRateStale(nowMs: number = Date.now()): boolean {
  // Measured from the last LIVE confirmation on purpose: a failed refresh
  // re-stamps the fallback rate with a fresh timestamp, and a dead refresh
  // loop would otherwise leave a "live" label on an ancient rate forever.
  const baseline = lastLiveAtMs ?? FEED_BOOT_MS;
  return nowMs - baseline > getMaxStalenessMs();
}

/**
 * Refresh the feed: try live, fall back to env, then the built-in default.
 * Logs the chosen source. Never throws — the worst case is a degraded
 * source, never a crashed server.
 */
export async function refreshPriceFeed(
  fetchFn: PriceFetch = fetch as unknown as PriceFetch,
): Promise<HbarRate> {
  const live = await fetchLiveHbarUsdPrice(fetchFn);
  let rate: HbarRate;
  if (live) {
    rate = { ...live, source: "live", fetchedAtMs: Date.now() };
  } else {
    const env = envRate();
    if (env) {
      rate = { ...env, source: "env", fetchedAtMs: Date.now() };
    } else {
      const { num, den } = parseHbarUsdPrice(DEFAULT_HBAR_USD_PRICE);
      rate = {
        num,
        den,
        usd: Number(num) / Number(den),
        source: "default",
        fetchedAtMs: Date.now(),
      };
    }
  }
  activeRate = rate;
  if (rate.source === "live") lastLiveAtMs = rate.fetchedAtMs;
  console.log(
    `[price] HBAR/USD = $${rate.usd} (source=${rate.source})` +
      (rate.source === "live"
        ? ""
        : " — live feed unreachable, using fallback; 402 prices may drift from market"),
  );
  return rate;
}

export interface PriceFeedOptions {
  /** Refresh cadence (default PRICE_TTL_MS). */
  intervalMs?: number;
  /** Called after every successful refresh (e.g. to hot-swap the 402). */
  onRefresh?: (rate: HbarRate) => void;
  /** Injectable fetch for tests. */
  fetchFn?: PriceFetch;
}

/**
 * Start the background refresh loop. The first refresh already happened
 * (call refreshPriceFeed() at startup and await it); this schedules the
 * rest. Returns a stop function. The timer is unref'd so it never keeps
 * a test process or CLI alive.
 */
export function startPriceFeed(options: PriceFeedOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? PRICE_TTL_MS;
  const timer = setInterval(() => {
    refreshPriceFeed(options.fetchFn)
      .then((rate) => options.onRefresh?.(rate))
      .catch((e) => console.error("[price] background refresh failed:", e));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
