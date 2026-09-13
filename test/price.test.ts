/**
 * HBAR/USD price feed: exact rational parsing, live-fetch with fallback
 * chain (live -> env -> default), caching, and background refresh.
 * No keys needed; the live fetch is stubbed.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  COINGECKO_URL,
  DEFAULT_HBAR_USD_PRICE,
  DEFAULT_MAX_STALENESS_MS,
  fetchLiveHbarUsdPrice,
  getActiveRate,
  getMaxStalenessMs,
  isHbarRateStale,
  parseHbarUsdPrice,
  PRICE_TTL_MS,
  refreshPriceFeed,
  resetPriceFeed,
  startPriceFeed,
  type PriceFetch,
} from "../src/price.js";

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

/** Async variant of withEnv — env stays set until the promise settles. */
async function withEnvAsync(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k]!;
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

/** Stub fetch returning a fixed CoinGecko-shaped payload. */
function stubFetch(payload: unknown, ok = true): PriceFetch {
  return async (url: string) => {
    assert.equal(url, COINGECKO_URL);
    return { ok, status: ok ? 200 : 500, json: async () => payload };
  };
}

const coingeckoOk = (usd: number) =>
  stubFetch({ "hedera-hashgraph": { usd } });

describe("parseHbarUsdPrice", () => {
  it("parses decimals into exact rationals", () => {
    assert.deepEqual(parseHbarUsdPrice("0.20"), { num: 20n, den: 100n });
    assert.deepEqual(parseHbarUsdPrice("1.5"), { num: 15n, den: 10n });
    assert.deepEqual(parseHbarUsdPrice("2"), { num: 2n, den: 1n });
    assert.deepEqual(parseHbarUsdPrice("0.1983"), { num: 1983n, den: 10000n });
  });

  it("rejects garbage and non-positive rates", () => {
    for (const bad of ["abc", "", "  ", "-1", "0", "0.0", "1.2.3", "1e5"]) {
      assert.throws(() => parseHbarUsdPrice(bad), /positive/);
    }
  });
});

describe("fetchLiveHbarUsdPrice", () => {
  it("returns an exact rational for a valid CoinGecko payload", async () => {
    const r = await fetchLiveHbarUsdPrice(coingeckoOk(0.1983));
    assert.ok(r);
    assert.equal(r.num, 1983n);
    assert.equal(r.den, 10000n);
    assert.equal(r.usd, 0.1983);
  });

  it("returns null on network failure", async () => {
    const boom: PriceFetch = async () => {
      throw new Error("no network");
    };
    assert.equal(await fetchLiveHbarUsdPrice(boom, 50), null);
  });

  it("returns null on bad payloads", async () => {
    assert.equal(await fetchLiveHbarUsdPrice(stubFetch({}, false), 50), null);
    assert.equal(await fetchLiveHbarUsdPrice(stubFetch({}), 50), null);
    assert.equal(
      await fetchLiveHbarUsdPrice(coingeckoOk(0), 50),
      null,
    );
    assert.equal(
      await fetchLiveHbarUsdPrice(coingeckoOk(-3), 50),
      null,
    );
    assert.equal(
      await fetchLiveHbarUsdPrice(coingeckoOk(NaN), 50),
      null,
    );
  });
});

describe("refreshPriceFeed fallback chain", () => {
  beforeEach(() => resetPriceFeed());

  it("prefers the live rate and reports source=live", async () => {
    const rate = await refreshPriceFeed(coingeckoOk(0.25));
    assert.equal(rate.source, "live");
    assert.equal(rate.num, 25n);
    assert.equal(rate.den, 100n);
    assert.equal(rate.usd, 0.25);
    assert.ok(rate.fetchedAtMs > 0);
    const active = getActiveRate();
    assert.equal(active.source, "live");
    assert.equal(active.num, 25n);
  });

  it("falls back to the env var when the API is unreachable", async () => {
    const boom: PriceFetch = async () => {
      throw new Error("down");
    };
    await withEnvAsync({ HBAR_USD_PRICE: "0.30" }, async () => {
      const rate = await refreshPriceFeed(boom);
      assert.equal(rate.source, "env");
      assert.equal(rate.num, 30n);
      assert.equal(rate.den, 100n);
    });
  });

  it("falls back to the built-in default when API and env both fail", async () => {
    const boom: PriceFetch = async () => {
      throw new Error("down");
    };
    await withEnvAsync({ HBAR_USD_PRICE: undefined }, async () => {
      const rate = await refreshPriceFeed(boom);
      assert.equal(rate.source, "default");
      const def = parseHbarUsdPrice(DEFAULT_HBAR_USD_PRICE);
      assert.equal(rate.num, def.num);
      assert.equal(rate.den, def.den);
    });
  });

  it("ignores a garbage env var and uses the default", async () => {
    const boom: PriceFetch = async () => {
      throw new Error("down");
    };
    await withEnvAsync({ HBAR_USD_PRICE: "nonsense" }, async () => {
      const rate = await refreshPriceFeed(boom);
      assert.equal(rate.source, "default");
    });
  });
});

