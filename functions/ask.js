/**
 * ask.js — 4.6-ask-free-16.1-final-safe
 *
 * POST /ask
 * body: {
 *   message: string,
 *   history?: [{ role: "user"|"assistant", content: string }, ...],
 *   context?: string   // 持股摘要純文字；閒聊可不帶以省 neurons
 * }
 * 回傳: { ok: true, reply } 或 { ok: true, toolCalls: [{ name, arguments }] }
 *
 * Cloudflare Pages → Settings → Functions → AI bindings → Variable name: AI
 */
const ASK_VERSION = "4.6-ask-free-17.0-gptoss120b";
const MODEL = "@cf/openai/gpt-oss-120b";
const MAX_HISTORY_TURNS = 6; // 再縮一點省輸入 token
const MAX_MESSAGE_LEN = 2000;
const MAX_HISTORY_CONTENT = 3000;
const MAX_CONTEXT_LEN = 4000;
const MAX_TOKENS = 1000;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
    },
  });
}

const SYSTEM_PROMPT_BASE = `你是內嵌在個人存股資產追蹤 App 的助手，用繁體中文回答。

個性：像認識很久的朋友，不是客服。

使用者純聊天、開玩笑、問候、閒扯（沒有問任何跟持股/金額/交易有關的事）時：
- 直接接話、可以吐槽、可以自嘲、可以順著梗往下講
- 絕對不要在結尾加「若有投資問題歡迎詢問」「隨時可以查詢資料」這類客服式收尾句
- 不要主動把話題拉回投資，除非使用者自己提到

只要使用者的話牽涉到「金額、股數、報酬率」這類實際數字，或要求記交易、改目標，
才切回精準模式：嚴謹、不含糊、一切以下面規則為準。

【最重要】不要編造數字。只能使用「目前持股資料」或 query_app_data 回傳的數字。
資料不足就說「這個我這邊看不到資料」，不要硬湊。

使用者可能閒聊、問持股（賺多少、達標進度），或要求執行動作（記交易、改目標股數、改均價、改總目標）。
執行動作必須用工具（function calling），你無法直接改資料；App 會顯示確認卡，使用者按確定才生效。
資訊不夠（缺股數、價格等）先用文字問清楚，不要瞎猜後呼叫工具。

query_app_data 是唯讀查詢，可直接呼叫，不用確認卡。系統會把查詢結果以正式的工具回覆（tool 訊息）交給你，
收到工具回覆後就代表查詢已完成，直接根據內容用文字回答，不要再次呼叫同一個查詢。
【重要】彙總結果都已由程式算好，不要自己對 records 明細手動加減比較。
- 現在持股成本：看摘要即可
- 過去某日成本：source=holding_cost + symbol + asOfDate
- A→B 變化量：source=daily_records, aggregation=start_end, fromDate/toDate（跟區間長短無關，
  橫跨數月也一樣一次查完，不要覺得範圍大就遲疑或改用別的方式）
- 某日絕對本金/市值：aggregation=summary，填 toDate（或同一天）
- 哪個月漲跌最多：aggregation=min_max
- 月度趨勢：aggregation=monthly；明細才用 records
- 交易/配息：source=trades 或 dividends；統計用 summary，列表用 records
同一問題最多查 2 次；不確定「變化量還是絕對值」就直接問使用者。

手機小視窗：回答簡潔。可結合最近對話理解省略句。
你不是財務顧問，不要給應買應賣建議，可中性說明資訊。`;

const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];

