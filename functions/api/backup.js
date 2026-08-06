// GET  /api/backup?meta=1              — admin only. Returns { lastBackup } metadata for this branch.
// GET  /api/backup[?cursor=...]        — admin only. Returns one page of raw key/value pairs for the
//   caller's current branch: { values, cursor, done }. A full export is many pages, not one big call —
//   Cloudflare's free plan caps a single Worker invocation at 1,000 subrequests, so each page here uses
//   at most ~1 (list) + 300 (get) = 301, comfortably under that. The client calls this repeatedly,
//   passing the returned cursor back, until done:true, then assembles the full file itself.
//   Session tokens (sess:*) are never included — they're not data worth keeping and would just be stale.
// POST /api/backup                     — admin only. Two shapes:
//   { entries: { bareKey: value|null, ... } }  restores up to ~400 keys per call (value=null deletes
//     the key). Writes raw bytes directly, bypassing data.js's merge-on-write logic, because a restore
//     is explicitly meant to put things back exactly as they were, not merge with what's there now.
//   { meta: { at, keys } }  records when a backup last completed, for the "Last backup: ..." note in
//     the admin UI. Does not touch any app data.
function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
}

const BRANCHES = ["Anand Niketan", "Junior-Anand Niketan", "Gurugram", "ILC", "Dwarka", "Junior-Dwarka", "Junior Wing-Dwarka"];
const DEFAULT_BRANCH = "Anand Niketan";
function normBranch(b) { b = (b || "").trim(); return BRANCHES.indexOf(b) >= 0 ? b : DEFAULT_BRANCH; }
function branchSlug(b) { return String(b || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function branchPrefix(b) { b = normBranch(b); return b === DEFAULT_BRANCH ? "" : ("b:" + branchSlug(b) + ":"); }

const ROLES = ["teacher", "hod", "leader", "admin"];
function roleOf(t) {
  if (!t) return "teacher";
  if (t.role && ROLES.indexOf(t.role) >= 0) return t.role;
  if (t.admin === true) return "admin";
  return "teacher";
}
async function roleOfSession(env, email, prefix) {
  email = (email || "").toLowerCase();
  let teachers = [];
  try { const t = await env.LOG_KV.get(prefix + "cfg:teachers"); teachers = t ? JSON.parse(t) : []; if (!Array.isArray(teachers)) teachers = []; } catch (e) { teachers = []; }
  const OWNER = ["desmondperis@gmail.com"];
  const envList = (env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).concat(OWNER);
  if (envList.indexOf(email) >= 0) return "admin";
  const me = teachers.find((t) => (t.email || "").toLowerCase() === email);
  return roleOf(me);
}

async function requireAdmin(context) {
  const { request, env } = context;
  if (!env.LOG_KV) return { err: json({ error: "KV not bound (add a LOG_KV binding)" }, 500) };
  const sid = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!sid) return { err: json({ error: "unauthorized" }, 401) };
  const sess = await env.LOG_KV.get("sess:" + sid);
  if (!sess) return { err: json({ error: "unauthorized" }, 401) };
  let user = {}; try { user = JSON.parse(sess); } catch (e) {}
  const prefix = branchPrefix((user || {}).branch);
  const role = await roleOfSession(env, (user || {}).email, prefix);
  if (role !== "admin") return { err: json({ error: "admin only" }, 403) };
  return { env, user, prefix };
}

const META_KEY_SUFFIX = "meta:backup";
const MAX_GET_BATCH = 300;
const MAX_PUT_BATCH = 400;

export async function onRequestGet(context) {
  const a = await requireAdmin(context);
  if (a.err) return a.err;
  const { env, prefix } = a;
  const url = new URL(context.request.url);

  if (url.searchParams.get("meta") === "1") {
    let raw = null;
    try { raw = await env.LOG_KV.get(prefix + META_KEY_SUFFIX); } catch (e) {}
    let lastBackup = null;
    try { lastBackup = raw ? JSON.parse(raw) : null; } catch (e) { lastBackup = null; }
    return json({ lastBackup });
  }

  const cursor = url.searchParams.get("cursor") || undefined;
  let listRes;
  try { listRes = await env.LOG_KV.list({ prefix, cursor, limit: MAX_GET_BATCH }); }
  catch (e) { return json({ error: "list failed" }, 502); }

  const names = listRes.keys.map((k) => k.name).filter((name) => {
    const bare = prefix ? name.slice(prefix.length) : name;
    return bare.indexOf("sess:") !== 0;
  });

  const values = {};
  await Promise.all(names.map(async (name) => {
    const bare = prefix ? name.slice(prefix.length) : name;
    try { values[bare] = await env.LOG_KV.get(name); } catch (e) { values[bare] = null; }
  }));

  return json({
    values,
    cursor: listRes.list_complete ? null : listRes.cursor,
    done: !!listRes.list_complete
  });
}

export async function onRequestPost(context) {
  const a = await requireAdmin(context);
  if (a.err) return a.err;
  const { env, prefix } = a;

  let body;
  try { body = await context.request.json(); } catch (e) { return json({ error: "bad request" }, 400); }

  if (body && body.meta && typeof body.meta === "object") {
    const at = String(body.meta.at || new Date().toISOString()).slice(0, 40);
    const keys = Number.isFinite(body.meta.keys) ? body.meta.keys : 0;
    try { await env.LOG_KV.put(prefix + META_KEY_SUFFIX, JSON.stringify({ at, keys })); } catch (e) {}
    return json({ ok: true });
  }

  const entries = body && body.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return json({ error: "bad entries" }, 400);
  const keys = Object.keys(entries);
  if (!keys.length) return json({ error: "empty batch" }, 400);
  if (keys.length > MAX_PUT_BATCH) return json({ error: "batch too large — send at most " + MAX_PUT_BATCH + " keys per call" }, 400);

  let written = 0, failed = 0;
  await Promise.all(keys.map(async (bare) => {
    if (bare.indexOf("sess:") === 0 || bare === META_KEY_SUFFIX) return;
    const val = entries[bare];
    try {
      if (val === null || val === undefined) await env.LOG_KV.delete(prefix + bare);
      else await env.LOG_KV.put(prefix + bare, String(val));
      written++;
    } catch (e) { failed++; }
  }));

  return json({ written, failed, total: keys.length });
}
