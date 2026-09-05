/**
 * news.js — 4.6-news-stable-4
 *
 * 持股新聞摘要：改用 Yahoo Finance 的新聞搜尋端點（JSON，不是解析網頁），
 * 用「代號 + .TW 尾碼」查詢台股新聞，只回傳最近 windowHours 小時內的新聞，
 * 同一檔股票標題重複的只留一則，每檔最多回傳 maxPerSymbol 則。
 * 當天完全沒有新消息的股票，回應裡直接不會有那個 key，前端就不會顯示那張卡片。
 *
 * 用法：GET /news?symbols=0050,0056,2330&names=元大台灣50,元大高股息,台積電
 *       &windowHours=48（預設48，可調）&maxPerSymbol=3（預設3，可調）
 *
 * 換源記錄：原本用 Google News RSS，但 2026-09 起 Google 開始針對雲端機房 IP
 * （AWS/GCP/Cloudflare 這類巨量流量共用的 IP 段）做封鎖，Cloudflare Workers
 * 的對外 IP 全世界共用，導致持續收到 503，換 UA/重試都沒用，因此換成這個來源。
 * 這是 Yahoo 未公開文件化的端點，一樣有格式被調整的風險，保留 ?debug=1 方便排查。
 */

const NEWS_VERSION = "4.6-news-stable-4";
const SYMBOL_PATTERN = /^[0-9A-Za-z.]{1,10}$/;

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

// 標題去重用的正規化key：去空白、去標點符號，避免同story被不同分發站重複列出。
function normalizeTitleKey(title) {
  return title
    .toLowerCase()
    .replace(/[\s\u3000]/g, "")
    .replace(/[，。！？、「」『』【】\-–—:：,.!?()（）\[\]]/g, "");
}

async function fetchJsonOnce(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "application/json",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchNewsForSymbol(symbol, name, windowHours, maxPerSymbol, debug) {
  // Yahoo Finance 用 .TW 尾碼代表台股（例如 2330.TW），用代號查比用公司名稱查更準，
  // 回來的 news 陣列裡 relatedTickers 會對到這檔股票。
  const yahooSymbol = `${symbol}.TW`;
  const url =
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(yahooSymbol)}` +
    `&newsCount=${Math.min(30, maxPerSymbol * 5)}&quotesCount=0&lang=zh-Hant-TW&region=TW`;

  let data;
  try {
    data = await fetchJsonOnce(url, 10000);
  } catch (e) {
    // 503/502/504 這類常見暫時性錯誤重試一次。
    const msg = String(e?.message || "");
    if (/HTTP (502|503|504)/.test(msg)) {
      data = await fetchJsonOnce(url, 10000);
    } else {
      throw e;
    }
  }

  const rawItems = Array.isArray(data?.news) ? data.news : [];
  const cutoff = Date.now() - windowHours * 3600 * 1000;

  const seen = new Set();
  const items = [];
  const debugRaw = [];

  for (const item of rawItems) {
    const rawTitle = String(item?.title || "").trim();
    const link = String(item?.link || "");
    const source = item?.publisher || null;
    const pubMs = item?.providerPublishTime ? Number(item.providerPublishTime) * 1000 : null;

    if (debug) debugRaw.push({ rawTitle, pubMs, source });

    if (pubMs == null || isNaN(pubMs) || pubMs < cutoff) continue; // 太舊，跳過
    if (!rawTitle) continue;

    const key = normalizeTitleKey(rawTitle);
    if (seen.has(key)) continue; // 標題重複，跳過
    seen.add(key);

    items.push({
      title: rawTitle,
      link,
      source: source || null,
      pubDate: new Date(pubMs).toISOString(),
    });

    if (items.length >= maxPerSymbol) break;
  }

  return debug ? { items, debugRaw, rawCount: rawItems.length } : { items };
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);

    const symbols = (url.searchParams.get("symbols") || "")
      .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).filter(isAllowedSymbol);

    const names = (url.searchParams.get("names") || "")
      .split(",").map((s) => s.trim());

    if (!symbols.length) {
      return jsonResponse({ error: "沒有提供股票代號" }, 400);
    }

    const windowHours = Math.min(168, Math.max(1, Number(url.searchParams.get("windowHours")) || 48));
    const maxPerSymbol = Math.min(10, Math.max(1, Number(url.searchParams.get("maxPerSymbol")) || 3));
    const debug = url.searchParams.get("debug") === "1";

    const results = await Promise.allSettled(
      symbols.map((sym, i) => fetchNewsForSymbol(sym, names[i] || "", windowHours, maxPerSymbol, debug))
    );

    const news = {};
    const debugInfo = {};
    const warnings = [];

    results.forEach((r, i) => {
      const sym = symbols[i];
      if (r.status === "fulfilled") {
        if (r.value.items.length > 0) news[sym] = r.value.items; // 沒有新消息就不放進去，前端不顯示
        if (debug) debugInfo[sym] = { rawCount: r.value.rawCount, debugRaw: r.value.debugRaw };
      } else {
        warnings.push(`${sym}: ${r.reason?.message || r.reason}`);
      }
    });

    return jsonResponse({
      ok: true,
      version: NEWS_VERSION,
      fetchedAt: new Date().toISOString(),
      windowHours,
      maxPerSymbol,
      news,
      warnings,
      ...(debug ? { debugInfo } : {}),
    });
  } catch (e) {
    return jsonResponse({ error: e?.message || "news function failed", version: NEWS_VERSION }, 500);
  }
}
