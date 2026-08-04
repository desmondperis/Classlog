// POST /api/ask — AI Q&A over recent class-log data (topics covered, planned topics, remarks).
//   Body: { question: string, context: string }
//   The client builds `context` from data it has already loaded and is already permitted to see
//   (respecting the same admin/hod/teacher department scoping used everywhere else in the app), so
//   this endpoint doesn't need its own data-access logic — it's a thin, session-gated proxy whose
//   only job is to keep the OpenRouter key server-side and call NVIDIA Nemotron 3 Ultra.
// Requires OPENROUTER_API_KEY as a Cloudflare Pages environment variable (Settings → Environment
// variables → add as a secret). Get a key at openrouter.ai — never commit it to source; this file
// only ever reads it from env.
function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
}

async function requireSession(context) {
  const { request, env } = context;
  if (!env.LOG_KV) return { err: json({ error: "KV not bound (add a LOG_KV binding)" }, 500) };
  const sid = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!sid) return { err: json({ error: "unauthorized" }, 401) };
  const sess = await env.LOG_KV.get("sess:" + sid);
  if (!sess) return { err: json({ error: "unauthorized" }, 401) };
  let user = {}; try { user = JSON.parse(sess); } catch (e) {}
  return { env, user };
}

const MAX_QUESTION = 800;
const MAX_CONTEXT = 45000;

export async function onRequestPost(context) {
  const a = await requireSession(context);
  if (a.err) return a.err;
  const env = a.env;

  const key = env.OPENROUTER_API_KEY;
  if (!key) return json({ error: "no_key" }, 500);

  let body;
  try { body = await context.request.json(); } catch (e) { return json({ error: "bad request" }, 400); }
  const question = String((body && body.question) || "").trim().slice(0, MAX_QUESTION);
  const dataContext = String((body && body.context) || "").slice(0, MAX_CONTEXT);
  if (!question) return json({ error: "empty question" }, 400);

  const system = "You are a helpful assistant inside a school's Class Log app. You answer questions "
    + "about what teachers have logged for their classes — planned topics, topics actually covered, "
    + "and remarks — using ONLY the data table given below, nothing outside it. "
    + "Table columns: Date | Day | Teacher | Dept | Class | Subject | Planned topic | Topic covered | Remark. "
    + "A dash (—) means that field is empty. A row with a dash under 'Topic covered' means that class "
    + "session hasn't been reported yet — treat this as relevant to questions about classes falling "
    + "behind or teachers not reporting. Give a direct, concise answer (a few sentences, not an essay). "
    + "If the table doesn't contain enough to answer, say so plainly rather than guessing.\n\nDATA:\n" + dataContext;

  let resp;
  try {
    resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://classlog.pages.dev",
        "X-Title": "Class Log"
      },
      body: JSON.stringify({
        model: "nvidia/nemotron-3-ultra-550b-a55b:free",
        messages: [
          { role: "system", content: system },
          { role: "user", content: question }
        ]
      })
    });
  } catch (e) { return json({ error: "fetch failed" }, 502); }

  let data;
  try { data = await resp.json(); } catch (e) { return json({ error: "bad response from model" }, 502); }

  if (!resp.ok) {
    const msg = (data && data.error && data.error.message) || ("openrouter http " + resp.status);
    return json({ error: msg }, 502);
  }
  const choice = data && data.choices && data.choices[0];
  const answer = choice && choice.message && choice.message.content;
  if (!answer) return json({ error: "model returned no answer" }, 502);

  return json({ answer: String(answer).trim() });
}
