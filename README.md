# Value Education — Class Log (Cloudflare Pages + GitHub)

A shared class-coverage log for Mount Carmel School. Teachers sign in with Google
and record the topic covered per class; an admin sees coverage by teacher / class /
week. Shared data lives in Cloudflare KV; Google sign-in is verified server-side.

There is **no build step** — Cloudflare serves the static files and compiles the
`functions/` folder automatically.

## Repository layout (put these at the repo root)
```
index.html                the app
logo.png                  school logo (also the favicon)   ← binary: use "Upload files"
functions/api/config.js   GET  /api/config   → returns the Google Client ID
functions/api/login.js    POST /api/login    → verifies Google token, creates a session
functions/api/logout.js   POST /api/logout   → ends a session
functions/api/data.js     GET/POST /api/data → read/write the shared log (session required)
README.md                 this file
```

## 1. Create the GitHub repo
- New repo, e.g. `mount-carmel-class-log`.
- Add the **text** files with **Add file → Create new file**, typing the full path as the
  name — e.g. `functions/api/config.js` — GitHub creates the folders for you. Paste the
  contents and commit.
- Add **logo.png** with **Add file → Upload files** (it's binary, so it can't be pasted).

## 2. Connect the repo to Cloudflare Pages
- Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
- Pick the repo. Build settings:
  - **Framework preset:** None
  - **Build command:** *(leave empty)*
  - **Build output directory:** `/`  (the repo root)
- Save and Deploy. You get a URL like `https://mount-carmel-class-log.pages.dev`.

## 3. Create a KV namespace and bind it
- **Storage & Databases → KV → Create namespace**, name it e.g. `class-log`.
- Pages project → **Settings → Bindings** (Functions) → **Add → KV namespace**:
  - Variable name: **`LOG_KV`**  (must be exactly this)
  - Namespace: the one you just made.
- Add it for **Production** (and Preview if you use preview branches).

## 4. Set the Google Client ID (environment variable)
- Pages project → **Settings → Variables and Secrets** → add:
  - **`GOOGLE_CLIENT_ID`** = your OAuth **Web** client ID (`…apps.googleusercontent.com`)
- Optional, to restrict who can sign in:
  - **`ALLOWED_DOMAIN`** = your Google Workspace domain (only that domain may sign in).
  - **`ALLOWED_EMAILS`** = comma-separated allow-list.

## 5. Google Cloud Console (OAuth origins)
- APIs & Services → **Credentials** → your **Web** OAuth client →
  **Authorised JavaScript origins** → add your Pages URL(s):
  - `https://mount-carmel-class-log.pages.dev`
  - any custom domain you attach
- No redirect URI and no client secret are needed for this browser sign-in.
- While the OAuth app is in **Testing**, add each teacher's email under
  **Audience → Test users** (or set the app to *In production*).

## 6. Redeploy so Functions pick up the binding
After adding the KV binding and the variable, trigger a fresh build:
**Deployments → Retry**, or just push any commit. Until KV is bound, sign-in returns a
"KV not bound" error by design.

## From now on
Every edit is just a **commit to GitHub** — Pages auto-builds and redeploys. No zips.

## Local testing (optional)
```
npm i -g wrangler
wrangler pages dev . --kv LOG_KV --binding GOOGLE_CLIENT_ID=your-id.apps.googleusercontent.com
```

## How data is stored
- Shared log: one KV key per teacher per week — `w:YYYY-MM-DD:<teacherId>` — holding a
  small JSON object of `{ "<Day>|<slug>": { t: topic, r: remark, u: updatedISO } }`.
- Sessions: `sess:<random>` in the same namespace, auto-expiring after 30 days.
- Per-device preferences (last teacher, cached profile) stay in the browser's localStorage.

## Notes
- `/api/data` refuses any key that isn't a `w:` log key, so a session can only touch
  class-log data — never sessions or anything else.
- To reset a teacher's week, delete its KV key in the dashboard.
- Teacher list, class→room map and timetables are baked into `index.html` — edit the
  `ROOMS`, `TEACHERS` and `RAW` objects there if they change.