function taiwanNowLabel() {
  const now = new Date();
  const t = new Date(now.getTime() + 8 * 60 * 60 * 1000);
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
          fee: { type: "number", description: "手續費，沒說填 0" },
          tax: { type: "number", description: "證交稅（賣出），沒說填 0" },
          date: { type: "string", description: `交易日期 YYYY-MM-DD，沒說用今天 ${taiwanTodayStr()}` },
          note: { type: "string", description: "備註，沒有就空字串" },
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
      description: "手動設定平均成本，或清除改回自動計算",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "股票代號" },
          avgCost: { type: "number", description: "新均價；清除時可填 0" },
          clear: { type: "boolean", description: "true=清除手動設定，改回自動計算" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_goal",
      description: "修改總目標金額或目標年份",
      parameters: {
        type: "object",
        properties: {
          targetAmount: { type: "number", description: "新目標金額（TWD），不改就不要帶" },
          targetYear: { type: "number", description: "新目標年份，不改就不要帶" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_app_data",
      description: "唯讀查詢總入口。需要 App 內歷史數字時主動使用並一次選對 source + aggregation：區間變化用 daily_records+start_end；單日絕對值用 daily_records+summary；月趨勢用 daily_records+monthly；極值用 daily_records+min_max；交易/配息統計用 trades/dividends+summary；列表才用 records；過去持有成本用 holding_cost。",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            enum: ["daily_records", "trades", "dividends", "holding_cost"],
            description: "資料來源",
          },
          fromDate: { type: "string", description: "起始 YYYY-MM-DD" },
          toDate: { type: "string", description: "結束 YYYY-MM-DD" },
          asOfDate: { type: "string", description: "holding_cost：計算到此日（含）" },
          symbol: { type: "string", description: "股票代號；holding_cost 必填" },
          aggregation: {
            type: "string",
            enum: ["records", "start_end", "monthly", "min_max", "summary"],
            description: "daily_records: records/start_end/monthly/min_max；trades/dividends: records 或 summary",
          },
          fields: {
            type: "array",
            items: {
              type: "string",
              enum: ["totalAsset", "totalCost", "totalGain", "twValue", "usValue", "twCost", "usCost", "twGain", "usGain"],
            },
            description: "關注欄位；min_max 用第一個當比較鍵，預設 totalGain",
          },
          limit: { type: "number", description: "records 最多筆數，預設 120，上限 200" },
        },
        required: ["source"],
      },
    },
  },
 ];

const ALLOWED_TOOL_NAMES = new Set([
  "add_trade",
  "update_holding_target",
  "update_manual_avg_cost",
  "update_goal",
  "query_app_data",
]);

function friendlyAiError(message) {
  const s = String(message || "");
  if (/neuron|quota|limit|daily|exceeded|usage/i.test(s)) {
    return "今日 AI 免費額度可能已用完，等額度重置後再試。";
  }
  if (/unauthorized|forbidden|401|403/i.test(s)) {
    return "AI 服務授權失敗，請檢查 Cloudflare 設定。";
  }
  if (/binding|AI binding|env\.AI/i.test(s)) {
    return "尚未設定 Cloudflare AI Binding（Variable name: AI）。";
  }
  return s || "ask function failed";
}

