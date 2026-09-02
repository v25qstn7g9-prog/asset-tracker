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

/** First numeric token from TWSE underscore-separated list (bid/ask ladder). */
function firstNumber(s) {
  if (!s || s === "-") return NaN;
  const part = String(s).split("_").find((x) => x && x !== "-");
  const n = Number(part);
  return Number.isFinite(n) ? n : NaN;
}

async function fetchTwse(symbols) {
  const exCh = symbols.map((s) => `tse_${s}.tw`).join("|");
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0&_ts=${Date.now()}`;
  const data = await fetchJson(url, 6500);
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

    const hasRealPrice = priceSource !== "prev";
    quotes[symbol] = {
      price,
      prevClose,
      isStale: !hasRealPrice,
      asOfDate: null,
      source: "TWSE",
      priceSource, // debug: last | mid | ask | bid | open | prev
    };
  }
  return quotes;
}

async function fetchYahoo(symbol) {
  const yahooSymbol = `${symbol}.TW`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d&_ts=${Date.now()}`;
  const data = await fetchJson(url, 6500);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo no result");

  const meta = result.meta || {};
  // Prefer official meta fields over daily close bars (bars can be adjusted
  // or pick the wrong session, which breaks 漲跌幅 vs brokers).
  let price = Number(meta.regularMarketPrice);
  let prevClose = Number(meta.regularMarketPreviousClose);

  if (!Number.isFinite(price) || !Number.isFinite(prevClose)) {
    const closes = result.indicators?.quote?.[0]?.close || [];
    let lastIdx = -1;
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null && Number.isFinite(Number(closes[i]))) {
        lastIdx = i;
        break;
      }
    }
    if (lastIdx < 0) throw new Error("Yahoo no price");
    if (!Number.isFinite(price)) price = Number(closes[lastIdx]);
    if (!Number.isFinite(prevClose)) {
      let prevIdx = -1;
      for (let i = lastIdx - 1; i >= 0; i--) {
        if (closes[i] != null && Number.isFinite(Number(closes[i]))) {
          prevIdx = i;
          break;
        }
      }
      prevClose = prevIdx >= 0
        ? Number(closes[prevIdx])
        : Number(meta.chartPreviousClose ?? price);
    }
  }

  const ts = Array.isArray(result.timestamp)
    ? result.timestamp[result.timestamp.length - 1]
    : null;

  return {
    price,
    prevClose: Number.isFinite(prevClose) ? prevClose : price,
    isStale: false,
    asOfDate: ts ? new Date(ts * 1000).toISOString() : null,
    source: "Yahoo",
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

    const quotes = {};
    const errors = [];

    try {
      Object.assign(quotes, await fetchTwse(symbols));
    } catch (e) {
      errors.push(`TWSE: ${e?.message || e}`);
    }

    // Yahoo only for symbols TWSE completely missed
    const missing = symbols.filter((s) => !quotes[s]);
    if (missing.length) {
      const results = await Promise.allSettled(missing.map(fetchYahoo));
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
