/**
 * quote.js — 4.6-quote-stable-4
 *
 * Stability strategy for 漲跌幅:
 * 1. TWSE `y` is the only accepted prevClose (matches brokers).
 * 2. Edge-cache each symbol's prevClose for the calendar day so intermittent
 *    TWSE failures don't fall through to Yahoo's wrong previous bar.
 * 3. Yahoo may only supply *price*; never overwrite a known TWSE prevClose.
 * 4. Retry TWSE once; optional per-symbol fallback if batch is partial.
 */
const SYMBOL_PATTERN = /^[0-9]{4,6}[A-Z]?$/;
const QUOTE_VERSION = "4.6-quote-stable-4";

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
  // Taiwan is UTC+8
  const t = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return t.toISOString().slice(0, 10);
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

function parseTwseItem(item) {
  const prevClose = Number(item.y);
  if (!Number.isFinite(prevClose) || prevClose <= 0) return null;

  let price = NaN;
  let priceSource = null;

  if (item.z && item.z !== "-" && Number.isFinite(Number(item.z))) {
    price = Number(item.z);
    priceSource = "last";
  } else {
    const bid = firstNumber(item.b);
    const ask = firstNumber(item.a);
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
      price = Math.round(((bid + ask) / 2) * 100) / 100;
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
    priceSource,
  };
}

async function fetchTwseBatch(symbols) {
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
      price: parsed.price,
      prevClose: parsed.prevClose,
      isStale: parsed.price == null,
      asOfDate: null,
      source: "TWSE",
      priceSource: parsed.priceSource,
    };
  }
  return quotes;
}

async function fetchTwseWithRetry(symbols) {
  try {
    return await fetchTwseBatch(symbols);
  } catch (e1) {
    // one retry after short delay
    await new Promise((r) => setTimeout(r, 250));
    try {
      return await fetchTwseBatch(symbols);
    } catch (e2) {
      throw new Error(`TWSE: ${e1?.message || e1}; retry: ${e2?.message || e2}`);
    }
  }
}

async function fetchYahooPrice(symbol) {
  const yahooSymbol = `${symbol}.TW`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d&_ts=${Date.now()}`;
  const data = await fetchJson(url, 6500);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo no result");
  const meta = result.meta || {};
  let price = Number(meta.regularMarketPrice);
  if (!Number.isFinite(price)) {
    const closes = result.indicators?.quote?.[0]?.close || [];
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null && Number.isFinite(Number(closes[i]))) {
        price = Number(closes[i]);
        break;
      }
    }
  }
  // Intentionally DO NOT return Yahoo prevClose for use as broker 漲跌幅 base.
  if (!Number.isFinite(price)) throw new Error("Yahoo no price");
  return { price, asOfDate: null, source: "Yahoo" };
}

/** Edge cache helpers — pin TWSE prevClose for the Taiwan trading day. */
async function readPrevCloseCache(symbol, day) {
  try {
    const key = new Request(`https://quote-cache.local/prev/${day}/${symbol}`);
    const hit = await caches.default.match(key);
    if (!hit) return null;
    const j = await hit.json();
    return Number.isFinite(j?.prevClose) ? j.prevClose : null;
  } catch {
    return null;
  }
}

async function writePrevCloseCache(symbol, day, prevClose) {
  try {
    const key = new Request(`https://quote-cache.local/prev/${day}/${symbol}`);
    const body = JSON.stringify({ prevClose, day, symbol });
    // Keep until end of day + buffer (~20h)
    await caches.default.put(
      key,
      new Response(body, {
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=72000",
        },
      })
    );
  } catch {
    // cache optional
  }
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

    const day = taiwanDateStr();
    const quotes = {};
    const errors = [];

    // 1) TWSE batch (with retry)
    try {
      Object.assign(quotes, await fetchTwseWithRetry(symbols));
    } catch (e) {
      errors.push(String(e?.message || e));
    }

    // 2) Persist successful TWSE prevClose into edge cache
    for (const [sym, q] of Object.entries(quotes)) {
      if (Number.isFinite(q.prevClose)) {
        await writePrevCloseCache(sym, day, q.prevClose);
      }
    }

    // 3) Fill missing prevClose from today's edge cache
    for (const sym of symbols) {
      if (quotes[sym] && Number.isFinite(quotes[sym].prevClose)) continue;
      const cached = await readPrevCloseCache(sym, day);
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
          quotes[sym].prevClose = cached;
          if (quotes[sym].source === "Yahoo") quotes[sym].source = "cache+Yahoo";
          else if (!quotes[sym].source) quotes[sym].source = "cache";
        }
      }
    }

    // 4) Price gaps → Yahoo price only (keep TWSE/cache prevClose)
    const needPrice = symbols.filter((s) => {
      const q = quotes[s];
      return !q || q.price == null || !Number.isFinite(q.price);
    });

    if (needPrice.length) {
      const results = await Promise.allSettled(needPrice.map(fetchYahooPrice));
      results.forEach((result, i) => {
        const symbol = needPrice[i];
        if (result.status !== "fulfilled") {
          errors.push(`Yahoo ${symbol}: ${result.reason?.message || result.reason}`);
          if (quotes[symbol] && quotes[symbol].price == null && Number.isFinite(quotes[symbol].prevClose)) {
            quotes[symbol].price = quotes[symbol].prevClose;
            quotes[symbol].priceSource = "prev";
            quotes[symbol].isStale = true;
          }
          return;
        }
        const yq = result.value;
        if (quotes[symbol] && Number.isFinite(quotes[symbol].prevClose)) {
          quotes[symbol] = {
            price: yq.price,
            prevClose: quotes[symbol].prevClose, // locked
            isStale: false,
            asOfDate: yq.asOfDate,
            source: quotes[symbol].source === "cache" ? "cache+Yahoo" : "TWSE+Yahoo",
            priceSource: "yahoo",
          };
        } else {
          // No TWSE prevClose and no cache — refuse to invent 漲跌幅 base.
          // Return price only with prevClose=price so UI shows 0% rather than a wrong %.
          quotes[symbol] = {
            price: yq.price,
            prevClose: yq.price,
            isStale: true,
            asOfDate: yq.asOfDate,
            source: "Yahoo",
            priceSource: "yahoo",
            warning: "no_twse_prevClose",
          };
        }
      });
    }

    // sanitize
    for (const s of Object.keys(quotes)) {
      if (quotes[s].price == null || !Number.isFinite(quotes[s].price)) delete quotes[s];
    }

    if (!Object.keys(quotes).length) {
      return jsonResponse({ error: "所有報價來源皆失敗", details: errors, version: QUOTE_VERSION }, 502);
    }

    const sources = [...new Set(Object.values(quotes).map((q) => q.source))];
    return jsonResponse({
      ok: true,
      version: QUOTE_VERSION,
      source: sources.join("+"),
      fetchedAt: new Date().toISOString(),
      day,
      quotes,
      missing: symbols.filter((s) => !quotes[s]),
      warnings: errors,
    });
  } catch (e) {
    return jsonResponse({ error: e?.message || "quote function failed", version: QUOTE_VERSION }, 500);
  }
}
