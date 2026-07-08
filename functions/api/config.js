// GET /api/config  → returns the public Google Client ID (safe to expose)
export async function onRequestGet(context) {
  return new Response(
    JSON.stringify({ clientId: context.env.GOOGLE_CLIENT_ID || "" }),
    { headers: { "content-type": "application/json" } }
  );
}
