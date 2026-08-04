// Class Log service worker — offline shell + install support.
// HTML is network-first (so deploys are picked up when online, with an offline fallback).
// /api/* is never cached (class logs, substitutions and holidays must be live).
// Static assets (icons, manifest, logo) are cache-first.
const CACHE = "classlog-v2";
const SHELL = [
  "/", "/index.html", "/manifest.json",
  "/logo.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"
];

function patchHtml(html) {
  if (!html || html.indexOf("id=\"askTopBtn\"") >= 0) return html;

  html = html.replace(/\n\s*<button class=\"tab\" id=\"tab-ask\"[\s\S]*?<\/button>/, "");

  html = html.replace(
    "<button class=\"install-btn\" id=\"installBtn\" hidden onclick=\"promptInstall()\" title=\"Install Class Log on this device\">Install app</button>",
    "<button class=\"install-btn\" id=\"installBtn\" hidden onclick=\"promptInstall()\" title=\"Install Class Log on this device\">Install app</button>\n      <button class=\"ask-top-btn\" id=\"askTopBtn\" hidden onclick=\"openAskAI()\" title=\"Ask AI\" aria-label=\"Ask AI\" aria-pressed=\"false\"><span class=\"ask-ico\" aria-hidden=\"true\">🔬</span><span class=\"ask-label\">Ask AI</span></button>"
  );

  html = html.replace(
    "</style>",
    `.ask-top-btn{margin-left:auto; appearance:none; border:1px solid var(--blue); background:var(--surface); color:var(--blue-d); border-radius:999px; padding:6px 13px; font-size:12.5px; font-weight:800; cursor:pointer; white-space:nowrap; flex:0 0 auto; display:inline-flex; align-items:center; gap:6px; box-shadow:var(--shs); transition:transform .12s var(--ease), box-shadow .2s var(--ease), background .18s var(--ease), color .18s var(--ease), border-color .18s var(--ease)}\n.ask-top-btn:hover{background:var(--blue-l); border-color:var(--blue); transform:translateY(-1px)}\n.ask-top-btn:active{transform:scale(.96)}\n.ask-top-btn[aria-pressed=\"true\"]{background:var(--blue); color:#fff; border-color:var(--blue-d)}\n.ask-ico{font-size:14px; line-height:1}\n.install-btn:not([hidden]) + .ask-top-btn{margin-left:0}\n.ask-top-btn:not([hidden]) ~ .user{margin-left:10px}\n@media (max-width:720px){ .ask-top-btn{padding:6px 9px} .ask-top-btn .ask-label{display:none} }\n</style>`
  );

  html = html.replace(
    "</script>\n<script>\n/* PWA",
    `</script>\n<script>\n/* Ask AI top-bar microscope button */\n(function(){\n  function updateAskButton(){\n    var b=document.getElementById(\"askTopBtn\");\n    if(!b) return;\n    var ok=false, pressed=false;\n    try{ ok=!!(state && state.user && typeof canSeeDashboard===\"function\" && canSeeDashboard()); pressed=!!(state && state.mode===\"ask\"); }catch(e){}\n    b.hidden=!ok;\n    b.setAttribute(\"aria-pressed\", pressed?\"true\":\"false\");\n  }\n  window.openAskAI=function(){ if(typeof setMode===\"function\") setMode(\"ask\"); };\n  try{\n    var oldShowApp=showApp;\n    showApp=function(){ var r=oldShowApp.apply(this,arguments); updateAskButton(); return r; };\n  }catch(e){}\n  try{\n    var oldRenderUser=renderUser;\n    renderUser=function(){ var r=oldRenderUser.apply(this,arguments); updateAskButton(); return r; };\n  }catch(e){}\n  try{\n    var oldShowGate=showGate;\n    showGate=function(){ var r=oldShowGate.apply(this,arguments); updateAskButton(); return r; };\n  }catch(e){}\n  try{\n    var oldSetMode=setMode;\n    setMode=async function(){ var r=await oldSetMode.apply(this,arguments); updateAskButton(); return r; };\n  }catch(e){}\n  document.addEventListener(\"DOMContentLoaded\", updateAskButton);\n  setTimeout(updateAskButton,300);\n  setTimeout(updateAskButton,1200);\n})();\n</script>\n<script>\n/* PWA`
  );

  return html;
}

function htmlResponse(original, sourceResponse) {
  const headers = new Headers(sourceResponse ? sourceResponse.headers : {});
  headers.delete("content-length");
  if (!headers.get("content-type")) headers.set("content-type", "text/html; charset=utf-8");
  return new Response(patchHtml(original), {
    status: sourceResponse ? sourceResponse.status : 200,
    statusText: sourceResponse ? sourceResponse.statusText : "OK",
    headers
  });
}

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // never intercept POST etc.
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return; // let cross-origin (fonts, APIs elsewhere) pass through
  if (url.pathname.startsWith("/api/")) return;     // always hit the network for data

  if (req.mode === "navigate") {
    // network-first for the app shell, with a small UI upgrade applied on the way through
    e.respondWith(
      fetch(req)
        .then((r) => r.text().then((txt) => {
          const patched = htmlResponse(txt, r);
          const cp = patched.clone();
          caches.open(CACHE).then((c) => c.put("/index.html", cp));
          return patched;
        }))
        .catch(() => caches.match("/index.html").then((r) => r || caches.match("/")))
    );
    return;
  }

  // cache-first for static assets
  e.respondWith(
    caches.match(req).then((cached) =>
      cached || fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic") { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); }
        return res;
      }).catch(() => cached)
    )
  );
});
