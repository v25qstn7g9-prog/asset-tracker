/**
 * quote.js — 4.6-quote-stable-10
 *
 * Stability strategy for 漲跌幅:
 * 1. TWSE `y` is preferred prevClose (matches brokers); Yahoo is final fallback only.
 * 2. Edge-cache each symbol's prevClose for the calendar day so intermittent
 *    TWSE failures don't fall through to Yahoo's wrong previous bar.
 * 3. Yahoo may supply price, and only supplies prevClose when TWSE/cache are unavailable —
 *    and even then, derived from date-matched daily bars, not the raw
 *    meta.regularMarketPreviousClose field (observed stale for TW ETFs).
 * 4. Retry TWSE once for 500/502/503/504/522/524 (520 excluded — observed to
 *    fail identically on retry, so it only adds latency for this endpoint).
 * 5. ?debug=1 surfaces raw TWSE fields + which fallback path was used.
 */

const SYMBOL_PATTERN = /^[0-9]{4,6}[A-Z]?$/;
const QUOTE_VERSION = "4.6-quote-stable-10";

function isAllowedSymbol(s) {
  return SYMBOL_PATTERN.test(s);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
      "pragma": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

function taiwanDateStr(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return t.toISOString().slice(0, 10);
}

function isTaiwanTradingHours(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const day = t.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = t.getUTCHours() * 60 + t.getUTCMinutes();
  return minutes >= 9 * 60 && minutes <= 13 * 60 + 30;
}

async function fetchJson(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "application/json,text/plain,*/*",
        "user-agent": "Mozilla/5.0 (compatible; StockTracker/4.6-v2)",
        "referer": "https://mis.twse.com.tw/",
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function firstNumber(s) {
  if (!s || s === "-") return NaN;

  const part = String(s)
    .split("_")
    .find((x) => x && x !== "-");

  const n = Number(part);

  return Number.isFinite(n) ? n : NaN;
}

/**
 * TWSE row parser.
 *
 * IMPORTANT:
 * Do NOT use opening price as the current/closing price.
 *
 * Priority:
 * last trade -> bid/ask midpoint -> ask -> bid
 *
 * If none exists, price remains null and Yahoo gets a chance
 * to provide the latest/closing price.
 */
function parseTwseItem(item) {
  const prevClose = Number(item.y);

  if (!Number.isFinite(prevClose) || prevClose <= 0) {
    return null;
  }

  let price = NaN;
  let priceSource = null;

  if (
    item.z &&
    item.z !== "-" &&
    Number.isFinite(Number(item.z))
  ) {
    price = Number(item.z);
    priceSource = "last";
  } else {
    const bid = firstNumber(item.b);
    const ask = firstNumber(item.a);

    if (
      Number.isFinite(bid) &&
      Number.isFinite(ask) &&
      bid > 0 &&
      ask > 0
    ) {
      price =
        Math.round(((bid + ask) / 2) * 100) / 100;

      priceSource = "mid";
    } else if (
      Number.isFinite(ask) &&
      ask > 0
    ) {
      price = ask;
      priceSource = "ask";
    } else if (
      Number.isFinite(bid) &&
      bid > 0
    ) {
      price = bid;
      priceSource = "bid";
    }
  }

  const tickMs = Number(item.tlong);

  const asOfDate =
    Number.isFinite(tickMs)
      ? new Date(tickMs).toISOString()
      : null;

  return {
    prevClose,
    price: Number.isFinite(price)
      ? price
      : null,
    priceSource,
    asOfDate,
  };
}

async function fetchTwseBatch(symbols, debug = false) {
  const exCh = symbols
    .map((s) => `tse_${s}.tw`)
    .join("|");

  const url =
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp` +
    `?ex_ch=${encodeURIComponent(exCh)}` +
    `&json=1` +
    `&delay=0` +
    `&_ts=${Date.now()}`;

  const data = await fetchJson(url, 4000);

  if (!data || !Array.isArray(data.msgArray)) {
    throw new Error("TWSE invalid response");
  }

  const quotes = {};

  for (const item of data.msgArray) {
    const symbol = String(item.c || "");

    if (!symbols.includes(symbol)) {
      continue;
    }

    const parsed = parseTwseItem(item);

    if (!parsed) {
      continue;
    }

    quotes[symbol] = {
      price: parsed.price,
      prevClose: parsed.prevClose,
      isStale: parsed.price == null,
      asOfDate: parsed.asOfDate,
      source: "TWSE",
      priceSource: parsed.priceSource,
    };

    if (debug) {
      quotes[symbol].debug = {
        rawY: item.y,
        rawZ: item.z,
        rawTlong: item.tlong,
        rawA: item.a,
        rawB: item.b,
        rawO: item.o,
        rawN: item.n,
      };
    }
  }

  return quotes;
}

/**
 * Retry TWSE once.
 *
 * stable-8/9 change:
 * Temporary server errors such as
 * 500/502/503/504/522/524
 * are allowed one retry. 520 is excluded (see file header) — it has been
 * observed to fail identically on immediate retry against this endpoint.
 */
async function fetchTwseWithRetry(
  symbols,
  debug = false
) {
  try {
    return await fetchTwseBatch(
      symbols,
      debug
    );
  } catch (e1) {
    const msg1 =
      String(e1?.message || e1);

    const httpMatch =
      msg1.match(/^HTTP (\d+)$/);

    const status =
      httpMatch
        ? Number(httpMatch[1])
        : null;

    const retryableHttp =
      status != null &&
      [
        500,
        502,
        503,
        504,
        522,
        524,
      ].includes(status);

    const nonRetryableHttp =
      status != null &&
      !retryableHttp;

    if (nonRetryableHttp) {
      throw new Error(
        `TWSE: ${msg1}`
      );
    }

    await new Promise(
      (resolve) =>
        setTimeout(resolve, 250)
    );

    try {
      return await fetchTwseBatch(
        symbols,
        debug
      );
    } catch (e2) {
      throw new Error(
        `TWSE: ${msg1}; retry: ${
          e2?.message || e2
        }`
      );
    }
  }
}

/**
 * Converts a Unix timestamp (seconds) to a "YYYY-MM-DD" string in Taipei
 * time (UTC+8, no DST) — used to match daily bars to real trading dates.
 */
function taipeiDateStr(unixSeconds) {
  const d = new Date((unixSeconds + 8 * 3600) * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Yahoo fallback.
 *
 * stable-8:
 * Yahoo may provide BOTH price and prevClose,
 * but its prevClose is only used if TWSE and
 * today's edge cache have no prevClose.
 *
 * stable-9: meta.regularMarketPreviousClose has been observed to be a full
 * trading day stale for some TW ETFs (0050/0056 on 2026-09-02 — it matched
 * two days back instead of yesterday, while it was correct for 2330 in the
 * same request). A cached field can't be "guessed" wrong the way a bar
 * anchored to a real calendar date can, so prevClose is derived from the
 * daily bars (matched to actual Taipei trading dates) instead of trusting
 * that field directly. Falls back to the meta field only if the bars don't
 * have enough history to do that (e.g. a very new listing).
 */
async function fetchYahooPrice(symbol) {
  const yahooSymbol = `${symbol}.TW`;
  const encoded = encodeURIComponent(yahooSymbol);

  // Intraday bars are required during market hours. The old stable-9 path
  // used only interval=1d, which can remain on yesterday's close early in
  // the session and therefore look like a "live" 0.00% quote.
  const intradayUrl =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}` +
    `?interval=1m&range=1d&_ts=${Date.now()}`;

  const dailyUrl =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}` +
    `?interval=1d&range=5d&_ts=${Date.now()}`;

  const [intradayResult, dailyResult] = await Promise.allSettled([
    fetchJson(intradayUrl, 6500),
    fetchJson(dailyUrl, 6500),
  ]);

  let price = null;
  let priceAsOf = null;
  let intradayFresh = false;

  if (intradayResult.status === "fulfilled") {
    const r = intradayResult.value?.chart?.result?.[0];
    const timestamps = Array.isArray(r?.timestamp) ? r.timestamp : [];
    const closes = r?.indicators?.quote?.[0]?.close || [];

    for (let i = Math.min(timestamps.length, closes.length) - 1; i >= 0; i--) {
      const c = Number(closes[i]);
      if (Number.isFinite(c) && c > 0) {
        price = c;
        priceAsOf = new Date(Number(timestamps[i]) * 1000).toISOString();

        // Consider the intraday quote fresh only if its last bar is from
        // today's Taipei trading date. This prevents yesterday's last bar
        // from masquerading as a current quote.
        const today = taiwanDateStr();
        const barDay = taipeiDateStr(Number(timestamps[i]));
        intradayFresh = barDay === today;
        break;
      }
    }

    if (!Number.isFinite(price)) {
      const metaPrice = Number(r?.meta?.regularMarketPrice);
      if (Number.isFinite(metaPrice) && metaPrice > 0) {
        price = metaPrice;
      }
    }
  }

  let prevClose = null;
  let dailyLatest = null;

  if (dailyResult.status === "fulfilled") {
    const r = dailyResult.value?.chart?.result?.[0];
    const meta = r?.meta || {};
    const timestamps = Array.isArray(r?.timestamp) ? r.timestamp : [];
    const closes = r?.indicators?.quote?.[0]?.close || [];

    const valid = [];
    for (let i = 0; i < Math.min(timestamps.length, closes.length); i++) {
      const c = Number(closes[i]);
      if (Number.isFinite(c) && c > 0) {
        valid.push({
          day: taipeiDateStr(Number(timestamps[i])),
          close: c,
        });
      }
    }

    const today = taiwanDateStr();
    const todayIndex = valid.findIndex((x) => x.day === today);

    if (todayIndex >= 0) {
      dailyLatest = valid[todayIndex].close;
      if (todayIndex > 0) prevClose = valid[todayIndex - 1].close;
    } else if (valid.length) {
      // No daily bar for today yet: the latest completed daily bar IS the
      // previous close, not the current live price.
      prevClose = valid[valid.length - 1].close;
      dailyLatest = valid[valid.length - 1].close;
    }

    if (!Number.isFinite(prevClose) || prevClose <= 0) {
      prevClose = Number(meta.regularMarketPreviousClose ?? meta.chartPreviousClose);
    }

    // Outside intraday availability, a completed daily close is still useful
    // after the market has closed.
    if (!Number.isFinite(price) && Number.isFinite(dailyLatest)) {
      price = dailyLatest;
    }
  }

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Yahoo no price");
  }

  return {
    price,
    prevClose: Number.isFinite(prevClose) && prevClose > 0 ? prevClose : null,
    asOfDate: priceAsOf,
    source: "Yahoo",
    intradayFresh,
  };
}

/**
 * Edge cache:
 * remember TWSE prevClose for Taiwan calendar day.
 */
async function readPrevCloseCache(
  symbol,
  day
) {
  try {
    const key =
      new Request(
        `https://quote-cache.local/prev/${day}/${symbol}`
      );

    const hit =
      await caches.default.match(key);

    if (!hit) {
      return null;
    }

    const j =
      await hit.json();

    return Number.isFinite(
      j?.prevClose
    )
      ? j.prevClose
      : null;
  } catch {
    return null;
  }
}

