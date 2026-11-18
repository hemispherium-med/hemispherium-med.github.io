/**
 * Посредник между сайтом «Медицинский тренажёр» и нейросетью OpenRouter.
 *
 * Зачем он нужен: ключ OpenRouter нельзя класть в код сайта — сайт открыт всем,
 * и ключ можно было бы украсть. Ключ хранится здесь, в секретах Cloudflare
 * (переменная OPENROUTER_API_KEY), а сайт присылает только данные вопроса.
 *
 * Защита от злоупотреблений:
 *  - запросы принимаются только со страниц сайта (ALLOWED_ORIGINS);
 *  - не больше RL запросов в минуту с одного IP (настройка ratelimits в wrangler.toml);
 *  - текст запроса собирается здесь по готовому шаблону, длина полей обрезается,
 *    длина ответа ограничена (MAX_TOKENS) — посредника нельзя использовать как
 *    «бесплатный чат» для чего угодно.
 *
 * Адреса:
 *  POST /chat    — получить ответ (потоком, в формате SSE, как отдаёт OpenRouter);
 *                  task: explain — разбор ошибки, ask — вопрос-ответ, check — проверка ответа в задаче
 *  GET  /health  — проверка настройки: { ok, model, key } (сам ключ не показывается)
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

const MAX = { text: 700, option: 300, expl: 1600, note: 400, src: 200, options: 8, question: 400, frag: 900, frags: 6 };

const SYSTEM = "Ты — доброжелательный преподаватель-медик. Отвечаешь студентам-медикам младших курсов по-русски, простым языком, без markdown и без заголовков. Не выдумываешь факты: опираешься на данные из учебника, которые тебе дали. Если данных не хватает, честно говоришь об этом.";

function str(v, max) {
  if (typeof v !== "string") return "";
  return v.replace(/\s+/g, " ").trim().slice(0, max);
}
function list(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, maxItems).map(x => str(x, maxLen)).filter(Boolean);
}

/** Собирает сообщения для нейросети по типу задачи. Возвращает null, если данные неверные. */
export function buildMessages(body) {
  if (!body || typeof body !== "object") return null;
  if (body.task === "explain") {
    const q = str(body.q, MAX.text);
    const options = list(body.options, MAX.options, MAX.option);
    const chosen = list(body.chosen, MAX.options, MAX.option);
    const right = list(body.right, MAX.options, MAX.option);
    const expl = str(body.expl, MAX.expl);
    const src = str(body.src, MAX.src);
    const notes = Array.isArray(body.notes) ? body.notes.slice(0, MAX.options)
      .map(n => n && typeof n === "object" ? { x: str(n.x, MAX.option), n: str(n.n, MAX.note) } : null)
      .filter(n => n && n.x && n.n) : [];
    if (!q || !options.length || !right.length) return null;
    const user = `Студент ошибся в тестовом вопросе. Объясни:
1) почему выбранный им ответ неверен;
2) почему верен правильный ответ (опирайся на пояснение из учебника, не противоречь ему);
3) как это легко запомнить (короткий приём или ассоциация).
Не более 8 предложений.

Источник: ${src || "учебник"}
Вопрос: ${q}
Варианты: ${options.join(" | ")}
Студент выбрал: ${chosen.join(" | ") || "—"}
Правильный ответ: ${right.join(" | ")}
Пояснение из учебника: ${expl || "—"}
${notes.map(n => `Почему «${n.x}» неверно: ${n.n}`).join("\n")}`.trim();
    return [{ role: "system", content: SYSTEM }, { role: "user", content: user }];
  }
  if (body.task === "ask") {
    const question = str(body.question, MAX.question);
    const frags = Array.isArray(body.frags) ? body.frags.slice(0, MAX.frags)
      .map(f => f && typeof f === "object" ? { src: str(f.src, MAX.src), q: str(f.q, MAX.text), a: str(f.a, MAX.frag), e: str(f.e, MAX.frag) } : null)
      .filter(f => f && (f.q || f.a)) : [];
    if (!question || !frags.length) return null;
    const user = `Студент задал вопрос. Ответь в 3–7 предложениях.
Опирайся ТОЛЬКО на фрагменты из учебников ниже. Если во фрагментах нет ответа, прямо скажи, что в книгах этого не нашлось, и не придумывай. В конце укажи источники в скобках (книга, глава, страница).

Вопрос студента: ${question}

Фрагменты:
${frags.map((f, i) => `[${i + 1}] Источник: ${f.src || "учебник"}\nВопрос: ${f.q}\nОтвет: ${f.a}${f.e ? `\nПояснение: ${f.e}` : ""}`).join("\n\n")}`;
    return [{ role: "system", content: SYSTEM }, { role: "user", content: user }];
  }
  if (body.task === "check") {
    const title = str(body.title, MAX.src);
    const text = str(body.text, MAX.expl);
    const q = str(body.q, MAX.text);
    const a = str(body.a, MAX.expl);
    const answer = str(body.answer, 1200);
    if (!q || !a || !answer) return null;
    const user = `Проверь ответ студента на вопрос клинической задачи по неотложной абдоминальной хирургии. Сравни его с эталоном из книги.
Первая строка ответа строго: «Оценка: верно», «Оценка: частично верно» или «Оценка: неверно».
Дальше 3–7 предложений: что студент указал правильно, что упустил или в чём ошибся и почему это важно для больного. Не придирайся к формулировкам, если смысл совпадает с эталоном. Не добавляй требований, которых нет в эталоне.

Задача: ${title}
Условие: ${text}
Вопрос: ${q}
Эталон: ${a}
Ответ студента: ${answer}`;
    return [{ role: "system", content: SYSTEM }, { role: "user", content: user }];
  }
  return null;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = okOrigin
      ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", "Vary": "Origin" }
      : { "Vary": "Origin" };

    if (request.method === "OPTIONS") return new Response(null, { status: okOrigin ? 204 : 403, headers: cors });
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, model: env.MODEL || DEFAULT_MODEL, key: Boolean(env.OPENROUTER_API_KEY), origins: allowed }, 200, cors);
    }
    if (request.method !== "POST" || url.pathname !== "/chat") return json({ error: "not_found" }, 404, cors);
    if (!okOrigin) return json({ error: "forbidden_origin" }, 403, cors);
    if (!env.OPENROUTER_API_KEY) return json({ error: "no_key" }, 500, cors);

    if (env.RL && typeof env.RL.limit === "function") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.RL.limit({ key: ip });
      if (!success) return json({ error: "rate_limited" }, 429, cors);
    }

    let body;
    try {
      const text = await request.text();
      if (text.length > 20000) return json({ error: "too_large" }, 413, cors);
      body = JSON.parse(text);
    } catch (e) {
      return json({ error: "bad_json" }, 400, cors);
    }
    const messages = buildMessages(body);
    if (!messages) return json({ error: "bad_request" }, 400, cors);

    let upstream;
    try {
      upstream = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": env.SITE_URL || "https://hemispherium-med.github.io",
          "X-OpenRouter-Title": "HemiSpherium",
        },
        body: JSON.stringify({
          model: env.MODEL || DEFAULT_MODEL,
          messages,
          stream: true,
          max_tokens: Number(env.MAX_TOKENS) || 700,
          temperature: 0.3,
          reasoning: { enabled: false },
        }),
      });
    } catch (e) {
      return json({ error: "upstream_unreachable" }, 502, cors);
    }
    if (!upstream.ok || !upstream.body) {
      const code = upstream.status;
      const detail = (await upstream.text().catch(() => "")).slice(0, 300);
      const error = code === 401 ? "bad_key" : code === 402 ? "no_credits" : code === 429 ? "rate_limited" : "upstream";
      return json({ error, status: code, detail }, code === 429 ? 429 : 502, cors);
    }
    return new Response(upstream.body, {
      status: 200,
      headers: { ...cors, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
    });
  },
};
