/**
 * news.js — 4.6-news-stable-5
 *
 * 持股新聞摘要：Yahoo Finance JSON 為主，Bing News RSS 為備援。
 * - Yahoo query1 失敗/空資料 → query2 再試
 * - Yahoo 仍失敗/空資料 → Bing News RSS（用代號 + 中文名稱搜尋）
 * - 只回傳最近 windowHours 小時內的新聞、標題去重、每檔最多 maxPerSymbol 則
 * - 保留 ?debug=1 方便檢查每檔實際使用來源與錯誤
 */

const NEWS_VERSION = "4.6-news-stable-5";
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

function normalizeTitleKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[\s\u3000]/g, "")
    .replace(/[，。！？、「」『』【】\-–—:：,.!?()（）\[\]]/g, "");
}

async function fetchOnce(url, timeoutMs, asText = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": asText ? "application/rss+xml, application/xml, text/xml, */*" : "application/json",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return asText ? await res.text() : await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithRetry(url) {
  try {
    return await fetchOnce(url, 10000, false);
  } catch (e) {
    const msg = String(e?.message || "");
    if (/HTTP (429|500|502|503|504)/.test(msg)) {
      return await fetchOnce(url, 10000, false);
    }
    throw e;
  }
}

function yahooItemsFromData(data, cutoff, maxPerSymbol) {
  const rawItems = Array.isArray(data?.news) ? data.news : [];
  const seen = new Set();
  const items = [];

  for (const item of rawItems) {
    const title = String(item?.title || "").trim();
    const link = String(item?.link || "").trim();
    const source = item?.publisher || null;
    const pubMs = item?.providerPublishTime ? Number(item.providerPublishTime) * 1000 : null;

    if (!title || !link || pubMs == null || Number.isNaN(pubMs) || pubMs < cutoff) continue;
    const key = normalizeTitleKey(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    items.push({ title, link, source, pubDate: new Date(pubMs).toISOString() });
    if (items.length >= maxPerSymbol) break;
  }

  return { items, rawCount: rawItems.length };
}

function decodeXml(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

function xmlTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeXml(m[1]) : "";
}

function bingItemsFromXml(xml, cutoff, maxPerSymbol) {
  const blocks = String(xml || "").match(/<item\b[\s\S]*?<\/item>/gi) || [];
  const seen = new Set();
  const items = [];

  for (const block of blocks) {
    const title = xmlTag(block, "title");
    const link = xmlTag(block, "link");
    const pubRaw = xmlTag(block, "pubDate");
    const pubMs = Date.parse(pubRaw);
    if (!title || !link || !Number.isFinite(pubMs) || pubMs < cutoff) continue;

    const key = normalizeTitleKey(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    items.push({ title, link, source: "Bing News", pubDate: new Date(pubMs).toISOString() });
    if (items.length >= maxPerSymbol) break;
  }

  return { items, rawCount: blocks.length };
}

async function fetchNewsForSymbol(symbol, name, windowHours, maxPerSymbol, debug) {
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const yahooSymbol = `${symbol}.TW`;
  const newsCount = Math.min(30, Math.max(10, maxPerSymbol * 5));
  const attempts = [];

  // 1) Yahoo query1
  const yahoo1 = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(yahooSymbol)}` +
    `&newsCount=${newsCount}&quotesCount=0&lang=zh-Hant-TW&region=TW`;
  try {
    const data = await fetchJsonWithRetry(yahoo1);
    const parsed = yahooItemsFromData(data, cutoff, maxPerSymbol);
    attempts.push({ source: "yahoo-query1", ok: true, rawCount: parsed.rawCount, kept: parsed.items.length });
    if (parsed.items.length) return debug ? { ...parsed, sourceUsed: "yahoo-query1", attempts } : { items: parsed.items };
  } catch (e) {
    attempts.push({ source: "yahoo-query1", ok: false, error: String(e?.message || e) });
  }

  // 2) Yahoo query2（同服務另一個 host，Cloudflare 對外路徑偶爾不同）
  const yahoo2 = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(yahooSymbol)}` +
    `&newsCount=${newsCount}&quotesCount=0&lang=zh-Hant-TW&region=TW`;
  try {
    const data = await fetchJsonWithRetry(yahoo2);
    const parsed = yahooItemsFromData(data, cutoff, maxPerSymbol);
    attempts.push({ source: "yahoo-query2", ok: true, rawCount: parsed.rawCount, kept: parsed.items.length });
    if (parsed.items.length) return debug ? { ...parsed, sourceUsed: "yahoo-query2", attempts } : { items: parsed.items };
  } catch (e) {
    attempts.push({ source: "yahoo-query2", ok: false, error: String(e?.message || e) });
  }

  // 3) Bing News RSS 備援。中文名稱對 ETF/台股通常比只用 ticker 更容易找到新聞。
  const query = [symbol, name].filter(Boolean).join(" ");
  const bingUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}` +
    `&format=rss&mkt=zh-TW&setlang=zh-Hant`;
  try {
    const xml = await fetchOnce(bingUrl, 10000, true);
    const parsed = bingItemsFromXml(xml, cutoff, maxPerSymbol);
    attempts.push({ source: "bing-rss", ok: true, rawCount: parsed.rawCount, kept: parsed.items.length });
    return debug ? { ...parsed, sourceUsed: parsed.items.length ? "bing-rss" : "none", attempts } : { items: parsed.items };
  } catch (e) {
    attempts.push({ source: "bing-rss", ok: false, error: String(e?.message || e) });
    return debug ? { items: [], rawCount: 0, sourceUsed: "none", attempts } : { items: [] };
  }
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);

    const symbols = (url.searchParams.get("symbols") || "")
      .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).filter(isAllowedSymbol);
    const names = (url.searchParams.get("names") || "")
      .split(",").map((s) => s.trim());

    if (!symbols.length) return jsonResponse({ error: "沒有提供股票代號" }, 400);

    // 預設 72 小時，避免週末/休市時剛好 48 小時內沒有個股新聞，整張卡片消失。
    const windowHours = Math.min(168, Math.max(1, Number(url.searchParams.get("windowHours")) || 72));
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
        if (r.value.items.length > 0) news[sym] = r.value.items;
        if (debug) debugInfo[sym] = {
          sourceUsed: r.value.sourceUsed,
          rawCount: r.value.rawCount,
          attempts: r.value.attempts,
        };
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
