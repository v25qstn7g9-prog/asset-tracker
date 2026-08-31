// Was a fixed Set of exactly 3 symbols — now a format check instead, since
// the front end sends whatever's currently held (see LIVE_WATCHLIST removal
// in index.html), not a hardcoded list. This still blocks obviously-invalid
// input (e.g. someone probing the endpoint with garbage), just without
// needing to hand-edit this list every time the front end's holdings change.
// Matches Taiwan listed/OTC ticker shapes: 4-6 digits, optional trailing
// letter (covers plain stocks like 2330, ETFs like 0050/006208, and
// lettered ETF codes like 00981A / 00685L).
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
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
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
    const prevClose = Number(item.y);
    const hasTraded = item.z && item.z !== "-" && Number.isFinite(Number(item.z));
    const price = Number(hasTraded ? item.z : item.y);
    if (!Number.isFinite(price)) continue;
    quotes[symbol] = {
      price,
      prevClose: Number.isFinite(prevClose) ? prevClose : price,
      isStale: !hasTraded,
      asOfDate: null,
      source: "TWSE",
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

  const closes = result.indicators?.quote?.[0]?.close || [];
  let lastIdx = -1;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null && Number.isFinite(Number(closes[i]))) { lastIdx = i; break; }
  }
  if (lastIdx < 0) throw new Error("Yahoo no price");

  let prevIdx = -1;
  for (let i = lastIdx - 1; i >= 0; i--) {
    if (closes[i] != null && Number.isFinite(Number(closes[i]))) { prevIdx = i; break; }
  }

  const price = Number(closes[lastIdx]);
  const prevClose = prevIdx >= 0
    ? Number(closes[prevIdx])
    : Number(result.meta?.chartPreviousClose ?? price);
  const ts = Array.isArray(result.timestamp) ? result.timestamp[lastIdx] : null;

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
      .map((s) => s.trim())
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
