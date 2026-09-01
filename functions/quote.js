// Stock quote Cloudflare Pages Function
// Priority: TWSE MIS (authoritative for TW stocks) → Yahoo fallback
// Fixed: Yahoo prevClose now prefers regularMarketPreviousClose to avoid
// adjusted-close mismatches that inflate change %.

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
        accept: "application/json,text/plain,*/*",
        "user-agent": "Mozilla/5.0 (compatible; StockTracker/4.6-v2)",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** TWSE MIS — y = 昨收, z = 最新成交價 */
async function fetchTwse(symbols) {
  // 上市用 tse_；若之後有上櫃可擴充 otc_
  const exCh = symbols.map((s) => `tse_${s}.tw`).join("|");
  const url =
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}` +
    `&json=1&delay=0&_ts=${Date.now()}`;
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

/**
 * Yahoo chart API
 * Prefer meta.regularMarketPrice + meta.regularMarketPreviousClose
 * (same unadjusted basis). Fall back carefully if missing.
 */
async function fetchYahoo(symbol) {
  const yahooSymbol = `${symbol}.TW`;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}` +
    `?interval=1d&range=5d&_ts=${Date.now()}`;
  const data = await fetchJson(url, 6500);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo no result");

  const meta = result.meta || {};

  // 1) Best pair: live price + official previous close (unadjusted)
  let price = Number(meta.regularMarketPrice);
  let prevClose = Number(meta.regularMarketPreviousClose);

  // 2) Secondary meta fields
  if (!Number.isFinite(prevClose)) {
    prevClose = Number(meta.previousClose ?? meta.chartPreviousClose);
  }
  if (!Number.isFinite(price)) {
    price = Number(meta.previousClose);
  }

  // 3) Last resort: daily close series (can be adjusted — use only if needed)
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

    let prevIdx = -1;
    for (let i = lastIdx - 1; i >= 0; i--) {
      if (closes[i] != null && Number.isFinite(Number(closes[i]))) {
        prevIdx = i;
        break;
      }
    }

    if (!Number.isFinite(price)) price = Number(closes[lastIdx]);
    if (!Number.isFinite(prevClose)) {
      prevClose = prevIdx >= 0 ? Number(closes[prevIdx]) : price;
    }
  }

  if (!Number.isFinite(price)) throw new Error("Yahoo no price");

  return {
    price,
    prevClose: Number.isFinite(prevClose) ? prevClose : price,
    isStale: false,
    asOfDate: meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : null,
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

    // --- Parallel: TWSE first preference, Yahoo fills gaps ---
    let twseQuotes = {};
    let yahooMap = {};

    const [twseResult, ...yahooResults] = await Promise.allSettled([
      fetchTwse(symbols),
      ...symbols.map((s) => fetchYahoo(s)),
    ]);

    if (twseResult.status === "fulfilled") {
      twseQuotes = twseResult.value;
    } else {
      errors.push(`TWSE: ${twseResult.reason?.message || twseResult.reason}`);
    }

    symbols.forEach((symbol, i) => {
      const r = yahooResults[i];
      if (r.status === "fulfilled") yahooMap[symbol] = r.value;
      else errors.push(`Yahoo ${symbol}: ${r.reason?.message || r.reason}`);
    });

    for (const symbol of symbols) {
      const tw = twseQuotes[symbol];
      const yh = yahooMap[symbol];

      if (tw && Number.isFinite(tw.price) && Number.isFinite(tw.prevClose)) {
        // Prefer TWSE always when present
        quotes[symbol] = tw;
        continue;
      }

      if (yh && Number.isFinite(yh.price) && Number.isFinite(yh.prevClose)) {
        quotes[symbol] = yh;
        continue;
      }

      // If TWSE had price but missing prevClose, try hybrid
      if (tw && Number.isFinite(tw.price) && yh && Number.isFinite(yh.prevClose)) {
        quotes[symbol] = {
          ...tw,
          prevClose: yh.prevClose,
          source: "TWSE+Yahoo",
        };
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
