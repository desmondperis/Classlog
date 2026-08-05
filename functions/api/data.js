// /api/data — role-gated storage, namespaced per school branch.
// Teachers may read their department's logs but write only their own. HODs retain department write access.
// Absences and substitution responses are stored as independent entries to avoid whole-day overwrites.
function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
}
function isDataKey(k) { return typeof k === "string" && /^w:\d{4}-\d{2}-\d{2}:[a-z0-9]+$/.test(k); }
function isConfigKey(k) { return typeof k === "string" && /^cfg:(teachers|rooms|schedule|schedulex|depts|places|subjects|bell|classsubj|calendar)$/.test(k); }
function isSubSched(k) { return typeof k === "string" && /^sub:\d{4}-\d{2}-\d{2}$/.test(k); }
function isSubResp(k) { return typeof k === "string" && /^subresp:\d{4}-\d{2}-\d{2}$/.test(k); }
function isAbsent(k) { return typeof k === "string" && /^absent:\d{4}-\d{2}-\d{2}$/.test(k); }
function isSubDuty(k) { return k === "sub:duty"; }
function tidOfKey(k) { const m = /^w:\d{4}-\d{2}-\d{2}:([a-z0-9]+)$/.exec(k || ""); return m ? m[1] : null; }

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
async function identify(env, email, prefix) {
  prefix = prefix || "";
  email = (email || "").toLowerCase();
  let teachers = [];
  try { const raw = await env.LOG_KV.get(prefix + "cfg:teachers"); teachers = raw ? JSON.parse(raw) : []; if (!Array.isArray(teachers)) teachers = []; }
  catch (e) { teachers = []; }
  const admins = (env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const me = email ? teachers.find((t) => String((t && t.email) || "").toLowerCase() === email) : null;
  const envAdmin = admins.indexOf(email) >= 0;
  let role = roleOf(me);
  if (envAdmin) role = "admin";
  return { teacherId: me ? me.id : null, role, dept: me ? (me.dept || "") : "", teachers, approved: !!me || envAdmin };
}
function teacherById(idn, tid) { return idn.teachers.find((t) => t && t.id === tid) || null; }
function canRead(idn, tid) {
  if (!idn.approved) return false;
  if (idn.role === "admin" || idn.role === "leader") return true;
  if (tid === idn.teacherId) return true;
  if ((idn.role === "hod" || idn.role === "teacher") && idn.dept) {
    const target = teacherById(idn, tid);
    return !!target && target.dept === idn.dept;
  }
  return false;
}
function canWrite(idn, tid) {
  if (!idn.approved) return false;
  if (idn.role === "admin") return true;
  if (idn.role === "hod" && idn.dept) {
    const target = teacherById(idn, tid);
    return tid === idn.teacherId || (!!target && target.dept === idn.dept);
  }
  return tid === idn.teacherId;
}
function canSetDuty(idn) { return idn.approved && (idn.role === "admin" || idn.role === "leader"); }
function canManageAbsence(idn, tid) {
  if (!idn.approved) return false;
  if (tid === idn.teacherId) return true;
  if (idn.role === "admin" || idn.role === "leader") return true;
  if (idn.role === "hod" && idn.dept) {
    const target = teacherById(idn, tid);
    return !!target && target.dept === idn.dept;
  }
  return false;
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
function parseObject(raw) {
  try { const value = raw ? JSON.parse(raw) : {}; return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch (e) { return {}; }
}
function updatedAt(value) {
  const time = Date.parse(String((value && value.u) || ""));
  return Number.isFinite(time) ? time : 0;
}
function extraId(value) {
  if (value && value.id) return "id:" + value.id;
  return "legacy:" + [value && value.slot, value && value.c, value && value.rm, value && value.r, value && value.u].join("|");
}
function mergeWeekly(currentRaw, incomingRaw) {
  const current = parseObject(currentRaw);
  const incoming = parseObject(incomingRaw);
  const out = Object.assign({}, current);
  Object.keys(incoming).forEach((key) => {
    if (key === "_x") return;
    const next = incoming[key];
    const previous = current[key];
    if (!previous || updatedAt(next) >= updatedAt(previous)) out[key] = next;
  });

  const days = new Set(Object.keys((current && current._x) || {}).concat(Object.keys((incoming && incoming._x) || {})));
  if (days.size) out._x = {};
  days.forEach((day) => {
    const byId = new Map();
    ((current._x && current._x[day]) || []).forEach((entry) => byId.set(extraId(entry), entry));
    ((incoming._x && incoming._x[day]) || []).forEach((entry) => {
      const key = extraId(entry);
      const previous = byId.get(key);
      if (!previous || updatedAt(entry) >= updatedAt(previous)) byId.set(key, entry);
    });
    const list = Array.from(byId.values());
    if (list.length) out._x[day] = list;
  });
  if (out._x && !Object.keys(out._x).length) delete out._x;
  return JSON.stringify(out);
}
function mergeSubSchedule(currentRaw, incomingRaw) {
  const current = parseObject(currentRaw);
  const incoming = parseObject(incomingRaw);
  const rows = new Map();
  (Array.isArray(current.rows) ? current.rows : []).forEach((row) => {
    if (row && row.absent) rows.set(row.absent, row);
  });
  (Array.isArray(incoming.rows) ? incoming.rows : []).forEach((row) => {
    if (!row || !row.absent) return;
    const previous = rows.get(row.absent);
    if (!previous || updatedAt(row) >= updatedAt(previous)) rows.set(row.absent, row);
  });
  return JSON.stringify({
    dept: typeof incoming.dept === "string" ? incoming.dept : (current.dept || ""),
    rows: Array.from(rows.values())
  });
}

async function readAbsent(env, prefix, key, idn) {
  const out = parseObject(await env.LOG_KV.get(prefix + key));
  await Promise.all(idn.teachers.map(async (teacher) => {
    if (!teacher || !teacher.id) return;
    const raw = await env.LOG_KV.get(prefix + key + ":" + teacher.id);
    if (raw === null) return;
    const value = parseObject(raw);
    if (value._deleted) delete out[teacher.id];
    else out[teacher.id] = value;
  }));
  return JSON.stringify(out);
}
async function readSubResponses(env, prefix, key) {
  const out = parseObject(await env.LOG_KV.get(prefix + key));
  const date = key.slice("subresp:".length);
  const schedule = parseObject(await env.LOG_KV.get(prefix + "sub:" + date));
  const assignments = new Set();
  (Array.isArray(schedule.rows) ? schedule.rows : []).forEach((row) => {
    if (!row || row._deleted || !row.subs) return;
    Object.keys(row.subs).forEach((period) => {
      const tid = row.subs[period];
      if (tid && /^[1-8]$/.test(String(period))) assignments.add(tid + "|" + period);
    });
  });
  await Promise.all(Array.from(assignments).map(async (entryKey) => {
    const parts = entryKey.split("|");
    const raw = await env.LOG_KV.get(prefix + key + ":" + parts[0] + ":" + parts[1]);
    if (raw === null) return;
    const value = parseObject(raw);
    if (value._deleted) delete out[entryKey];
    else out[entryKey] = value;
  }));
  return JSON.stringify(out);
}
async function readLogical(env, prefix, key, idn) {
  if (isAbsent(key)) return readAbsent(env, prefix, key, idn);
  if (isSubResp(key)) return readSubResponses(env, prefix, key);
  return env.LOG_KV.get(prefix + key);
}

async function writeAbsentEntry(env, prefix, key, idn, entryKey, entryValue) {
  const tid = String(entryKey || "");
  if (!/^[a-z0-9]+$/.test(tid) || !canManageAbsence(idn, tid)) return json({ error: "forbidden" }, 403);
  let value;
  if (entryValue === null) value = { _deleted: true, u: new Date().toISOString() };
  else {
    if (!entryValue || typeof entryValue !== "object" || Array.isArray(entryValue)) return json({ error: "bad entry" }, 400);
    const reason = String(entryValue.reason || "").slice(0, 80);
    const note = String(entryValue.note || "").slice(0, 500);
    value = { reason, note, u: String(entryValue.u || new Date().toISOString()).slice(0, 40) };
  }
  await env.LOG_KV.put(prefix + key + ":" + tid, JSON.stringify(value));
  return json({ ok: true });
}
async function writeSubResponseEntry(env, prefix, key, idn, entryKey, entryValue) {
  const match = /^([a-z0-9]+)\|([1-8])$/.exec(String(entryKey || ""));
  if (!match || match[1] !== idn.teacherId) return json({ error: "forbidden" }, 403);
  let value;
  if (entryValue === null) value = { _deleted: true, u: new Date().toISOString() };
  else {
    if (!entryValue || typeof entryValue !== "object" || Array.isArray(entryValue)) return json({ error: "bad entry" }, 400);
    const status = entryValue.s === "accepted" || entryValue.s === "rejected" ? entryValue.s : "";
    if (!status) return json({ error: "bad status" }, 400);
    value = { s: status, r: String(entryValue.r || "").slice(0, 500), u: String(entryValue.u || new Date().toISOString()).slice(0, 40) };
  }
  await env.LOG_KV.put(prefix + key + ":" + match[1] + ":" + match[2], JSON.stringify(value));
  return json({ ok: true });
}

export async function onRequestGet(context) {
  const session = await requireSession(context);
  if (session.err) return session.err;
  const env = session.env;
  const prefix = branchPrefix((session.user || {}).branch);
  const idn = await identify(env, (session.user || {}).email, prefix);
  if (!idn.approved) return json({ error: "approval required" }, 403);
  const url = new URL(context.request.url);

  const keysParam = url.searchParams.get("keys");
  if (keysParam !== null) {
    const keys = keysParam ? keysParam.split(",").filter(Boolean).slice(0, 100) : [];
    const values = {};
    await Promise.all(keys.map(async (key) => {
      if (isConfigKey(key) || isSubSched(key) || isSubResp(key) || isAbsent(key) || isSubDuty(key)) {
        values[key] = await readLogical(env, prefix, key, idn);
        return;
      }
      if (isDataKey(key) && canRead(idn, tidOfKey(key))) values[key] = await env.LOG_KV.get(prefix + key);
    }));
    return json({ values });
  }

  const key = url.searchParams.get("key");
  if (isConfigKey(key) || isSubSched(key) || isSubResp(key) || isAbsent(key) || isSubDuty(key)) {
    return json({ value: await readLogical(env, prefix, key, idn) });
  }
  if (!isDataKey(key)) return json({ error: "bad key" }, 400);
  if (!canRead(idn, tidOfKey(key))) return json({ error: "forbidden" }, 403);
  return json({ value: await env.LOG_KV.get(prefix + key) });
}

export async function onRequestPost(context) {
  const session = await requireSession(context);
  if (session.err) return session.err;
  const env = session.env;
  const prefix = branchPrefix((session.user || {}).branch);
  const idn = await identify(env, (session.user || {}).email, prefix);
  if (!idn.approved) return json({ error: "approval required" }, 403);

  let body;
  try { body = await context.request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  const key = body && body.key;
  const dataK = isDataKey(key), cfgK = isConfigKey(key);
  const subSched = isSubSched(key), subResp = isSubResp(key), absentK = isAbsent(key), subDuty = isSubDuty(key);
  if (!dataK && !cfgK && !subSched && !subResp && !absentK && !subDuty) return json({ error: "bad key" }, 400);

  if (absentK) return writeAbsentEntry(env, prefix, key, idn, body.entryKey, body.entryValue);
  if (subResp) return writeSubResponseEntry(env, prefix, key, idn, body.entryKey, body.entryValue);

  const value = body && body.value;
  if (typeof value !== "string") return json({ error: "bad value" }, 400);
  if (value.length > (cfgK ? 2000000 : 200000)) return json({ error: "too large" }, 413);

  if (cfgK) {
    if (idn.role !== "admin") return json({ error: "admin only" }, 403);
  } else if (subDuty) {
    if (!canSetDuty(idn)) return json({ error: "forbidden" }, 403);
  } else if (subSched) {
    let dutyDept = "";
    try { dutyDept = (await env.LOG_KV.get(prefix + "sub:duty")) || ""; } catch (e) {}
    const allowed = idn.role === "admin" || idn.role === "leader" || (idn.dept && idn.dept === dutyDept);
    if (!allowed) return json({ error: "forbidden" }, 403);
  } else if (!canWrite(idn, tidOfKey(key))) {
    return json({ error: "forbidden" }, 403);
  }

  if (dataK) {
    const incoming = parseObject(value);
    if (!Object.keys(incoming).length && value.trim() !== "{}") return json({ error: "bad log json" }, 400);
    const current = await env.LOG_KV.get(prefix + key);
    await env.LOG_KV.put(prefix + key, mergeWeekly(current, value));
  } else if (subSched) {
    const incoming = parseObject(value);
    if (!Array.isArray(incoming.rows)) return json({ error: "bad substitution json" }, 400);
    const current = await env.LOG_KV.get(prefix + key);
    await env.LOG_KV.put(prefix + key, mergeSubSchedule(current, value));
  } else {
    await env.LOG_KV.put(prefix + key, value);
  }
  return json({ ok: true });
}
