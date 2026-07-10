// /api/data — shared storage in KV. Every call requires a valid session.
//   GET  ?key=w:YYYY-MM-DD:teacher   → { value }   (class log; gated by role)
//   GET  ?key=cfg:teachers           → { value }   (config; any signed-in user)
//   GET  ?keys=k1,k2,...             → { values }   (each key gated)
//   POST { key, value }              → { ok:true }  (own log, or admin for any; cfg:* admin-only)
function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
}
function isDataKey(k) { return typeof k === "string" && /^w:\d{4}-\d{2}-\d{2}:[a-z0-9]+$/.test(k); }
function isConfigKey(k) { return typeof k === "string" && /^cfg:(teachers|rooms|schedule|depts|places)$/.test(k); }
function tidOfKey(k) { const m = /^w:\d{4}-\d{2}-\d{2}:([a-z0-9]+)$/.exec(k || ""); return m ? m[1] : null; }

const ROLES = ["teacher", "hod", "leader", "admin"];
function roleOf(t) {
  if (!t) return "teacher";
  if (t.role && ROLES.indexOf(t.role) >= 0) return t.role;
  if (t.admin === true) return "admin";
  return "teacher";
}
async function identify(env, email) {
  email = (email || "").toLowerCase();
  let teachers = [];
  try { const t = await env.LOG_KV.get("cfg:teachers"); teachers = t ? JSON.parse(t) : []; if (!Array.isArray(teachers)) teachers = []; } catch (e) { teachers = []; }
  const OWNER = ["desmondperis@gmail.com"];
  const envList = (env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).concat(OWNER);
  const configuredAdmin = envList.length > 0 || teachers.some((t) => t && t.email && (t.role === "admin" || t.admin === true));
  const me = email ? teachers.find((t) => (t.email || "").toLowerCase() === email) : null;
  let role = roleOf(me);
  if (envList.indexOf(email) >= 0) role = "admin";
  if (!configuredAdmin) role = "admin";
  return { teacherId: me ? me.id : null, role, dept: me ? (me.dept || "") : "", teachers };
}
function canRead(idn, tid) {
  if (idn.role === "admin" || idn.role === "leader") return true;
  if (idn.role === "hod" || idn.role === "teacher") { const t = idn.teachers.find((x) => x.id === tid); return !!t && t.dept === idn.dept; }
  return tid === idn.teacherId;
}
function canWrite(idn, tid) {
  if (idn.role === "admin") return true;
  if (idn.role === "hod") { const t = idn.teachers.find((x) => x.id === tid); return tid === idn.teacherId || (!!t && t.dept === idn.dept); }
  return tid === idn.teacherId; // teacher / leader write own only
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

export async function onRequestGet(context) {
  const a = await requireSession(context);
  if (a.err) return a.err;
  const env = a.env;
  const idn = await identify(env, (a.user || {}).email);
  const url = new URL(context.request.url);

  const keysParam = url.searchParams.get("keys");
  if (keysParam !== null) {
    const keys = keysParam ? keysParam.split(",").filter(Boolean) : [];
    const values = {};
    await Promise.all(keys.map(async (k) => {
      if (isConfigKey(k)) { values[k] = await env.LOG_KV.get(k); return; }
      if (isDataKey(k) && canRead(idn, tidOfKey(k))) { values[k] = await env.LOG_KV.get(k); }
    }));
    return json({ values });
  }

  const key = url.searchParams.get("key");
  if (isConfigKey(key)) return json({ value: await env.LOG_KV.get(key) });
  if (!isDataKey(key)) return json({ error: "bad key" }, 400);
  if (!canRead(idn, tidOfKey(key))) return json({ error: "forbidden" }, 403);
  return json({ value: await env.LOG_KV.get(key) });
}

export async function onRequestPost(context) {
  const a = await requireSession(context);
  if (a.err) return a.err;
  const env = a.env;
  const idn = await identify(env, (a.user || {}).email);

  let body;
  try { body = await context.request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  const key = body && body.key;
  const value = body && body.value;
  const dataK = isDataKey(key), cfgK = isConfigKey(key);
  if (!dataK && !cfgK) return json({ error: "bad key" }, 400);
  if (typeof value !== "string") return json({ error: "bad value" }, 400);
  if (value.length > (cfgK ? 2000000 : 200000)) return json({ error: "too large" }, 413);

  if (cfgK) {
    if (idn.role !== "admin") return json({ error: "admin only" }, 403);
  } else {
    if (!canWrite(idn, tidOfKey(key))) return json({ error: "forbidden" }, 403);
  }

  await env.LOG_KV.put(key, value);
  return json({ ok: true });
}
