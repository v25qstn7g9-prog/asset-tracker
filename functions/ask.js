/**
 * ask.js — 4.6-ask-free-4
 *
 * 聊天/問答功能：前端把使用者訊息 + 對話歷史 + 目前持股摘要（純文字）一起丟過來，
 * 這支 Function 組成訊息陣列，呼叫 Cloudflare Workers AI（免費），回傳文字答案，
 * 或是在使用者要求「幫我做某件事」時，回傳一個「提議的動作」（tool call）讓前端
 * 顯示確認卡片 —— AI 只負責提議，實際寫入資料由前端在使用者按「確定」後執行，
 * AI 本身沒有能力直接改動任何資料。
 *
 * 用法：POST /ask
 *   body: {
 *     message: "我 0056 現在賺多少？",
 *     history: [{role:"user"|"assistant", content:"..."}, ...],  // 最近幾輪對話，可省略
 *     context: "0050 目前4645股 平均成本80.39 ..."                // 持股摘要純文字，可省略（純閒聊時可不帶）
 *   }
 *   回傳（一般回答）: { ok: true, reply: "..." }
 *   回傳（AI 想執行動作）: { ok: true, toolCalls: [{ name, arguments }] }
 *
 * 需要在 Cloudflare Pages 專案設定 AI 綁定（不用申請外部 API 金鑰，完全免費）：
 *   專案 → Settings → Functions → AI bindings → Add binding
 *   Variable name: AI
 *
 * 免費額度：每帳號每天 10,000 neurons，個人使用完全夠用，超過才會計費。
 */

const ASK_VERSION = "4.6-ask-free-4";
const MODEL = "@cf/zai-org/glm-4.7-flash";
const MAX_HISTORY_TURNS = 16; // 多保留一些上下文，讓短句/代名詞也能接得上前文

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
使用者可能單純閒聊，也可能問跟他自己持股相關的問題（例如「我現在賺多少」「什麼時候會達標」），
也可能要求你「幫他做某件事」（例如「幫我記一筆交易」「把目標改成多少股」）。

如果訊息裡有附上「目前持股資料」，那是使用者當下 App 裡的真實數字，直接拿來回答、
不用再叫他自己去查；如果問題跟持股資料無關，就正常聊。

如果使用者要求你做動作（新增交易、修改目標股數、修改平均成本、修改總目標金額），
用提供的工具（function calling）去發起，不要只用文字回答說你會做——你自己沒辦法真的
改動任何資料，一定要透過工具呼叫，讓 App 顯示確認卡片給使用者按確定才會真的生效。
如果使用者給的資訊不夠（例如沒說股數或價格），先用文字問清楚，不要用工具呼叫瞎猜數字。

