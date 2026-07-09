// GET /api/whoami — returns the signed-in user's identity + role.
//   { email, name, role, teacherId, dept, admin, bootstrap }
// role ∈ teacher | hod | leader | admin. Resolution order:
//   - bootstrap (no admin configured anywhere) → admin, bootstrap:true
//   - email listed in ADMIN_EMAILS env → admin
//   - else the role on their cfg:teachers record (admin:true legacy → admin), default teacher
function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
}
const ROLES = ["teacher", "hod", "leader", "admin"];
function roleOf(t) {
  if (!t) return "teacher";
  if (t.role && ROLES.indexOf(t.role) >= 0) return t.role;
  if (t.admin === true) return "admin";
  return "teacher";
}
async function loadTeachers(env) {
  try { const t = await env.LOG_KV.get("cfg:teachers"); const a = t ? JSON.parse(t) : []; return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
export async function identify(env, email) {
  email = (email || "").toLowerCase();
  const teachers = await loadTeachers(env);
  const OWNER = ["desmondperis@gmail.com"];
  const envList = (env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).concat(OWNER);
  const configuredAdmin = envList.length > 0 || teachers.some((t) => t && t.email && (t.role === "admin" || t.admin === true));
  const me = email ? teachers.find((t) => (t.email || "").toLowerCase() === email) : null;
  let role = roleOf(me);
  if (envList.indexOf(email) >= 0) role = "admin";
  let bootstrap = false;
  if (!configuredAdmin) { role = "admin"; bootstrap = true; }
  return { teacherId: me ? me.id : null, role, dept: me ? (me.dept || "") : "", bootstrap, teachers };
}
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.LOG_KV) return json({ error: "KV not bound (add a LOG_KV binding)" }, 500);
  const sid = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!sid) return json({ error: "unauthorized" }, 401);
  const sess = await env.LOG_KV.get("sess:" + sid);
  if (!sess) return json({ error: "unauthorized" }, 401);
  let user = {}; try { user = JSON.parse(sess); } catch (e) {}
  const idn = await identify(env, user.email);
  return json({ email: user.email || "", name: user.name || "", role: idn.role, teacherId: idn.teacherId, dept: idn.dept, admin: idn.role === "admin", bootstrap: idn.bootstrap });
}
