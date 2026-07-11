// POST /api/login  body: { credential: <Google ID token>, branch: <school branch name> }
// Verifies the token with Google, then mints a 30-day session in KV (with the chosen branch).
function json(o, s) {
  return new Response(JSON.stringify(o), {
    status: s || 200,
    headers: { "content-type": "application/json" },
  });
}

// School branches (must match whoami.js / data.js / the client)
const BRANCHES = ["Anand Niketan", "Junior-Anand Niketan", "Gurugram", "ILC", "Dwarka", "Junior-Dwarka", "Junior Wing-Dwarka"];
const DEFAULT_BRANCH = "Anand Niketan";
function normBranch(b) { b = (b || "").trim(); return BRANCHES.indexOf(b) >= 0 ? b : DEFAULT_BRANCH; }

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.LOG_KV) return json({ error: "KV not bound (add a LOG_KV binding)" }, 500);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  const cred = body && body.credential;
  if (!cred) return json({ error: "missing credential" }, 400);
  const branch = normBranch(body && body.branch);

  // Verify the ID token with Google (checks signature + expiry).
  let info;
  try {
    const r = await fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(cred)
    );
    if (!r.ok) return json({ error: "invalid token" }, 401);
    info = await r.json();
  } catch (e) {
    return json({ error: "verification failed" }, 502);
  }

  // The token must have been issued for THIS app.
  if (env.GOOGLE_CLIENT_ID && info.aud !== env.GOOGLE_CLIENT_ID) {
    return json({ error: "aud mismatch" }, 401);
  }
  // Optional lock-downs (set as env vars if you want them):
  if (env.ALLOWED_DOMAIN && info.hd !== env.ALLOWED_DOMAIN) {
    return json({ error: "domain not allowed" }, 403);
  }
  if (env.ALLOWED_EMAILS) {
    const allow = env.ALLOWED_EMAILS.split(",").map((s) => s.trim().toLowerCase());
    if (!allow.includes((info.email || "").toLowerCase())) {
      return json({ error: "email not allowed" }, 403);
    }
  }

  const user = {
    name: info.name || info.email || "Signed in",
    email: info.email || "",
    picture: info.picture || "",
    sub: info.sub || "",
    branch: branch,
  };
  const sid = crypto.randomUUID();
  await env.LOG_KV.put("sess:" + sid, JSON.stringify(user), {
    expirationTtl: 60 * 60 * 24 * 30, // 30 days
  });
  return json({ sid, user });
}
