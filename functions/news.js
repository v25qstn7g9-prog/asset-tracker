/**
 * news.js — 4.6-news-stable-1
 *
 * 持股新聞摘要：用 Google News RSS（news.google.com/rss/search）依「代號 + 名稱」查詢，
 * 只回傳最近 windowHours 小時內的新聞，同一檔股票標題重複的只留一則，
 * 每檔最多回傳 maxPerSymbol 則。當天完全沒有新消息的股票，回應裡直接不會有那個 key，
 * 前端就不會顯示那張卡片。
 *
 * 用法：GET /news?symbols=0050,0056,2330&names=元大台灣50,元大高股息,台積電
 *       &windowHours=48（預設48，可調）&maxPerSymbol=3（預設3，可調）
 *
 * 注意：Google News RSS 是 Google 開放的訂閱端點（回傳結構化 XML），
 * 不是去解析會跑 JS 的 news.google.com 網頁本身；但仍屬於非官方文件化的端點，
 * 格式理論上可能被 Google 調整，因此保留 ?debug=1 方便排查。
 */

const NEWS_VERSION = "4.6-news-stable-1";
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

function decodeEntities(str) {
  if (!str) return "";
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .trim();
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  return m ? decodeEntities(m[1]) : "";
}

// 標題常常長這樣："某某headline - 發布來源"，跟 <source> 內容重複，去掉尾巴的來源名稱。
function stripTrailingSource(title, source) {
  if (!source) return title;
  const suffix = ` - ${source}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}

// 標題去重用的正規化key：去空白、去標點符號、轉半形，避免同story被不同分發站重複列出。
function normalizeTitleKey(title) {
  return title
    .toLowerCase()
    .replace(/[\s\u3000]/g, "")
    .replace(/[，。！？、「」『』【】\-–—:：,.!?()（）\[\]]/g, "");
}

async function fetchNewsForSymbol(symbol, name, windowHours, maxPerSymbol, debug) {
  const query = name ? `${symbol} ${name}` : symbol;
  const url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}` +
    `&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  let xml;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "application/rss+xml, application/xml, text/xml, */*",
        "user-agent": "Mozilla/5.0 (compatible; StockTracker/4.6-news)",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const rawItems = xml.split("<item>").slice(1).map((s) => s.split("</item>")[0]);
  const cutoff = Date.now() - windowHours * 3600 * 1000;

  const seen = new Set();
  const items = [];
  const debugRaw = [];

  for (const block of rawItems) {
    const rawTitle = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDateStr = extractTag(block, "pubDate");
    const source = extractTag(block, "source");

    const pubDate = pubDateStr ? new Date(pubDateStr) : null;
    const pubMs = pubDate && !isNaN(pubDate.getTime()) ? pubDate.getTime() : null;

    if (debug) debugRaw.push({ rawTitle, pubDateStr, pubMs, source });

    if (pubMs == null || pubMs < cutoff) continue; // 太舊，跳過

    const title = stripTrailingSource(rawTitle, source);
    if (!title) continue;

    const key = normalizeTitleKey(title);
    if (seen.has(key)) continue; // 標題重複，跳過
    seen.add(key);

    items.push({
      title,
      link,
      source: source || null,
      pubDate: new Date(pubMs).toISOString(),
    });

    if (items.length >= maxPerSymbol) break; // Google News 本身依相關性/時間排序，取前N則即可
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