export async function onRequestPost(context) {
  try {
    const ai = context.env.AI;

    // Optional Cloudflare Rate Limiting binding. If it is not configured,
    // nothing changes. We only use the anonymous device id supplied by the
    // app; we do not forward the visitor IP to the model.
    const limiter = context.env.ASK_RATE_LIMITER;
    const deviceId = String(context.request.headers.get("x-device-id") || "").slice(0, 80);
    if (limiter && deviceId) {
      const limited = await limiter.limit({ key: deviceId });
      if (limited && limited.success === false) {
        return jsonResponse({ error: "AI 問答太頻繁了，請稍後再試。", version: ASK_VERSION }, 429);
      }
    }
    if (!ai) {
      return jsonResponse(
        {
          error:
            "尚未設定 AI 綁定，請到 Cloudflare Pages 專案 Settings → Functions → AI bindings 加上 Variable name 為 AI 的綁定。",
          version: ASK_VERSION,
        },
        500
      );
    }

    const body = await context.request.json().catch(() => null);
    const message = String(body?.message || "").trim();
    if (!message) return jsonResponse({ error: "沒有收到訊息內容", version: ASK_VERSION }, 400);
    if (message.length > MAX_MESSAGE_LEN) {
      return jsonResponse({ error: "訊息太長了，麻煩縮短一點", version: ASK_VERSION }, 400);
    }

    const rawHistory = Array.isArray(body?.history) ? body.history : [];
    const history = rawHistory
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-MAX_HISTORY_TURNS * 2)
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CONTENT) }));

    const contextText =
      typeof body?.context === "string" ? body.context.slice(0, MAX_CONTEXT_LEN) : "";

    const dateLine = `現在的日期時間是：${taiwanNowLabel()}。問「今天」「現在」「幾天後」以此為準。`;
    const systemPrompt = contextText
      ? `${SYSTEM_PROMPT_BASE}\n\n${dateLine}\n\n目前持股資料：\n${contextText}`
      : `${SYSTEM_PROMPT_BASE}\n\n${dateLine}`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: message },
    ];

    // 標準工具呼叫來回：把之前每一輪「AI 呼叫了什麼工具」+「實際查到的結果」
    // 用正式的 assistant tool_calls + tool 訊息接回對話，而不是塞成一段文字。
    // 這樣不管幾輪，模型都能正確判斷「工具已經回覆」，不會再重複呼叫同一個查詢。
    // toolTurns: [{ calls: [{id,name,arguments}], results: [{id,content}] }, ...]（依發生順序）
    const toolTurns = Array.isArray(body?.toolTurns) ? body.toolTurns : [];
    toolTurns.forEach((turn) => {
      const calls = Array.isArray(turn?.calls) ? turn.calls : [];
      const results = Array.isArray(turn?.results) ? turn.results : [];
      if (!calls.length) return;
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: calls.map((tc) => ({
          id: String(tc?.id || ""),
          type: "function",
          function: {
            name: String(tc?.name || ""),
            arguments: JSON.stringify(tc?.arguments || {}),
          },
        })),
      });
      results.forEach((tr) => {
        messages.push({
          role: "tool",
          tool_call_id: String(tr?.id || ""),
          content: String(tr?.content || "").slice(0, MAX_CONTEXT_LEN),
        });
      });
    });

    const result = await ai.run(MODEL, {
      messages,
      max_tokens: MAX_TOKENS,
      tools: TOOLS,
    });

    const rawToolCalls =
      result?.tool_calls ||
      result?.response?.tool_calls ||
      result?.choices?.[0]?.message?.tool_calls ||
      null;

    if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
      const toolCalls = rawToolCalls
        .map((tc, idx) => {
          const name = tc?.name || tc?.function?.name;
          let args = tc?.arguments ?? tc?.function?.arguments;
          if (typeof args === "string") {
            try {
              const cleanArgs = args.replace(/```json\n?/gi, "").replace(/```/g, "").trim();
              args = JSON.parse(cleanArgs);
            } catch {
              args = {};
            }
          }
          // 有些模型不會回傳 id，這裡補一個穩定的 fallback，讓下一輪可以正確對應回去。
          const id = String(tc?.id || tc?.tool_call_id || `call_${idx}`);
          return name && ALLOWED_TOOL_NAMES.has(name)
            ? { id, name, arguments: args || {} }
            : null;
        })
        .filter(Boolean);

      if (toolCalls.length > 0) {
        return jsonResponse({ ok: true, version: ASK_VERSION, toolCalls });
      }
    }

    let reply = String(result?.response || "").trim();
    if (!reply && Array.isArray(result?.choices)) {
      reply = String(result.choices[0]?.message?.content || "").trim();
    }
    if (!reply) {
      return jsonResponse({ error: "AI 沒有回傳文字內容", version: ASK_VERSION }, 502);
    }

    return jsonResponse({ ok: true, version: ASK_VERSION, reply });
  } catch (e) {
    return jsonResponse({ error: friendlyAiError(e?.message), version: ASK_VERSION }, 500);
  }
}
