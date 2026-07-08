// /api/data — shared storage in KV. Every call requires a valid session.
//   GET  /api/data?key=w:YYYY-MM-DD:teacher   → { value }   (class log)
//   GET  /api/data?key=cfg:teachers            → { value }   (config, any signed-in user)
//   GET  /api/data?keys=k1,k2,...              → { values }
//   POST /api/data { key, value }              → { ok:true }  (cfg:* writes require admin)
function json(o, s) {
  return new Response(JSON.stringify(o), {
    status: s || 200,
    headers: { "content-type": "application/json" },
  });
}

// Class-log key: one blob per teacher per week. Teacher id is lowercase letters/digits.
function isDataKey(k) {
  return typeof k === "string" && /^w:\d{4}-\d{2}-\d{2}:[a-z0-9]+$/.test(k);
}
// Config keys (school setup). Readable by any signed-in user; writable by admins only.
function isConfigKey(k) {
  return typeof k === "string" && /^cfg:(teachers|rooms|schedule|depts)$/.test(k);
}

async function adminStatus(env, email) {
  email = (email || "").toLowerCase();
  if (!email) return false;
  const envList = (env.ADMIN_EMAILS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (envList.length) return envList.includes(email);
  let teachers = [];
  try {
    const t = await env.LOG_KV.get("cfg:teachers");
    if (t) teachers = JSON.parse(t);
  } catch (e) {}
  const admins = (Array.isArray(teachers) ? teachers : []).filter((t) => t && t.admin && t.email);
  if (admins.length) return admins.some((t) => (t.email || "").toLowerCase() === email);
  return true; // bootstrap: no admins configured yet
}

async function requireSession(context) {
  const { request, env } = context;
  if (!env.LOG_KV) return { err: json({ error: "KV not bound (add a LOG_KV binding)" }, 500) };
  const sid = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!sid) return { err: json({ error: "unauthorized" }, 401) };
  const sess = await env.LOG_KV.get("sess:" + sid);
  if (!sess) return { err: json({ error: "unauthorized" }, 401) };
  let user = {};
  try { user = JSON.parse(sess); } catch (e) {}
  return { env, user };
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
      keys.map(async (k) => {
        if (isDataKey(k) || isConfigKey(k)) values[k] = await env.LOG_KV.get(k);
      })
    );
    return json({ values });
  }

  const key = url.searchParams.get("key");
  if (!isDataKey(key) && !isConfigKey(key)) return json({ error: "bad key" }, 400);
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
  const dataK = isDataKey(key), cfgK = isConfigKey(key);
  if (!dataK && !cfgK) return json({ error: "bad key" }, 400);
  if (typeof value !== "string") return json({ error: "bad value" }, 400);
  if (value.length > (cfgK ? 2000000 : 200000)) return json({ error: "too large" }, 413);

  if (cfgK) {
    const ok = await adminStatus(env, (a.user || {}).email);
    if (!ok) return json({ error: "admin only" }, 403);
  }

  await env.LOG_KV.put(key, value);
  return json({ ok: true });
}
