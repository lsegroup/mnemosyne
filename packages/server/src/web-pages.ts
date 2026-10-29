/** HTML for the web portal. Dark theme, no external assets, no inline handlers. */

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const CSS = `
:root{color-scheme:dark;--bg:#0b0d12;--panel:#12151c;--line:#232834;--text:#e6e9ef;--muted:#8b93a7;--accent:#6c8cff;--accent-h:#8aa3ff;--danger:#ff6b6b;--ok:#4ade80}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 16px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.btn:hover{border-color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#0b0d12}
.btn.primary:hover{background:var(--accent-h)}
.btn.danger:hover{border-color:var(--danger);color:var(--danger)}
.btn.small{padding:5px 10px;font-size:13px}
.notice{padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:#161a23;color:var(--muted);font-size:14px}
.notice.error{border-color:#5a2a2a;color:#ffb4b4;background:#1d1214}
`;

function shell(title: string, body: string, extraCss = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>${CSS}${extraCss}</style></head><body>${body}</body></html>`;
}

export interface LoginView {
  basePath: string;
  /** Portal is switched on (secret and public URL set). */
  configured: boolean;
  /** Render the separate ADMIN sign-in (local admin account + GitLab admins) instead of the public page. */
  admin?: boolean;
  /** Local admin account sign-in is available (admin page only). */
  local: boolean;
  /** GitLab SSO is configured. */
  sso: boolean;
  /** Error key from `?error=`. */
  error?: string;
  /** Already signed in. */
  user?: { name: string; username: string };
}

const ERRORS: Record<string, string> = {
  state: 'The sign-in attempt expired or was tampered with. Please try again.',
  denied: 'GitLab sign-in was cancelled or refused.',
  gitlab: 'GitLab could not be reached or rejected the sign-in. Please try again.',
  local: 'Wrong user name or password.',
  throttled: 'Too many attempts. Please wait a minute and try again.',
  nosso: 'GitLab sign-in is not set up yet.',
  noadmin: 'Only GitLab administrators may open the admin area.',
};

export function loginPage(v: LoginView): string {
  const base = esc(v.basePath);
  let action: string;
  if (v.user) {
    action = `<p class="who">Signed in as <strong>${esc(v.user.name)}</strong> <span class="muted">@${esc(v.user.username)}</span></p>
      <form method="post" action="${base}/auth/logout"><button class="btn" type="submit">Sign out</button></form>`;
  } else if (v.configured && v.admin && (v.sso || v.local)) {
    const sso = v.sso ? `<a class="btn${v.local ? '' : ' primary'}" href="${base}/admin/auth/login">Sign in with GitLab</a>` : '';
    const local = v.local
      ? `<form class="local" method="post" action="${base}/admin/auth/local">
        <input name="username" autocomplete="username" placeholder="Admin user name" required maxlength="100">
        <input name="password" type="password" autocomplete="current-password" placeholder="Password" required maxlength="200">
        <button class="btn primary" type="submit">Sign in</button></form>`
      : '';
    action = v.sso && v.local ? `${local}<div class="or">or GitLab admin</div>${sso}` : local + sso;
  } else if (v.configured && !v.admin && v.sso) {
    action = `<a class="btn primary" href="${base}/auth/login">Sign in with GitLab</a>`;
  } else {
    action = `<div class="notice">Sign-in is not configured on this server yet.</div>`;
  }
  const err = v.error && ERRORS[v.error] ? `<div class="notice error">${esc(ERRORS[v.error]!)}</div>` : '';
  return shell(
    'Mnemosyne',
    `<main class="stage">
  <div class="glow" aria-hidden="true"><i class="streak l"></i><i class="streak r"></i></div>
  ${BACKDROP_SVG}
  <svg class="grain" aria-hidden="true"><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#grain)"/></svg>
  <div class="vignette" aria-hidden="true"></div>
  <div class="stack">
    <img class="logo" src="${base}/assets/logo.webp" alt="" width="196" height="189">
    <section class="card">
      <h1>Mnemosyne</h1>
      <p class="tag">${v.admin ? 'Administration' : 'Self-hosted AI team memory'}</p>
      ${err}
      ${action}
    </section>
    <footer>${v.admin ? `<a href="${base}/">Back to sign-in</a>` : `MCP clients connect to <code>${base}/mcp</code>`}</footer>
  </div>
</main>`,
    // Palette sampled from the approved mockup: near-black base, violet glow left, teal glow right.
    `:root{--bg:#0d0e13;--panel:#161922;--line:#262a36;--text:#e6e9ef;--muted:#8b90a0;--accent:#7a66e0;--accent-h:#9482ee}
html,body{background:var(--bg)}
.stage{position:relative;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;overflow:hidden}
.glow{position:absolute;inset:0;pointer-events:none;
background:
radial-gradient(ellipse 36% 34% at 30% 44%,rgba(120,58,182,.66) 0%,rgba(96,46,150,.30) 42%,transparent 100%),
radial-gradient(ellipse 36% 34% at 70% 44%,rgba(30,152,164,.46) 0%,rgba(24,104,118,.20) 42%,transparent 100%),
radial-gradient(ellipse 50% 46% at 38% 30%,rgba(76,44,130,.30) 0%,transparent 100%),
radial-gradient(ellipse 46% 40% at 64% 32%,rgba(26,90,106,.22) 0%,transparent 100%)}
.streak{position:absolute;height:3px;border-radius:3px;filter:blur(.8px)}
.streak.l{left:8%;width:40%;top:47%;transform:rotate(-4deg);transform-origin:right center;
background:linear-gradient(90deg,transparent,rgba(160,84,222,.95) 70%,rgba(190,130,240,.9));box-shadow:0 0 26px 6px rgba(122,63,176,.5)}
.streak.r{right:8%;width:40%;top:46%;transform:rotate(2.5deg);transform-origin:left center;
background:linear-gradient(270deg,transparent,rgba(44,178,186,.92) 70%,rgba(120,220,226,.85));box-shadow:0 0 26px 6px rgba(30,150,162,.42)}
.stack{position:relative;z-index:1;width:100%;max-width:340px;display:flex;flex-direction:column;align-items:center}
.logo{display:block;width:196px;height:auto;margin-bottom:-62px;position:relative;z-index:2;filter:drop-shadow(0 10px 30px rgba(90,60,200,.40))}
.card{width:100%;display:flex;flex-direction:column;gap:14px;align-items:stretch;text-align:center;
padding:84px 28px 28px;border:1px solid var(--line);border-radius:14px;background:var(--panel);box-shadow:0 18px 48px rgba(0,0,0,.42)}
h1{margin:0;font:600 38px/1.1 "Palatino Linotype","Book Antiqua",Palatino,Georgia,"Times New Roman",serif;letter-spacing:.4px;color:#8473de}
.tag{margin:0 0 6px;color:var(--muted);font-size:13px}
.notice{background:#12141b;font-size:12.5px;color:#a3a8b8}
.who{margin:0}.muted{color:var(--muted)}
form.local{display:flex;flex-direction:column;gap:10px}
form.local input{padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:#0f1117;color:var(--text);font:inherit}
form.local input:focus{outline:none;border-color:var(--accent)}
.or{color:var(--muted);font-size:12px;letter-spacing:.4px;text-transform:uppercase}
form{margin:0}form .btn{width:100%}.card .btn{width:100%}
.btn.primary{color:#fff}
footer{margin-top:24px;color:var(--muted);font-size:12px}
.tablewrap{overflow-x:auto}
table.audit{font-size:13px;min-width:980px}table.audit td{vertical-align:top}
table.audit td.t{white-space:nowrap;color:var(--muted)}
.ev{display:inline-block;padding:1px 9px;border-radius:99px;font-size:12px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.ev.login,.ev.create,.ev.fetch{color:var(--teal);border-color:#1d5f64}
.ev.update{color:#b3a3ff;border-color:#4b3f94}
.ev.login_failed,.ev.denied,.ev.delete,.ev.fetch_failed{color:#ff8b8b;border-color:#6a2e2e}
pre.chg{margin:0;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
pre.chg .p{color:#6ee7a0}pre.chg .m{color:#ff9a9a}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:transparent;border:0;padding:0 2px;color:#a3a8b8}
.stack::before{content:"";position:absolute;z-index:-1;left:50%;top:-110px;width:640px;height:420px;transform:translateX(-50%);
background:radial-gradient(ellipse closest-side at 50% 50%,rgba(122,102,224,.34),rgba(40,150,170,.14) 50%,transparent 100%);pointer-events:none}
.net{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;
-webkit-mask-image:radial-gradient(ellipse 75% 75% at 50% 50%,#000 35%,transparent 100%);mask-image:radial-gradient(ellipse 75% 75% at 50% 50%,#000 35%,transparent 100%)}
.net line{stroke-width:1;stroke-linecap:round}
.net .node{animation:twinkle 5s ease-in-out infinite}
.net .node.b{animation-duration:7.5s}.net .node.c{animation-duration:3.8s}
.net .dust{animation:rise 34s linear infinite}
.net .dust.b{animation-duration:48s}.net .dust.c{animation-duration:26s}
.grain{position:absolute;inset:0;width:100%;height:100%;opacity:.07;mix-blend-mode:overlay;pointer-events:none}
.vignette{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 85% 75% at 50% 46%,transparent 55%,rgba(4,5,9,.72) 100%)}
.glow{animation:breathe 11s ease-in-out infinite}
.streak.l,.streak.r{animation:shimmer 6s ease-in-out infinite}.streak.r{animation-delay:-3s}
@keyframes twinkle{0%,100%{opacity:.35}50%{opacity:1}}
@keyframes rise{from{transform:translateY(0)}to{transform:translateY(-120px)}}
@keyframes breathe{0%,100%{opacity:.82}50%{opacity:1}}
@keyframes shimmer{0%,100%{opacity:.7}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.glow,.streak,.net .node,.net .dust{animation:none!important}}`,
  );
}

/**
 * Faint "memory network" behind the login card: nodes joined to their nearest
 * neighbours (violet on the left half, teal on the right) plus slow-rising dust.
 * Generated once with a fixed seed so the picture is identical on every load.
 */
const BACKDROP_SVG = (() => {
  let seed = 0x4d6e656d;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const W = 1600;
  const H = 900;
  const colour = (x: number) => (x < W / 2 ? '#8f73ea' : '#3cc4cc');
  const behindCard = (x: number, y: number) => ((x - 800) / 300) ** 2 + ((y - 470) / 250) ** 2 < 1;

  const nodes: Array<{ x: number; y: number; r: number }> = [];
  while (nodes.length < 62) {
    const x = rnd() * W;
    const y = rnd() * H;
    if (!behindCard(x, y)) nodes.push({ x, y, r: 1.6 + rnd() * 2.2 });
  }
  const seen = new Set<string>();
  let lines = '';
  nodes.forEach((a, i) => {
    nodes
      .map((b, j) => ({ j, d: Math.hypot(a.x - b.x, a.y - b.y) }))
      .filter((n) => n.j !== i && n.d < 270)
      .sort((p, q) => p.d - q.d)
      .slice(0, 2)
      .forEach(({ j }) => {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (seen.has(key)) return;
        seen.add(key);
        const b = nodes[j]!;
        lines += `<line x1="${a.x.toFixed(0)}" y1="${a.y.toFixed(0)}" x2="${b.x.toFixed(0)}" y2="${b.y.toFixed(0)}" stroke="${colour((a.x + b.x) / 2)}" stroke-opacity=".22"/>`;
      });
  });
  const dots = nodes
    .map((n, i) => {
      const cls = ['node', 'node b', 'node c'][i % 3];
      return `<circle class="${cls}" cx="${n.x.toFixed(0)}" cy="${n.y.toFixed(0)}" r="${n.r.toFixed(1)}" fill="${colour(n.x)}" style="animation-delay:-${(rnd() * 8).toFixed(1)}s"/>`;
    })
    .join('');
  let dust = '';
  for (let i = 0; i < 38; i++) {
    const x = rnd() * W;
    const cls = ['dust', 'dust b', 'dust c'][i % 3];
    dust += `<circle class="${cls}" cx="${x.toFixed(0)}" cy="${(rnd() * H).toFixed(0)}" r="${(0.7 + rnd() * 1.1).toFixed(1)}" fill="${colour(x)}" fill-opacity="${(0.25 + rnd() * 0.35).toFixed(2)}" style="animation-delay:-${(rnd() * 30).toFixed(1)}s"/>`;
  }
  return `<svg class="net" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${lines}${dots}${dust}</svg>`;
})();

export interface AdminView {
  basePath: string;
  nonce: string;
  user: { name: string; username: string };
  /** Callback URLs to register in GitLab (Admin → Applications), one per line. */
  redirectUris: string[];
}

// Same palette as the login screen: near-black base, violet main titles, turquoise second-level titles.
const ADMIN_CSS = `
:root{--bg:#0d0e13;--panel:#161922;--panel2:#12141b;--line:#262a36;--text:#e6e9ef;--muted:#8b90a0;--accent:#7a66e0;--accent-h:#9482ee;--title:#8473de;--teal:#3cc4cc}
html,body{background:var(--bg)}
body{background:radial-gradient(ellipse 50% 40% at 12% 0%,rgba(120,58,182,.20),transparent 100%),radial-gradient(ellipse 45% 40% at 95% 0%,rgba(30,152,164,.14),transparent 100%),var(--bg);background-attachment:fixed}
.btn.primary{color:#fff}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 24px;border-bottom:1px solid var(--line);background:rgba(22,25,34,.85)}
.brand{font:600 24px/1 "Palatino Linotype","Book Antiqua",Palatino,Georgia,"Times New Roman",serif;letter-spacing:.4px;color:var(--title)}
.brand .muted{font:500 14px/1 system-ui,sans-serif;letter-spacing:0;color:var(--teal)}
.top .right{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:14px}.top form{margin:0}
.layout{display:grid;grid-template-columns:210px minmax(0,1fr);gap:28px;max-width:1180px;margin:0 auto;padding:28px 24px 60px}
.side{display:flex;flex-direction:column;gap:6px;position:sticky;top:20px;align-self:start}
.side a{display:block;padding:10px 14px;border-radius:9px;border:1px solid transparent;color:var(--muted);text-decoration:none;font-weight:600}
.side a:hover{color:var(--text);background:var(--panel)}
.side a.active{color:var(--text);background:var(--panel);border-color:var(--line);box-shadow:inset 3px 0 0 var(--accent)}
.tab{display:flex;flex-direction:column;gap:18px}
[hidden]{display:none!important}
h2{margin:0;font:600 32px/1.1 "Palatino Linotype","Book Antiqua",Palatino,Georgia,"Times New Roman",serif;letter-spacing:.3px;color:var(--title)}
h3{margin:0 0 4px;font-size:17px;font-weight:600;color:var(--teal);display:flex;align-items:center;gap:10px}
.num{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;border:1px solid var(--teal);font-size:13px;color:var(--teal)}
.sub{margin:0 0 14px;color:var(--muted);font-size:14px}
.lead{margin:-8px 0 4px;color:var(--muted);font-size:14.5px}
.step{border:1px solid var(--line);border-radius:14px;background:var(--panel);padding:22px;box-shadow:0 14px 40px rgba(0,0,0,.30)}
.step.off{opacity:.55}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
td.actions{text-align:right;white-space:nowrap}td.actions .btn{margin-left:6px}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line);color:var(--muted)}
.badge.ok{color:#4ade80;border-color:#1f5a38}
form.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
form.grid .full{grid-column:1/-1}
label{display:flex;flex-direction:column;gap:5px;font-size:13px;color:var(--muted)}
input,select{padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:#0f1117;color:var(--text);font:inherit}
input:focus,select:focus{outline:none;border-color:var(--accent)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.msg{min-height:22px;font-size:14px}.ok{color:#4ade80}.err{color:#ff8b8b}
.roles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.roles .hint{font-size:12px;color:var(--muted)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#a3a8b8}
@media(max-width:860px){.layout{grid-template-columns:1fr}.side{flex-direction:row;position:static}.roles,form.grid{grid-template-columns:1fr}}`;

/** Admin shell; the interactive part lives in {@link ADMIN_JS}, run under the CSP nonce. */
export function adminPage(v: AdminView): string {
  const base = esc(v.basePath);
  return shell(
    'Mnemosyne admin',
    `<header class="top">
  <span class="brand">Mnemosyne <span class="muted">admin</span></span>
  <div class="right"><span>${esc(v.user.name)} <span>@${esc(v.user.username)}</span></span>
  <form method="post" action="${base}/admin/auth/logout"><button class="btn small" type="submit">Sign out</button></form></div>
</header>
<div class="layout">
  <nav class="side" aria-label="Admin sections"><a href="#llm" data-tab="llm" class="active">LLM</a><a href="#sso" data-tab="sso">SSO</a><a href="#audit" data-tab="audit">Audit</a></nav>
  <main>
    <section id="tab-llm" class="tab">
      <h2>LLM</h2>
      <p class="lead">Connect a provider with its API key, fetch the models that key can really use, then choose which model does which job.</p>

      <div class="step" id="step1">
        <h3><span class="num">1</span> Connect a provider</h3>
        <p class="sub">The API key is stored encrypted on the server and is never shown again after saving.</p>
        <form id="form" class="grid" autocomplete="off">
          <label>Provider
            <select id="preset">
              <option value="">Custom</option>
              <option value="meta-openai">Meta Model API (OpenAI-compatible)</option>
              <option value="meta-anthropic">Meta Model API (Anthropic Messages)</option>
              <option value="openai">OpenAI</option>
              <option value="xai">xAI</option>
            </select></label>
          <label>Name<input id="label" required maxlength="80" placeholder="Meta Model API"></label>
          <label>API format
            <select id="kind"><option value="openai-compatible">OpenAI-compatible</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
          <label>Base URL<input id="baseUrl" required maxlength="300" placeholder="https://api.meta.ai/v1"></label>
          <label class="full">API key<input id="apiKey" type="password" maxlength="500" autocomplete="new-password"></label>
          <div class="row full"><button class="btn primary" type="submit" id="save">Save &amp; fetch models</button>
            <button class="btn" type="button" id="cancel" hidden>Cancel edit</button><span id="msg" class="msg"></span></div>
        </form>
      </div>

      <div class="step" id="step2">
        <h3><span class="num">2</span> Models your keys can use</h3>
        <p class="sub">Asked from each provider with its own key — only models it really offers are listed. This reads the model list only; it makes no model calls and costs nothing.</p>
        <table><thead><tr><th>Name</th><th>Endpoint</th><th>Key</th><th>Models</th><th></th></tr></thead>
          <tbody id="rows"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody></table>
        <p class="msg" id="fetchMsg"></p>
      </div>

      <div class="step off" id="step3">
        <h3><span class="num">3</span> Choose a model for each job</h3>
        <p class="sub">One model each for text, images and PDF handbooks, picked from the lists above.</p>
        <form id="assign">
          <div class="roles">
            <label>Text<select id="role-text"></select><span class="hint">Documentation, summaries, answers</span></label>
            <label>Images<select id="role-image"></select><span class="hint">Diagrams and illustrations</span></label>
            <label>PDF<select id="role-pdf"></select><span class="hint">PDF handbooks</span></label>
          </div>
          <div class="row" style="margin-top:16px"><button class="btn primary" type="submit" id="saveRoles">Save choices</button><span id="assignMsg" class="msg"></span></div>
        </form>
      </div>
    </section>

    <section id="tab-sso" class="tab" hidden>
      <h2>SSO</h2>
      <p class="lead">Let GitLab users sign in with their GitLab account. Admin access comes from GitLab itself: only a GitLab administrator can open this admin area.</p>
      <div class="step">
        <h3>GitLab application</h3>
        <p class="sub">In GitLab create an application (Admin → Applications) with scope <code>read_user</code>, tick <em>Trusted</em> so signed-in users are not asked again, and add these redirect URIs (one per line; the first is the public sign-in, the second the admin sign-in):</p>
        <p class="sub">${v.redirectUris.map((u) => `<code>${esc(u)}</code>`).join('<br>')}</p>
        <form id="ssoForm" class="grid" autocomplete="off">
          <label class="full">GitLab URL<input id="gitlabUrl" maxlength="300" placeholder="https://gitlab.example.com"></label>
          <label>Application ID<input id="clientId" maxlength="200"></label>
          <label>Secret<input id="clientSecret" type="password" maxlength="500" autocomplete="new-password"></label>
          <div class="row full"><button class="btn primary" type="submit">Save GitLab SSO</button><span id="ssoMsg" class="msg"></span></div>
        </form>
        <p class="sub" id="ssoState" style="margin-top:12px"></p>
      </div>
    </section>

    <section id="tab-audit" class="tab" hidden>
      <h2>Audit</h2>
      <p class="lead">Every sign-in and every change made in this admin area. Secrets are never written to the log.</p>
      <div class="step">
        <div class="row" style="margin-bottom:14px">
          <input id="auditSearch" type="search" placeholder="Search events…" style="flex:1;min-width:220px">
          <button class="btn small" type="button" id="auditRefresh">Refresh</button>
          <span class="muted" id="auditCount"></span><span class="muted" id="auditTz"></span>
        </div>
        <div class="tablewrap">
          <table class="audit"><thead><tr><th>Date / Time</th><th>Event</th><th>Entity Type</th><th>Name / ID</th><th>User</th><th>IP Address</th><th>Changes</th><th>Description</th></tr></thead>
            <tbody id="auditRows"><tr><td colspan="8" class="muted">Loading…</td></tr></tbody></table>
        </div>
        <div class="row" style="margin-top:14px"><button class="btn small" type="button" id="auditMore" hidden>Load more</button><span id="auditMsg" class="msg"></span></div>
      </div>
    </section>
  </main>
</div>
<script nonce="${esc(v.nonce)}">${ADMIN_JS(v.basePath)}</script>`,
    ADMIN_CSS,
  );
}

const PRESETS = {
  'meta-openai': { label: 'Meta Model API', kind: 'openai-compatible', baseUrl: 'https://api.meta.ai/v1' },
  'meta-anthropic': { label: 'Meta Model API (Anthropic format)', kind: 'anthropic-messages', baseUrl: 'https://api.meta.ai' },
  openai: { label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' },
  xai: { label: 'xAI', kind: 'openai-compatible', baseUrl: 'https://api.x.ai/v1' },
};

function ADMIN_JS(basePath: string): string {
  return `
(function(){
  var API=${JSON.stringify(basePath + '/admin/api')};
  var PRESETS=${JSON.stringify(PRESETS)};
  var ROLES=['text','image','pdf'];
  var HINTS={image:/image|imagen|flux|dall|diffusion|sdxl|sam|vision/i,text:/chat|muse|gpt|llama|claude|grok|spark|wonder|instruct/i,pdf:/muse|gpt|llama|claude|grok|spark|wonder|instruct|doc|long/i};
  var $=function(id){return document.getElementById(id)};
  var editing=null,data={providers:[],assignments:{}};
  function note(id,t,ok){var m=$(id);m.textContent=t||'';m.className='msg '+(ok?'ok':'err')}
  function call(method,path,body){
    return fetch(API+path,{method:method,credentials:'same-origin',
      headers:{'Content-Type':'application/json','X-Requested-With':'mnemosyne-admin'},
      body:body?JSON.stringify(body):undefined}).then(function(r){
        return r.json().catch(function(){return {}}).then(function(j){
          if(r.status===401){location.href=${JSON.stringify(basePath + '/admin/')};throw new Error('signed out')}
          if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j})})
  }
  // --- tabs (left menu) ---
  function showTab(){
    var t=(location.hash||'#llm').slice(1);if(t!=='sso'&&t!=='audit')t='llm';
    ['llm','sso','audit'].forEach(function(n){$('tab-'+n).hidden=(n!==t)});
    if(t==='audit')loadAudit(false);
    Array.prototype.forEach.call(document.querySelectorAll('.side a'),function(a){a.className=a.getAttribute('data-tab')===t?'active':''});
  }
  window.addEventListener('hashchange',showTab);showTab();

  function cell(tr,text,cls){var td=document.createElement('td');td.textContent=text;if(cls)td.className=cls;tr.appendChild(td);return td}
  function btn(label,cls,fn){var b=document.createElement('button');b.type='button';b.className='btn small '+cls;b.textContent=label;b.addEventListener('click',fn);return b}
  function ago(ms){if(!ms)return 'never fetched';var m=Math.round((Date.now()-ms)/60000);return m<1?'just now':m<60?m+' min ago':Math.round(m/60)+' h ago'}

  // --- step 2: connections + their fetched models ---
  function renderRows(){
    var rows=$('rows');rows.textContent='';
    if(!data.providers.length){var tr=document.createElement('tr');cell(tr,'No provider connected yet — start with step 1.','muted').colSpan=5;rows.appendChild(tr);return}
    data.providers.forEach(function(p){
      var tr=document.createElement('tr');
      cell(tr,p.label);cell(tr,p.baseUrl);cell(tr,p.hasKey?p.keyHint:'none');
      var m=cell(tr,'');var b=document.createElement('span');b.className='badge'+(p.models.length?' ok':'');
      b.textContent=p.models.length?p.models.length+' models · '+ago(p.modelsPulledAt):'not fetched yet';m.appendChild(b);
      var act=cell(tr,'','actions');
      act.appendChild(btn(p.models.length?'Refresh models':'Fetch models','',function(){fetchModels(p.id,p.label)}));
      act.appendChild(btn('Edit','',function(){startEdit(p)}));
      act.appendChild(btn('Delete','danger',function(){if(confirm('Delete "'+p.label+'" and its stored key?'))call('DELETE','/providers/'+p.id).then(load).catch(function(e){note('fetchMsg',e.message)})}));
      rows.appendChild(tr);
    });
  }
  function fetchModels(id,label){
    note('fetchMsg','Asking '+label+' for its models…',true);
    return call('POST','/providers/'+id+'/models').then(function(p){note('fetchMsg',label+': '+p.models.length+' models available.',true);return load()})
      .catch(function(e){note('fetchMsg',label+': '+e.message);return load()});
  }

  // --- step 3: one model per job ---
  function ordered(role,ids){
    var re=HINTS[role],hit=[],rest=[];ids.forEach(function(i){(re.test(i)?hit:rest).push(i)});return hit.concat(rest);
  }
  function renderRoles(){
    var any=data.providers.some(function(p){return p.models.length});
    $('step3').className='step'+(any?'':' off');
    ROLES.forEach(function(role){
      var sel=$('role-'+role);sel.textContent='';sel.disabled=!any;
      var none=document.createElement('option');none.value='';none.textContent='— not set —';sel.appendChild(none);
      data.providers.forEach(function(p){
        if(!p.models.length)return;
        var g=document.createElement('optgroup');g.label=p.label;
        ordered(role,p.models).forEach(function(mid){var o=document.createElement('option');o.value=p.id+'::'+mid;o.textContent=mid;g.appendChild(o)});
        sel.appendChild(g);
      });
      var a=data.assignments[role];if(a)sel.value=a.providerId+'::'+a.model;
    });
    $('saveRoles').disabled=!any;
  }
  $('assign').addEventListener('submit',function(ev){
    ev.preventDefault();note('assignMsg','');
    var body={};
    ROLES.forEach(function(role){var v=$('role-'+role).value;if(v){var i=v.indexOf('::');body[role]={providerId:v.slice(0,i),model:v.slice(i+2)}}});
    call('PUT','/llm/assignments',body).then(function(){note('assignMsg','Saved.',true);return load()}).catch(function(e){note('assignMsg',e.message)});
  });

  function load(){return call('GET','/providers').then(function(d){data=d;renderRows();renderRoles()}).catch(function(e){note('fetchMsg',e.message)})}

  // --- step 1: connect ---
  function startEdit(p){
    editing=p.id;$('cancel').hidden=false;$('save').textContent='Save & fetch models';
    $('label').value=p.label;$('kind').value=p.kind;$('baseUrl').value=p.baseUrl;
    $('apiKey').value='';$('apiKey').placeholder=p.hasKey?'Leave empty to keep '+p.keyHint:'';$('preset').value='';
    $('step1').scrollIntoView({behavior:'smooth'});
  }
  function reset(){editing=null;$('form').reset();$('cancel').hidden=true;$('apiKey').placeholder=''}
  $('cancel').addEventListener('click',function(){reset();note('msg','')});
  $('preset').addEventListener('change',function(){var p=PRESETS[$('preset').value];if(!p)return;
    $('label').value=p.label;$('kind').value=p.kind;$('baseUrl').value=p.baseUrl});
  $('form').addEventListener('submit',function(ev){
    ev.preventDefault();note('msg','');$('save').disabled=true;
    var label=$('label').value;
    call('POST','/providers',{id:editing||undefined,label:label,kind:$('kind').value,baseUrl:$('baseUrl').value,apiKey:$('apiKey').value})
      .then(function(p){reset();note('msg','Saved. Fetching models…',true);return load().then(function(){return fetchModels(p.id,label)})})
      .then(function(){note('msg','')}).catch(function(e){note('msg',e.message)}).then(function(){$('save').disabled=false});
  });

  // --- SSO tab ---
  function loadSso(){return call('GET','/settings').then(function(c){
    $('gitlabUrl').value=c.gitlabUrl;$('clientId').value=c.clientId;
    $('clientSecret').value='';$('clientSecret').placeholder=c.hasSecret?'Leave empty to keep '+c.secretHint:'';
    $('ssoState').textContent=(c.ssoActive?'GitLab sign-in is active.':'GitLab sign-in is not active yet.')+(c.localUser?' Local admin account: '+c.localUser+'.':'')
  }).catch(function(e){note('ssoMsg',e.message)})}
  $('ssoForm').addEventListener('submit',function(ev){
    ev.preventDefault();note('ssoMsg','');
    call('PUT','/settings',{gitlabUrl:$('gitlabUrl').value,clientId:$('clientId').value,clientSecret:$('clientSecret').value})
      .then(function(){note('ssoMsg','Saved.',true);return loadSso()}).catch(function(e){note('ssoMsg',e.message)});
  });

  // --- Audit tab ---
  var auditShown=0,auditTimer=null;
  $('auditTz').textContent=Intl.DateTimeFormat().resolvedOptions().timeZone;
  function changeCell(td,text){
    if(!text)return;var pre=document.createElement('pre');pre.className='chg';
    text.split('\\n').forEach(function(l,i){var sp=document.createElement('span');sp.className=l.charAt(0)==='+'?'p':l.charAt(0)==='-'?'m':'';sp.textContent=(i?'\\n':'')+l;pre.appendChild(sp)});
    td.appendChild(pre);
  }
  function auditRow(e){
    var tr=document.createElement('tr');
    cell(tr,new Date(e.time).toLocaleString(),'t');
    var ev=cell(tr,'');var b=document.createElement('span');b.className='ev '+e.event;b.textContent=e.event.replace('_',' ');ev.appendChild(b);
    cell(tr,e.entityType);cell(tr,e.entityName+(e.entityId&&e.entityId!==e.entityName?' ('+e.entityId.slice(0,8)+')':''));
    cell(tr,e.user);cell(tr,e.ip);changeCell(cell(tr,''),e.changes);cell(tr,e.description);
    return tr;
  }
  function loadAudit(more){
    note('auditMsg','');var rows=$('auditRows');
    if(!more){auditShown=0}
    call('GET','/audit?q='+encodeURIComponent($('auditSearch').value.trim())+'&offset='+auditShown).then(function(d){
      if(!more)rows.textContent='';
      if(!d.events.length&&!more){var tr=document.createElement('tr');cell(tr,'No events yet.','muted').colSpan=8;rows.appendChild(tr)}
      d.events.forEach(function(e){rows.appendChild(auditRow(e))});
      auditShown+=d.events.length;
      $('auditCount').textContent=auditShown+' of '+d.total+' events';
      $('auditMore').hidden=auditShown>=d.total;
    }).catch(function(e){note('auditMsg',e.message)});
  }
  var st;$('auditSearch').addEventListener('input',function(){clearTimeout(st);st=setTimeout(function(){loadAudit(false)},250)});
  $('auditRefresh').addEventListener('click',function(){loadAudit(false)});
  $('auditMore').addEventListener('click',function(){loadAudit(true)});
  setInterval(function(){if(!$('tab-audit').hidden&&!$('auditSearch').value&&auditShown<=500)loadAudit(false)},15000);

  load();loadSso();
})();`;
}
