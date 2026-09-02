// Stable quote merge:
// - prevClose ALWAYS prefers TWSE `y` (broker-aligned)
// - price: TWSE last trade → bid/ask mid → Yahoo price (with TWSE prevClose kept)
// - full Yahoo quote only when TWSE has no row for that symbol
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

function firstNumber(s) {
  if (!s || s === "-") return NaN;
  const part = String(s).split("_").find((x) => x && x !== "-");
  const n = Number(part);
  return Number.isFinite(n) ? n : NaN;
}

/** TWSE row → { price?, prevClose, priceSource, isStale } */
function parseTwseItem(item) {
  const prevClose = Number(item.y);
  if (!Number.isFinite(prevClose) || prevClose <= 0) return null;

  let price = NaN;
  let priceSource = "prev";

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
      price = Number(item.o);
      priceSource = "open";
    }
  }

  return {
    prevClose,
    price: Number.isFinite(price) ? price : null,
    priceSource: Number.isFinite(price) ? priceSource : null,
    isStale: !Number.isFinite(price),
  };
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
    const parsed = parseTwseItem(item);
    if (!parsed) continue;
    quotes[symbol] = {
      price: parsed.price, // may be null → fill from Yahoo below
      prevClose: parsed.prevClose,
      isStale: parsed.isStale,
      asOfDate: null,
      source: "TWSE",
      priceSource: parsed.priceSource,
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
  let price = Number(meta.regularMarketPrice);
  let prevClose = Number(meta.regularMarketPreviousClose);

  const closes = result.indicators?.quote?.[0]?.close || [];
  let lastIdx = -1;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null && Number.isFinite(Number(closes[i]))) {
      lastIdx = i;
      break;
    }
  }

  if (!Number.isFinite(price) && lastIdx >= 0) {
    price = Number(closes[lastIdx]);
  }

  // Only use bar-based prevClose if meta is missing — caller may overwrite
  // with TWSE y anyway.
  if (!Number.isFinite(prevClose)) {
    if (lastIdx >= 1) {
      for (let i = lastIdx - 1; i >= 0; i--) {
        if (closes[i] != null && Number.isFinite(Number(closes[i]))) {
          prevClose = Number(closes[i]);
          break;
        }
      }
    }
    if (!Number.isFinite(prevClose)) {
      prevClose = Number(meta.chartPreviousClose ?? price);
    }
  }

  if (!Number.isFinite(price)) throw new Error("Yahoo no price");

  const ts = Array.isArray(result.timestamp) && lastIdx >= 0
    ? result.timestamp[lastIdx]
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

    // 1) TWSE first — locks official prevClose whenever available
    try {
      Object.assign(quotes, await fetchTwse(symbols));
    } catch (e) {
      errors.push(`TWSE: ${e?.message || e}`);
    }

    // 2) Symbols that need Yahoo:
    //    - missing entirely from TWSE
    //    - OR TWSE has prevClose but no usable price (price === null)
    const needYahoo = symbols.filter((s) => {
      const q = quotes[s];
      return !q || q.price == null || !Number.isFinite(q.price);
    });

    if (needYahoo.length) {
      const results = await Promise.allSettled(needYahoo.map(fetchYahoo));
      results.forEach((result, i) => {
        const symbol = needYahoo[i];
        if (result.status !== "fulfilled") {
          errors.push(`Yahoo ${symbol}: ${result.reason?.message || result.reason}`);
          // If TWSE gave prevClose but no price, fall back to showing prev as price
          if (quotes[symbol] && quotes[symbol].price == null) {
            quotes[symbol].price = quotes[symbol].prevClose;
            quotes[symbol].priceSource = "prev";
            quotes[symbol].isStale = true;
          }
          return;
        }
        const yq = result.value;
        if (quotes[symbol] && Number.isFinite(quotes[symbol].prevClose)) {
          // Keep TWSE prevClose — only take Yahoo price
          quotes[symbol] = {
            price: yq.price,
            prevClose: quotes[symbol].prevClose,
            isStale: false,
            asOfDate: yq.asOfDate,
            source: "TWSE+Yahoo",
            priceSource: "yahoo",
          };
        } else {
          // No TWSE row at all
          quotes[symbol] = yq;
        }
      });
    }

    // Final sanitize: drop entries still without price
    for (const s of Object.keys(quotes)) {
      if (quotes[s].price == null || !Number.isFinite(quotes[s].price)) {
        delete quotes[s];
      }
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
