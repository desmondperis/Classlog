// POST /api/logout  (Authorization: Bearer <sid>) → invalidates the session
export async function onRequestPost(context) {
  const { request, env } = context;
  const sid = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (sid && env.LOG_KV) {
    try { await env.LOG_KV.delete("sess:" + sid); } catch (e) {}
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
  });
}