這是手機上的小聊天視窗，回答要自然、口語、有延續感，不要像客服或一次性問答機器人。
如果使用者用很短的句子、代名詞、笑聲、反問或省略句，優先結合最近對話理解，不要把每一句都當成全新問題。
如果能合理判斷是在延續上一個話題，就直接接著聊，不要重複背景，也不要一直重新解釋使用者剛剛已經知道的內容。
回答主要問題後，可以自然補一句有用的觀察、延伸或下一步，但不要每次都硬塞問題，也不要刻意拉長。
閒聊時可以有反應、有個性、可以接梗；資訊型問題則先把答案講清楚，再視情況補充。
不要只做「一問一答」；若前文有明確脈絡，回答要延續那個脈絡。
你不是財務顧問，不要給「應該買/應該賣」這種明確投資建議，可以中性分析、給資訊，
但決策留給使用者自己判斷。`;

const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];

// 這個模型跟你的訓練資料一樣，本身不知道「現在」是幾點幾號；
// 直接用伺服器的真實時間算出台灣現在的日期時間，塞進 system prompt，
// 這樣才不會依賴使用者手機的時間設定（也比較準）。
function taiwanNowLabel() {
  const now = new Date();
  const t = new Date(now.getTime() + 8 * 60 * 60 * 1000); // UTC+8
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  const hh = String(t.getUTCHours()).padStart(2, "0");
  const mm = String(t.getUTCMinutes()).padStart(2, "0");
  const weekday = WEEKDAY_ZH[t.getUTCDay()];
  return `${y}-${m}-${d}（星期${weekday}）${hh}:${mm}（台灣時間 UTC+8）`;
}

function taiwanTodayStr() {
  const now = new Date();
  const t = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

// 只開放這 4 個動作；「刪除交易」故意不開放 —— 用自然語言去配對「要刪哪一筆」風險太高，
// 容易刪錯，這類危險動作留給使用者自己在 App 裡手動刪。
const TOOLS = [
  {
    type: "function",
    function: {
      name: "add_trade",
      description: "新增一筆買進或賣出交易紀錄",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "股票代號，例如 0050" },
          action: { type: "string", enum: ["buy", "sell"], description: "buy=買進，sell=賣出" },
          shares: { type: "number", description: "股數" },
          price: { type: "number", description: "每股成交價" },
          fee: { type: "number", description: "手續費，使用者沒說就填 0" },
          tax: { type: "number", description: "證交稅（只有賣出才有），使用者沒說就填 0" },
          date: { type: "string", description: `交易日期 YYYY-MM-DD，使用者沒說就用今天 ${taiwanTodayStr()}` },
          note: { type: "string", description: "備註，沒有就留空字串" },
        },
        required: ["symbol", "action", "shares", "price"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_holding_target",
      description: "修改某檔股票的目標股數",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "股票代號" },
          target: { type: "number", description: "新的目標股數" },
        },
        required: ["symbol", "target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_manual_avg_cost",
      description: "手動設定某檔股票的平均成本（覆蓋掉自動計算的均價），或清除手動設定改回自動計算",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "股票代號" },
          avgCost: { type: "number", description: "新的平均成本；若使用者要求清除手動設定、改回自動計算，這裡填 0" },
          clear: { type: "boolean", description: "true 表示清除手動設定、改回自動計算，此時忽略 avgCost" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_goal",
      description: "修改整體投資的總目標金額或目標年份",
      parameters: {
        type: "object",
        properties: {
          targetAmount: { type: "number", description: "新的目標金額（新台幣），沒有要改就不要帶這個欄位" },
          targetYear: { type: "number", description: "新的目標年份，沒有要改就不要帶這個欄位" },
        },
      },
    },
  },
];

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

    const contextText = typeof body?.context === "string" ? body.context.slice(0, 10000) : "";
    const dateLine = `現在的日期時間是：${taiwanNowLabel()}。使用者問「今天」「現在」「幾天後」這類問題時，以這個時間為準去計算。`;
    const systemPrompt = contextText
      ? `${SYSTEM_PROMPT_BASE}\n\n${dateLine}\n\n目前持股資料（使用者 App 裡的即時數字）：\n${contextText}`
      : `${SYSTEM_PROMPT_BASE}\n\n${dateLine}`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: message },
    ];

    const result = await ai.run(MODEL, {
      messages,
      max_tokens: 700,
      tools: TOOLS,
      // GLM-4.7-flash 預設會先跑一段隱藏的「思考過程」再回答，容易把 token 額度耗在思考上、
      // 導致又慢又拿不到最終答案；關掉 thinking 讓它直接回答，聊天場景不需要深度推理。
      chat_template_kwargs: { enable_thinking: false },
    });

    // 優先處理「AI 想呼叫工具」的情況：不執行，只是把提議整理好回傳給前端顯示確認卡片。
    const rawToolCalls = result?.tool_calls || result?.response?.tool_calls || null;
    if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
      const toolCalls = rawToolCalls
        .map((tc) => {
          const name = tc?.name || tc?.function?.name;
          let args = tc?.arguments ?? tc?.function?.arguments;
          if (typeof args === "string") {
            try { args = JSON.parse(args); } catch { args = {}; }
          }
          return name ? { name, arguments: args || {} } : null;
        })
        .filter(Boolean);

      if (toolCalls.length > 0) {
        return jsonResponse({ ok: true, version: ASK_VERSION, toolCalls });
      }
    }

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
