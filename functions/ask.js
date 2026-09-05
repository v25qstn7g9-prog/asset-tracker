/**
 * ask.js — 4.6-ask-stable-1
 *
 * 聊天/問答功能：前端把使用者訊息 + 對話歷史 + 目前持股摘要（純文字）一起丟過來，
 * 這支 Function 組成 system prompt 呼叫 Claude API，回傳文字答案。
 *
 * 用法：POST /ask
 *   body: {
 *     message: "我 0056 現在賺多少？",
 *     history: [{role:"user"|"assistant", content:"..."}, ...],  // 最近幾輪對話，可省略
 *     context: "0050 目前4645股 平均成本80.39 ..."                // 持股摘要純文字，可省略（純閒聊時可不帶）
 *   }
 *   回傳: { ok: true, reply: "..." }
 *
 * 需要在 Cloudflare Pages 專案的 Settings → Environment variables 設定：
 *   ANTHROPIC_API_KEY = sk-ant-xxxxxxxx（你的 Claude API 金鑰，記得選 Secret 加密）
 */

const ASK_VERSION = "4.6-ask-stable-1";
const MODEL = "claude-haiku-4-5-20251001"; // 成本低、聊天問答夠用；要換更聰明的模型可改這裡
const MAX_HISTORY_TURNS = 8; // 只帶最近幾輪，避免每次都把整串對話都送去，浪費 token

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
    },
  });
}

const SYSTEM_PROMPT_BASE = `你是內嵌在一個個人存股資產追蹤 App 裡的助手，用繁體中文回答。
使用者可能單純閒聊，也可能問跟他自己持股相關的問題（例如「我現在賺多少」「什麼時候會達標」）。
如果訊息裡有附上「目前持股資料」，那是使用者當下 App 裡的真實數字，直接拿來回答、
不用再叫他自己去查；如果問題跟持股資料無關，就正常聊。
這是手機上的小聊天視窗，回答盡量簡潔，不要長篇大論，除非使用者明確要求詳細說明。
你不是財務顧問，不要給「應該買/應該賣」這種明確投資建議，可以中性分析、給資訊，
但決策留給使用者自己判斷。`;

export async function onRequestPost(context) {
  try {
    const apiKey = context.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return jsonResponse(
        { error: "尚未設定 ANTHROPIC_API_KEY，請到 Cloudflare Pages 專案設定裡加上這個環境變數。" },
        500
      );
    }

    const body = await context.request.json().catch(() => null);
    const message = String(body?.message || "").trim();
    if (!message) {
      return jsonResponse({ error: "沒有收到訊息內容" }, 400);
    }
    if (message.length > 2000) {
      return jsonResponse({ error: "訊息太長了，麻煩縮短一點" }, 400);
    }

    const rawHistory = Array.isArray(body?.history) ? body.history : [];
    const history = rawHistory
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-MAX_HISTORY_TURNS * 2)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

    const contextText = typeof body?.context === "string" ? body.context.slice(0, 6000) : "";
    const systemPrompt = contextText
      ? `${SYSTEM_PROMPT_BASE}\n\n目前持股資料（使用者 App 裡的即時數字）：\n${contextText}`
      : SYSTEM_PROMPT_BASE;

    const messages = [...history, { role: "user", content: message }];

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: systemPrompt,
        messages,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return jsonResponse(
        { error: `Claude API 呼叫失敗（HTTP ${res.status}）`, detail: errText.slice(0, 500) },
        502
      );
    }

    const data = await res.json();
    const reply = (data?.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!reply) {
      return jsonResponse({ error: "Claude 沒有回傳文字內容" }, 502);
    }

    return jsonResponse({ ok: true, version: ASK_VERSION, reply });
  } catch (e) {
    return jsonResponse({ error: e?.message || "ask function failed", version: ASK_VERSION }, 500);
  }
}
