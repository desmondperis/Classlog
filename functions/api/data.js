// /api/data — shared class-log storage in KV. Every call requires a valid session.
//   GET  /api/data?key=w:YYYY-MM-DD:teacher        → { value }
//   GET  /api/data?keys=key1,key2,...              → { values: { key: value } }
//   POST /api/data  body { key, value }            → { ok: true }
function json(o, s) {
  return new Response(JSON.stringify(o), {
    status: s || 200,
    headers: { "content-type": "application/json" },
  });
}

// Only allow the class-log key shape, so a session can't read/write anything else (e.g. sessions).
function isDataKey(k) {
  return typeof k === "string" && /^w:\d{4}-\d{2}-\d{2}:[a-z]+$/.test(k);
}

async function requireSession(context) {
  const { request, env } = context;
  if (!env.LOG_KV) return { err: json({ error: "KV not bound (add a LOG_KV binding)" }, 500) };
  const sid = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!sid) return { err: json({ error: "unauthorized" }, 401) };
  const sess = await env.LOG_KV.get("sess:" + sid);
  if (!sess) return { err: json({ error: "unauthorized" }, 401) };
  return { env };
}

export async function onRequestGet(context) {
  const a = await requireSession(context);
  if (a.err) return a.err;
  const env = a.env;
  const url = new URL(context.request.url);

  const keysParam = url.searchParams.get("keys");
  if (keysParam !== null) {
    const keys = keysParam ? keysParam.split(",").filter(Boolean) : [];
    const values = {};
    await Promise.all(
      keys.map(async (k) => { if (isDataKey(k)) values[k] = await env.LOG_KV.get(k); })
    );
    return json({ values });
  }

  const key = url.searchParams.get("key");
  if (!isDataKey(key)) return json({ error: "bad key" }, 400);
  const value = await env.LOG_KV.get(key);
  return json({ value });
}

export async function onRequestPost(context) {
  const a = await requireSession(context);
  if (a.err) return a.err;
  const env = a.env;

  let body;
  try { body = await context.request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  const key = body && body.key;
  const value = body && body.value;
  if (!isDataKey(key)) return json({ error: "bad key" }, 400);
  if (typeof value !== "string") return json({ error: "bad value" }, 400);
  if (value.length > 200000) return json({ error: "too large" }, 413);

  await env.LOG_KV.put(key, value);
  return json({ ok: true });
}
