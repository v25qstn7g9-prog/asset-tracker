/**
 * ask.js — 4.6-ask-free-1
 *
 * 聊天/問答功能：前端把使用者訊息 + 對話歷史 + 目前持股摘要（純文字）一起丟過來，
 * 這支 Function 組成訊息陣列，呼叫 Cloudflare Workers AI（免費，Llama 3.1 8B），回傳文字答案。
 *
 * 用法：POST /ask
 *   body: {
 *     message: "我 0056 現在賺多少？",
 *     history: [{role:"user"|"assistant", content:"..."}, ...],  // 最近幾輪對話，可省略
 *     context: "0050 目前4645股 平均成本80.39 ..."                // 持股摘要純文字，可省略（純閒聊時可不帶）
 *   }
 *   回傳: { ok: true, reply: "..." }
 *
 * 需要在 Cloudflare Pages 專案設定 AI 綁定（不用申請外部 API 金鑰，完全免費）：
 *   專案 → Settings → Functions → AI bindings → Add binding
 *   Variable name: AI
 *   （不用選 service，Workers AI 是 Cloudflare 內建的，選了就會出現）
 *
 * 免費額度：每帳號每天 10,000 neurons，個人使用完全夠用，超過才會計費。
 * 模型能力提醒：Llama 3.1 8B 是輕量開源模型，中文理解/推理能力比 Claude 弱，
 * 適合日常聊天跟簡單問答；如果之後想要更聰明的回答，可以換回付費的 Claude/GPT API。
 */

const ASK_VERSION = "4.6-ask-free-2";
const MODEL = "@cf/zai-org/glm-4.7-flash"; // 2026-05-30 後 Cloudflare 把舊版 Llama 3.1 8B 系列下架，改用官方推薦的免費替代模型
const MAX_HISTORY_TURNS = 8; // 只帶最近幾輪，避免每次都把整串對話都送去

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
    const ai = context.env.AI;
    if (!ai) {
      return jsonResponse(
        {
          error:
            "尚未設定 AI 綁定，請到 Cloudflare Pages 專案 Settings → Functions → AI bindings 加上一個 Variable name 為 AI 的綁定。",
        },
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

    const messages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: message },
    ];

    const result = await ai.run(MODEL, {
      messages,
      max_tokens: 700,
      // GLM-4.7-flash 預設會先跑一段隱藏的「思考過程」再回答，容易把 token 額度耗在思考上、
      // 導致又慢又拿不到最終答案；關掉 thinking 讓它直接回答，聊天場景不需要深度推理。
      chat_template_kwargs: { enable_thinking: false },
    });

    let reply = String(result?.response || "").trim();
    if (!reply && Array.isArray(result?.choices)) {
      // 保險：如果之後模型改成回傳 OpenAI 相容格式，這裡也接得住
      reply = String(result.choices[0]?.message?.content || "").trim();
    }
    if (!reply) {
      return jsonResponse({ error: "AI 沒有回傳文字內容" }, 502);
    }

    return jsonResponse({ ok: true, version: ASK_VERSION, reply });
  } catch (e) {
    return jsonResponse({ error: e?.message || "ask function failed", version: ASK_VERSION }, 500);
  }
}