async function writePrevCloseCache(
  symbol,
  day,
  prevClose
) {
  try {
    const key =
      new Request(
        `https://quote-cache.local/prev/${day}/${symbol}`
      );

    const body =
      JSON.stringify({
        prevClose,
        day,
        symbol,
      });

    await caches.default.put(
      key,
      new Response(body, {
        headers: {
          "content-type":
            "application/json",

          "cache-control":
            "public, max-age=72000",
        },
      })
    );
  } catch {
    // Cache is optional.
  }
}

export async function onRequestGet(
  context
) {
  try {
    const url =
      new URL(
        context.request.url
      );

    const requested =
      (
        url.searchParams.get(
          "symbols"
        ) ||
        "0050,0056,2330"
      )
        .split(",")
        .map((s) =>
          s
            .trim()
            .toUpperCase()
        )
        .filter(Boolean);

    const symbols =
      [...new Set(requested)]
        .filter(
          isAllowedSymbol
        );

    if (!symbols.length) {
      return jsonResponse(
        {
          error:
            "沒有允許的股票代號",
        },
        400
      );
    }

    const debug =
      url.searchParams.get(
        "debug"
      ) === "1";

    const day =
      taiwanDateStr();

    const quotes = {};
    const errors = [];

    /*
     * 1) TWSE first.
     */
    try {
      Object.assign(
        quotes,
        await fetchTwseWithRetry(
          symbols,
          debug
        )
      );
    } catch (e) {
      errors.push(
        String(
          e?.message || e
        )
      );
    }

    /*
     * 2) Cache every successful
     *    TWSE prevClose.
     */
    for (
      const [sym, q]
      of Object.entries(quotes)
    ) {
      if (
        Number.isFinite(
          q.prevClose
        )
      ) {
        await writePrevCloseCache(
          sym,
          day,
          q.prevClose
        );
      }
    }

    /*
     * 3) Restore missing prevClose
     *    from today's cache.
     */
    for (const sym of symbols) {
      if (
        quotes[sym] &&
        Number.isFinite(
          quotes[sym].prevClose
        )
      ) {
        continue;
      }

      const cached =
        await readPrevCloseCache(
          sym,
          day
        );

      if (cached != null) {
        if (!quotes[sym]) {
          quotes[sym] = {
            price: null,
            prevClose: cached,
            isStale: true,
            asOfDate: null,
            source: "cache",
            priceSource: null,
          };
        } else {
          quotes[sym].prevClose =
            cached;

          if (
            quotes[sym].source ===
            "Yahoo"
          ) {
            quotes[sym].source =
              "cache+Yahoo";
          } else if (
            !quotes[sym].source
          ) {
            quotes[sym].source =
              "cache";
          }
        }

        if (debug) {
          quotes[sym].debug = {
            ...(
              quotes[sym].debug ||
              {}
            ),

            usedCachedPrevClose:
              true,
          };
        }
      }
    }

    /*
     * 4) Any symbol without a usable
     *    price goes to Yahoo.
     *
     * This also handles the
     * post-close case where TWSE
     * doesn't provide z/bid/ask.
     */
    const needPrice =
      symbols.filter((s) => {
        const q =
          quotes[s];

        return (
          !q ||
          q.price == null ||
          !Number.isFinite(
            q.price
          )
        );
      });

    if (needPrice.length) {
      const results =
        await Promise.allSettled(
          needPrice.map(
            fetchYahooPrice
          )
        );

      results.forEach(
        (result, i) => {
          const symbol =
            needPrice[i];

          if (
            result.status !==
            "fulfilled"
          ) {
            errors.push(
              `Yahoo ${symbol}: ${
                result.reason
                  ?.message ||
                result.reason
              }`
            );

            if (
              quotes[symbol] &&
              quotes[symbol]
                .price == null &&
              Number.isFinite(
                quotes[symbol]
                  .prevClose
              )
            ) {
              quotes[symbol]
                .price =
                quotes[symbol]
                  .prevClose;

              quotes[symbol]
                .priceSource =
                "prev";

              quotes[symbol]
                .isStale =
                true;
            }

            return;
          }

          const yq =
            result.value;

          /*
           * TWSE/cache already has
           * trustworthy prevClose:
           * keep it, only take
           * Yahoo price.
           */
          if (
            quotes[symbol] &&
            Number.isFinite(
              quotes[symbol]
                .prevClose
            )
          ) {
            quotes[symbol] = {
              price:
                yq.price,

              prevClose:
                quotes[symbol]
                  .prevClose,

              isStale:
                !yq.intradayFresh &&
                isTaiwanTradingHours(),

              asOfDate:
                yq.asOfDate,

              source:
                quotes[symbol]
                  .source ===
                "cache"
                  ? "cache+Yahoo"
                  : "TWSE+Yahoo",

              priceSource:
                "yahoo",
            };
          } else {
            /*
             * Final fallback:
             *
             * TWSE failed AND today's
             * cache has no prevClose.
             *
             * Yahoo's previous close is
             * now allowed.
             */
            const yahooPrev =
              Number.isFinite(
                yq.prevClose
              ) &&
              yq.prevClose > 0
                ? yq.prevClose
                : yq.price;

            quotes[symbol] = {
              price:
                yq.price,

              prevClose:
                yahooPrev,

              isStale:
                (!yq.intradayFresh &&
                 isTaiwanTradingHours()) ||
                !Number.isFinite(
                  yq.prevClose
                ) ||
                yq.prevClose <= 0,

              asOfDate:
                yq.asOfDate,

              source:
                "Yahoo",

              priceSource:
                "yahoo",

              warning:
                Number.isFinite(
                  yq.prevClose
                ) &&
                yq.prevClose > 0
                  ? undefined
                  : "no_prevClose_available",
            };
          }
        }
      );
    }

    /*
     * 5) Final sanitize.
     */
    for (
      const s
      of Object.keys(quotes)
    ) {
      if (
        quotes[s].price == null ||
        !Number.isFinite(
          quotes[s].price
        )
      ) {
        delete quotes[s];
      }
    }

    if (
      !Object.keys(quotes)
        .length
    ) {
      return jsonResponse(
        {
          error:
            "所有報價來源皆失敗",

          details:
            errors,

          version:
            QUOTE_VERSION,
        },
        502
      );
    }

    const sources =
      [
        ...new Set(
          Object
            .values(quotes)
            .map(
              (q) =>
                q.source
            )
        ),
      ];

    return jsonResponse({
      ok: true,

      version:
        QUOTE_VERSION,

      source:
        sources.join("+"),

      fetchedAt:
        new Date()
          .toISOString(),

      day,

      quotes,

      missing:
        symbols.filter(
          (s) =>
            !quotes[s]
        ),

      warnings:
        errors,
    });
  } catch (e) {
    return jsonResponse(
      {
        error:
          e?.message ||
          "quote function failed",

        version:
          QUOTE_VERSION,
      },
      500
    );
  }
}
