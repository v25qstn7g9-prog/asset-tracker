// Taiwan listed/OTC ticker shapes: 4-6 digits, optional trailing letter.
const SYMBOL_PATTERN = /^[0-9]{4,6}[A-Z]?$/;
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

async function fetchJson(url, timeoutMs = 7000, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "application/json,text/plain,*/*",
        "user-agent": "Mozilla/5.0 (compatible; StockTracker/4.6-v2)",
        "referer": "https://mis.twse.com.tw/",
        ...extraHeaders,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { data: await res.json(), headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

/** First numeric token from TWSE underscore-separated list (bid/ask ladder). */
function firstNumber(s) {
  if (!s || s === "-") return NaN;
  const part = String(s).split("_").find((x) => x && x !== "-");
  const n = Number(part);
  return Number.isFinite(n) ? n : NaN;
}

// TWSE's getStockInfo.jsp is meant to be called from a browser session that
// first loaded mis.twse.com.tw/stock/index.jsp (that request sets a
// JSESSIONID cookie). Every community implementation of this API does that
// session step first — see e.g. the Python notebook at
// github.com/victorgau/investment ("台股即時股價資料.ipynb"), which explicitly
// does `req.get(SESSION_URL)` before the quote call. This function was
// calling getStockInfo.jsp cold, with no cookie at all, on every single
// request. TWSE tolerates that (no error), but without a session it can
// silently serve a coarser/delayed snapshot instead of the live tick —
// which matches the symptom reported: prices a little off (and even the
// wrong side of prevClose) compared to a broker app checked at the same
// moment. A serverless function gets a fresh runtime often enough that
// "just reuse the cookie from last time" isn't free, so the session is
// cached at module scope for a few minutes and only re-established when
// it's missing or stale — most invocations reuse a warm session instead of
// paying the extra round-trip.
let cachedSession = null; // { cookie, at }
const SESSION_TTL_MS = 5 * 60 * 1000;

async function getTwseSessionCookie() {
  if (cachedSession && Date.now() - cachedSession.at < SESSION_TTL_MS) {
    return cachedSession.cookie;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let res;
    try {
      res = await fetch("https://mis.twse.com.tw/stock/index.jsp", {
        signal: controller.signal,
        headers: {
          "accept": "text/html",
          "user-agent": "Mozilla/5.0 (compatible; StockTracker/4.6-v2)",
        },
      });
    } finally {
      clearTimeout(timer);
    }
    const setCookie = res.headers.get("set-cookie") || "";
    // Only the session id matters for the follow-up request; strip
    // Path/Expires/etc attributes that come after the first ";".
    const cookie = setCookie.split(";")[0] || null;
    cachedSession = { cookie, at: Date.now() };
    return cookie;
  } catch (e) {
    // No session is not fatal — fall back to a cookie-less request, which
    // is exactly what this endpoint did before this fix.
    cachedSession = { cookie: null, at: Date.now() };
    return null;
  }
}

async function fetchTwse(symbols, debug = false) {
  const cookie = await getTwseSessionCookie();
  const exCh = symbols.map((s) => `tse_${s}.tw`).join("|");
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0&_ts=${Date.now()}`;
  const { data } = await fetchJson(url, 6500, cookie ? { cookie } : {});
  if (!data || !Array.isArray(data.msgArray)) throw new Error("TWSE invalid response");

  const quotes = {};
  for (const item of data.msgArray) {
    const symbol = String(item.c || "");
    if (!symbols.includes(symbol)) continue;

    // Official previous close — this is what brokers use for 漲跌幅.
    const prevClose = Number(item.y);
    if (!Number.isFinite(prevClose) || prevClose <= 0) continue;

    // Last trade price. During the session the free MIS API often returns
    // z="-" even when the stock is actively trading (v>0). Fall back to
    // best bid/ask mid so we still get a usable "current" price while
    // keeping the official y as prevClose.
    let price = NaN;
    let priceSource = "last";
    if (item.z && item.z !== "-" && Number.isFinite(Number(item.z))) {
      price = Number(item.z);
      priceSource = "last";
    } else {
      const bid = firstNumber(item.b);
      const ask = firstNumber(item.a);
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
        price = (bid + ask) / 2;
        priceSource = "mid";
      } else if (Number.isFinite(ask) && ask > 0) {
        price = ask;
        priceSource = "ask";
      } else if (Number.isFinite(bid) && bid > 0) {
        price = bid;
        priceSource = "bid";
      } else if (item.o && item.o !== "-" && Number.isFinite(Number(item.o))) {
        // Open as last resort during early session
        price = Number(item.o);
        priceSource = "open";
      } else {
        // Truly no trade yet — show prev close, mark stale
        price = prevClose;
        priceSource = "prev";
      }
    }

    if (!Number.isFinite(price)) continue;

    // "tlong" is TWSE's own tick timestamp (ms since epoch) for this quote —
    // when the underlying data was actually generated, as opposed to when
    // our function happened to fetch it. Surfacing this lets the frontend
    // show a real "as of" time and detect staleness (e.g. a tick from 10
    // minutes ago) instead of just trusting whichever field back-filled the
    // price. Previously this was always null for TWSE, so the app had no
    // way to tell a fresh tick from an old cached one.
    const tickMs = Number(item.tlong);
    const asOfDate = Number.isFinite(tickMs) ? new Date(tickMs).toISOString() : null;
    const tickAgeMs = Number.isFinite(tickMs) ? Date.now() - tickMs : null;
    // A tick older than 2 minutes during trading hours is a sign this
    // symbol's feed is lagging (thin trading, or TWSE serving a cached
    // snapshot) — flag it as stale even though we did get a real "z" price,
    // so the UI can surface it instead of silently showing an old number.
    const isLaggy = tickAgeMs != null && tickAgeMs > 2 * 60 * 1000;

    const hasRealPrice = priceSource !== "prev";
    quotes[symbol] = {
      price,
      prevClose,
      isStale: !hasRealPrice || isLaggy,
      asOfDate,
      source: "TWSE",
      priceSource, // debug: last | mid | ask | bid | open | prev
    };
    // Raw fields from TWSE, only when ?debug=1 is passed — kept out of the
    // normal response to avoid bloating every request. When the app's
    // displayed 漲跌幅 doesn't match a broker's at the same moment, this is
    // what actually lets us tell apart "our current price is lagging" (raw
    // y agrees with the broker's implied prevClose, only z/tick is behind)
    // from "the prevClose itself is wrong" (raw y disagrees) — reasoning
    // backward from price+pct alone can't distinguish the two.
    if (debug) {
      quotes[symbol].debug = {
        rawY: item.y, rawZ: item.z, rawTlong: item.tlong,
        rawA: item.a, rawB: item.b, rawO: item.o, rawEx: item.ex, rawN: item.n,
      };
    }
  }
  return quotes;
}

// Converts a Unix timestamp (seconds) to a "YYYY-MM-DD" string in Taipei
// time (UTC+8, no DST) — used to match daily bars to real trading dates.
function taipeiDateStr(unixSeconds) {
  const d = new Date((unixSeconds + 8 * 3600) * 1000);
  return d.toISOString().slice(0, 10);
}

async function fetchYahoo(symbol, debug = false) {
  const yahooSymbol = `${symbol}.TW`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d&_ts=${Date.now()}`;
  const { data } = await fetchJson(url, 6500);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo no result");

  const meta = result.meta || {};
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = result.indicators?.quote?.[0]?.close || [];

  // Debug evidence (2026-09-02, 0050/0056) showed meta.regularMarketPreviousClose
  // can be a full trading day stale for TW ETFs — it matched the close from
  // two days back instead of yesterday — while the daily bars array itself
  // was fine. meta stayed correct for 2330 in the same request, so this
  // isn't a blanket Yahoo outage, just an unreliable field for some TW
  // tickers. Bars anchored to real calendar dates aren't guessable in the
  // same way a cached meta field can be, so derive price/prevClose from the
  // bars first and only fall back to meta when the bars don't have enough
  // history to do that.
  let price = null, prevClose = null;
  if (timestamps.length && closes.length === timestamps.length) {
    const today = taipeiDateStr(Math.floor(Date.now() / 1000));
    let todayIdx = -1;
    for (let i = timestamps.length - 1; i >= 0; i--) {
      if (taipeiDateStr(timestamps[i]) === today) { todayIdx = i; break; }
    }
    // If today's bar exists and has a live price, that's "today" — walk
    // backward from it for the last COMPLETED prior day's close. If it's
    // not there yet (e.g. before the first tick of the day), the most
    // recent bar in the array is still the last completed close, so both
    // "current" and "previous" shift back by one.
    const priceIdx = todayIdx >= 0 && closes[todayIdx] != null ? todayIdx : timestamps.length - 1;
    let prevIdx = -1;
    for (let i = priceIdx - 1; i >= 0; i--) {
      if (closes[i] != null && Number.isFinite(Number(closes[i]))) { prevIdx = i; break; }
    }
    if (closes[priceIdx] != null && Number.isFinite(Number(closes[priceIdx]))) {
      price = Number(closes[priceIdx]);
    }
    if (prevIdx >= 0) prevClose = Number(closes[prevIdx]);
  }

  // Fall back to meta fields only when the bars didn't yield a usable pair
  // — e.g. a very new listing with under 2 days of history.
  if (!Number.isFinite(price)) price = Number(meta.regularMarketPrice);
  if (!Number.isFinite(prevClose)) prevClose = Number(meta.regularMarketPreviousClose ?? meta.chartPreviousClose);
  if (!Number.isFinite(price)) throw new Error("Yahoo no price");

  const ts = Array.isArray(result.timestamp)
    ? result.timestamp[result.timestamp.length - 1]
    : null;

  return {
    price,
    prevClose: Number.isFinite(prevClose) ? prevClose : price,
    isStale: false,
    asOfDate: ts ? new Date(ts * 1000).toISOString() : null,
    source: "Yahoo",
    ...(debug ? {
      debug: {
        metaRegularMarketPrice: meta.regularMarketPrice,
        metaRegularMarketPreviousClose: meta.regularMarketPreviousClose,
        metaChartPreviousClose: meta.chartPreviousClose,
        barsUsed: timestamps.map((t, i) => ({ date: taipeiDateStr(t), close: closes[i] })),
      },
    } : {}),
  };
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const requested = (url.searchParams.get("symbols") || "0050,0056,2330")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    const symbols = [...new Set(requested)].filter(isAllowedSymbol);
    if (!symbols.length) return jsonResponse({ error: "沒有允許的股票代號" }, 400);
    const debug = url.searchParams.get("debug") === "1";

    const quotes = {};
    const errors = [];

    try {
      Object.assign(quotes, await fetchTwse(symbols, debug));
    } catch (e) {
      errors.push(`TWSE: ${e?.message || e}`);
    }

    // Yahoo only for symbols TWSE completely missed
    const missing = symbols.filter((s) => !quotes[s]);
    if (missing.length) {
      const results = await Promise.allSettled(missing.map((s) => fetchYahoo(s, debug)));
      results.forEach((result, i) => {
        const symbol = missing[i];
        if (result.status === "fulfilled") quotes[symbol] = result.value;
        else errors.push(`Yahoo ${symbol}: ${result.reason?.message || result.reason}`);
      });
    }

    if (!Object.keys(quotes).length) {
      return jsonResponse({ error: "所有報價來源皆失敗", details: errors }, 502);
    }

    const sources = [...new Set(Object.values(quotes).map((q) => q.source))];
    return jsonResponse({
      ok: true,
      source: sources.join("+"),
      fetchedAt: new Date().toISOString(),
      quotes,
      missing: symbols.filter((s) => !quotes[s]),
      warnings: errors,
    });
  } catch (e) {
    return jsonResponse({ error: e?.message || "quote function failed" }, 500);
  }
}