describe("getActiveRate without refresh", () => {
  beforeEach(() => resetPriceFeed());

  it("reads the env var directly (source=env)", () => {
    withEnv({ HBAR_USD_PRICE: "0.10" }, () => {
      const r = getActiveRate();
      assert.equal(r.source, "env");
      assert.equal(r.num, 10n);
      assert.equal(r.den, 100n);
      assert.equal(r.fetchedAtMs, null);
    });
  });

  it("reads the default when the env var is unset (source=default)", () => {
    withEnv({ HBAR_USD_PRICE: undefined }, () => {
      const r = getActiveRate();
      assert.equal(r.source, "default");
      const def = parseHbarUsdPrice(DEFAULT_HBAR_USD_PRICE);
      assert.equal(r.num, def.num);
      assert.equal(r.den, def.den);
    });
  });
});

describe("startPriceFeed", () => {
  it("refreshes on an interval and stops cleanly", async () => {
    resetPriceFeed();
    let calls = 0;
    const stop = startPriceFeed({
      intervalMs: 40,
      fetchFn: async () => {
        calls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ "hedera-hashgraph": { usd: 0.21 } }),
        };
      },
      onRefresh: (rate) => {
        assert.equal(rate.source, "live");
      },
    });
    await new Promise((r) => setTimeout(r, 150));
    stop();
    resetPriceFeed();
    assert.ok(calls >= 2, `expected >= 2 refreshes, got ${calls}`);
  });
});

describe("price constants", () => {
  it("has a sane TTL (5–15 minutes)", () => {
    assert.ok(
      PRICE_TTL_MS >= 5 * 60_000 && PRICE_TTL_MS <= 15 * 60_000,
      `TTL ${PRICE_TTL_MS}ms out of range`,
    );
  });
});

describe("HBAR rail staleness fail-closed", () => {
  beforeEach(() => resetPriceFeed());

  it("is not stale while the active rate is live-confirmed", async () => {
    await refreshPriceFeed(coingeckoOk(0.25));
    assert.equal(getActiveRate().source, "live");
    assert.equal(isHbarRateStale(), false);
  });

  it("goes stale when the live feed has been down past the bound", async () => {
    await refreshPriceFeed(coingeckoOk(0.25));
    const maxMs = getMaxStalenessMs();
    assert.equal(isHbarRateStale(Date.now() + maxMs - 1_000), false);
    assert.equal(isHbarRateStale(Date.now() + maxMs + 1_000), true);
  });

  it("measures staleness from the last LIVE confirmation, not the fallback refresh", async () => {
    const t0 = Date.now();
    await refreshPriceFeed(coingeckoOk(0.25));
    // Outage: the fallback refresh re-stamps fetchedAtMs, but staleness is
    // still measured from the last live confirmation.
    const boom: PriceFetch = async () => {
      throw new Error("down");
    };
    await withEnvAsync({ HBAR_USD_PRICE: "0.30" }, async () => {
      await refreshPriceFeed(boom);
      assert.equal(getActiveRate().source, "env");
      const maxMs = getMaxStalenessMs();
      assert.equal(isHbarRateStale(t0 + maxMs - 1_000), false);
      assert.equal(isHbarRateStale(t0 + maxMs + 1_000), true);
    });
  });

  it("defaults the staleness bound to one hour", () => {
    withEnv({ PRICE_MAX_STALENESS_MS: undefined }, () => {
      assert.equal(getMaxStalenessMs(), DEFAULT_MAX_STALENESS_MS);
      assert.equal(DEFAULT_MAX_STALENESS_MS, 3_600_000);
    });
  });

  it("honors the PRICE_MAX_STALENESS_MS override", async () => {
    await withEnvAsync({ PRICE_MAX_STALENESS_MS: "60000" }, async () => {
      assert.equal(getMaxStalenessMs(), 60_000);
      await refreshPriceFeed(coingeckoOk(0.25));
      assert.equal(isHbarRateStale(Date.now() + 59_000), false);
      assert.equal(isHbarRateStale(Date.now() + 61_000), true);
    });
  });

  it("rejects garbage PRICE_MAX_STALENESS_MS loudly", () => {
    withEnv({ PRICE_MAX_STALENESS_MS: "soon" }, () => {
      assert.throws(() => getMaxStalenessMs(), /PRICE_MAX_STALENESS_MS/);
    });
    withEnv({ PRICE_MAX_STALENESS_MS: "0" }, () => {
      assert.throws(() => getMaxStalenessMs(), /PRICE_MAX_STALENESS_MS/);
    });
    withEnv({ PRICE_MAX_STALENESS_MS: "-5" }, () => {
      assert.throws(() => getMaxStalenessMs(), /PRICE_MAX_STALENESS_MS/);
    });
  });

  it("resetPriceFeed clears the live baseline (test isolation)", async () => {
    await refreshPriceFeed(coingeckoOk(0.25));
    resetPriceFeed();
    // No live confirmation since reset: baseline is module boot (seconds
    // ago), well inside the default 1h bound — not stale.
    assert.equal(isHbarRateStale(), false);
  });
});
