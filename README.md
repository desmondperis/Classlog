# Class Log (Mount Carmel School)

A shared class-coverage log. Teachers sign in with Google and record the topic
covered per class (plus out-of-timetable entries); an admin reviews coverage by
week, date, department, teacher and classroom.

## Architecture — portable, not tied to one host
The app is two independent halves:

1. **Frontend** — `index.html` plus the PWA assets. It calls the JSON endpoints under `/api/`.
2. **Backend** — Cloudflare Pages Functions for configuration, login, identity, data,
   logout, and Ask AI, backed by a KV namespace. The API can be ported to another
   platform, but a separately hosted frontend also requires CORS configuration.
   A replacement backend must implement the documented API contract and persistent storage
   (for example Node/Express, Netlify, Vercel, Deno Deploy, Firebase, Supabase, or a VPS).

Frontend and backend can live together (simplest) or apart. In `index.html`:
```
const API_BASE = "";   // "" = same site serves the API (default)
                       // or "https://your-backend.example.com" if hosted elsewhere
```

## The API contract (implement these to run on any host)
All JSON. Auth is a bearer session token the client stores after login.

- `GET /api/config`
  → `{ "clientId": "<google-oauth-web-client-id>" }`  (public; used to init sign-in)

- `POST /api/login`  body `{ "credential": "<google-id-token>" }`
  Verify the Google ID token (check `aud` == your client id; optionally restrict by
  domain/email). Create a session, store it, and return
  → `{ "sid": "<opaque-session-token>", "user": { "name","email","picture","sub" } }`

- `GET /api/whoami` header `Authorization: Bearer <sid>`
  → the approved user's branch, role, department, and teacher id
- `POST /api/logout`  header `Authorization: Bearer <sid>`  → `{ "ok": true }`
- `POST /api/ask` header `Authorization: Bearer <sid>`
  → answers questions for approved staff using recent permitted class-log context

- `GET  /api/data?key=<k>`                  header `Authorization: Bearer <sid>` → `{ "value": <string|null> }`
- `GET  /api/data?keys=<k1,k2,...>`         header `Authorization: Bearer <sid>` → `{ "values": { "<k>": <string|null> } }`
- `POST /api/data`  body `{ "key","value" }` header `Authorization: Bearer <sid>` → `{ "ok": true }`

Class-log keys are shaped `w:YYYY-MM-DD:<teacherId>`. Configuration, substitution,
response, duty, and absence keys are also supported. Unknown Google accounts may
authenticate but receive no application data until an administrator adds their email
to the selected branch. Teachers can read their department and write their own log;
HOD, leader, and admin permissions are enforced by the backend.

Data model: one key per teacher per week → a JSON object
`{ "<Day>|<slug>": { t:topic, r:remark, u:updatedISO }, "_x": { "<Day>":[ {c,t,r,u} ] } }`
where `_x` holds the out-of-timetable entries.

## Deploying on Cloudflare Pages (the reference backend)
1. **GitHub → Cloudflare Pages**: Workers & Pages → Create → Pages → Connect to Git,
   pick the repo. Framework preset **None**, build command **empty**, output dir **/**.
2. **KV**: create a namespace, then bind it to the project as **`LOG_KV`**
   (Settings → Bindings). This repo also binds it via `wrangler.toml`.
3. **Env var** `GOOGLE_CLIENT_ID` = your OAuth **Web** client id (this repo sets it in
   `wrangler.toml` under `[vars]`). Optional: `ALLOWED_DOMAIN`, `ALLOWED_EMAILS`.
4. **Google Cloud** → Credentials → your Web client → Authorised JavaScript origins →
   add your site URL (e.g. `https://classlog.pages.dev`). While the OAuth app is in
   Testing, add each user under Audience → Test users.
5. Commit → Pages auto-deploys. `wrangler.toml` is Cloudflare-specific — other hosts
   ignore or remove it.

## Moving to another host later
- Keep `index.html` + `logo.png` as-is (set `API_BASE` if the backend is on another origin).
- Re-implement the four endpoints above on the new platform, backed by its key-value
  store (or a table with `key`/`value` columns).
- Keep using the same Google OAuth client; just add the new site URL to Authorised
  JavaScript origins.

## School diary dates
The app intentionally does not import a generic public-holiday feed. An administrator
can load the built-in 2026–27 school diary for the selected branch, then edit or remove
dates in the Admin calendar. Only entries marked “No classes” close the timetable.

## Adding staff and departments
Use the Admin tab to add staff, assign their email, department, and role, and maintain
timetables. An account remains approval-pending until its Google email matches that
branch's staff configuration.

## Note on previews
Because the app needs a backend, it can't fully run in a no-backend preview (e.g. an
in-chat artifact preview) — it will show the sign-in screen but can't sign in there.
Use your deployed URL to actually use it.

<!-- Deploy trigger: 2026-08-05 01:50 IST -->
