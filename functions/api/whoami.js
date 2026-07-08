// GET /api/whoami — returns the signed-in user's email and whether they're an admin.
//   { email, name, admin, bootstrap }
// Admin is decided by (in order):
//   1. ADMIN_EMAILS env var (comma-separated) — authoritative when set.
//   2. otherwise, any teacher in cfg:teachers with admin:true and a matching email.
//   3. if NO admin is configured anywhere, bootstrap mode: any signed-in user is admin
//      (so the first person can set things up). Closes once ADMIN_EMAILS is set or a
//      teacher is marked admin.
function json(o, s) {
  return new Response(JSON.stringify(o), {
    status: s || 200,
    headers: { "content-type": "application/json" },
  });
}

export async function adminStatus(env, email) {
  email = (email || "").toLowerCase();
  if (!email) return { admin: false, bootstrap: false };
  const envList = (env.ADMIN_EMAILS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (envList.length) return { admin: envList.includes(email), bootstrap: false };

  let teachers = [];
  try {
    const t = await env.LOG_KV.get("cfg:teachers");
    if (t) teachers = JSON.parse(t);
  } catch (e) {}
  const admins = (Array.isArray(teachers) ? teachers : []).filter((t) => t && t.admin && t.email);
  if (admins.length) {
    return { admin: admins.some((t) => (t.email || "").toLowerCase() === email), bootstrap: false };
  }
  // No admin configured anywhere → bootstrap.
  return { admin: true, bootstrap: true };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.LOG_KV) return json({ error: "KV not bound (add a LOG_KV binding)" }, 500);
  const sid = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!sid) return json({ error: "unauthorized" }, 401);
  const sess = await env.LOG_KV.get("sess:" + sid);
  if (!sess) return json({ error: "unauthorized" }, 401);
  let user = {};
  try { user = JSON.parse(sess); } catch (e) {}
  const a = await adminStatus(env, user.email);
  return json({ email: user.email || "", name: user.name || "", admin: a.admin, bootstrap: a.bootstrap });
}
