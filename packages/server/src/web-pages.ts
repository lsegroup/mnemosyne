/** HTML for the web portal. Dark theme, no external assets, no inline handlers. */

import { esc } from './html.js';
import type { DocMeta, HistoryEntry } from './docgen.js';
import { JOB_DEFS, MAX_OUTPUT_TOKENS } from './ai-jobs.js';
export { esc };

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
const ICON_WRENCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
const ICON_GRID = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>';
/** Header buttons that flip between the user area and the admin area (each area keeps its own sign-in). */
const topBtn = (href: string, label: string, icon: string, title: string) => `<a class="topbtn" href="${href}" title="${esc(title)}">${icon}<span>${esc(label)}</span></a>`;
const TOPBTN_CSS = '.topbtn{display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);color:var(--text);font-size:14px;text-decoration:none;white-space:nowrap}.topbtn:hover{border-color:var(--accent);color:#fff}.topbtn svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}';

const ADMIN_CSS = `
:root{--bg:#0d0e13;--panel:#161922;--panel2:#12141b;--line:#262a36;--text:#e6e9ef;--muted:#8b90a0;--accent:#7a66e0;--accent-h:#9482ee;--title:#8473de;--teal:#3cc4cc}
html,body{background:var(--bg)}
body{background:radial-gradient(ellipse 50% 40% at 12% 0%,rgba(120,58,182,.20),transparent 100%),radial-gradient(ellipse 45% 40% at 95% 0%,rgba(30,152,164,.14),transparent 100%),var(--bg);background-attachment:fixed}
.btn.primary{color:#fff}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 24px;border-bottom:1px solid var(--line);background:rgba(22,25,34,.85)}
.brand{font:600 24px/1 "Palatino Linotype","Book Antiqua",Palatino,Georgia,"Times New Roman",serif;letter-spacing:.4px;color:var(--title)}
.brand .muted{font:500 14px/1 system-ui,sans-serif;letter-spacing:0;color:var(--teal)}
.top .right{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:14px}.top form{margin:0}
${TOPBTN_CSS}
.layout{display:grid;grid-template-columns:210px minmax(0,1fr);gap:28px;max-width:1640px;margin:0 auto;padding:28px 24px 60px}
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
.pager{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:16px}.pager .btn[disabled]{opacity:.4;cursor:default}
.jobs{display:flex;flex-direction:column;gap:18px;margin-top:14px}
.job{display:flex;flex-direction:column;gap:14px;padding:18px 20px;border:1px solid var(--line);border-radius:12px;background:var(--panel2)}
.jobhead{display:flex;align-items:center;gap:12px}.jobhead h4{margin:0;font:600 20px/1.2 "Palatino Linotype","Book Antiqua",Palatino,Georgia,serif;color:var(--title)}
.tag{padding:2px 10px;border-radius:99px;border:1px solid var(--line);font-size:12px;color:var(--muted)}.tag.ai{border-color:#d8a84a;color:#f0c36a}
.job .sub{margin:0;color:var(--muted);font-size:13.5px;line-height:1.5}
.job .nums{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 22px}
.job .hint{font-size:12px;line-height:1.45;color:var(--muted)}.job .hint code{color:var(--teal)}
.job textarea{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;min-height:120px;resize:vertical;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text)}
.layout>main{min-width:0}.tab>.step{min-width:0}
.tablewrap{overflow-x:auto;max-width:100%}
table.audit{font-size:13px;width:100%;min-width:900px}
table.audit td{vertical-align:top}
table.audit td.t{white-space:nowrap;color:var(--muted)}
table.audit td.chg{min-width:230px;max-width:360px}
table.audit td.desc{min-width:170px;max-width:280px}
.ev{display:inline-block;padding:1px 9px;border-radius:99px;font-size:12px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.ev.login,.ev.create,.ev.fetch{color:var(--teal);border-color:#1d5f64}
.ev.update{color:#b3a3ff;border-color:#4b3f94}
.ev.login_failed,.ev.denied,.ev.delete,.ev.fetch_failed{color:#ff8b8b;border-color:#6a2e2e}
pre.chg{margin:0;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
pre.chg .p{color:#6ee7a0}pre.chg .m{color:#ff9a9a}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#a3a8b8}
.ev.auto_start,.ev.auto_run,.ev.auto_agree{color:#f0c36a;border-color:#6b5320}
.btn:disabled{opacity:.45;cursor:not-allowed}.btn:disabled:hover{border-color:var(--line)}.btn.primary:disabled:hover{border-color:var(--accent)}
.between{justify-content:space-between}
.switch{flex-direction:row;align-items:center;gap:10px;color:var(--text);font-weight:600;font-size:14px;cursor:pointer}
input.swin{appearance:none;-webkit-appearance:none;width:44px;height:24px;padding:0;border-radius:99px;border:0;background:#2a2e3b;position:relative;cursor:pointer;flex:none}
input.swin:after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s}
input.swin:checked{background:var(--accent)}input.swin:checked:after{left:23px}
input.cbx{appearance:none;-webkit-appearance:none;width:18px;height:18px;padding:0;border-radius:5px;border:1.5px solid var(--muted);background:transparent;position:relative;cursor:pointer;flex:none}
input.cbx:checked{background:var(--accent);border-color:var(--accent)}
input.cbx:checked:after{content:"";position:absolute;left:5px;top:1px;width:5px;height:10px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
.when{display:grid;grid-template-columns:1.25fr 1fr;gap:22px}
.box{border:1px solid var(--line);border-radius:12px;background:var(--panel2);padding:16px 18px;display:flex;flex-direction:column;gap:12px}
.radio{flex-direction:row;align-items:center;gap:10px;color:var(--text);font-size:14px;font-weight:600;cursor:pointer}
.radio input{padding:0;width:16px;height:16px;accent-color:var(--accent)}
.days{display:flex;gap:8px;flex-wrap:wrap;padding-left:26px}
.day{min-width:56px;text-align:center;padding:8px 0;border-radius:8px;border:1px solid var(--line);background:#0f1117;color:var(--muted);font:inherit;font-weight:600;font-size:13px;cursor:pointer}
.day.on{background:var(--accent);border-color:var(--accent);color:#fff}
.fields{display:grid;grid-template-columns:1fr 1.3fr;gap:14px}
.next{display:flex;align-items:center;gap:10px;padding:11px 14px;border-radius:10px;border:1px solid #1d5f64;background:#0e1c1f;color:#bfeff2;font-size:14px}
.next b{color:#fff}
.hint2{color:var(--muted);font-size:12.5px;line-height:1.5}
.tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.tools input{flex:1;min-width:220px}
.count{color:var(--muted);font-size:13px;margin-left:auto}
.plist{height:330px;overflow-y:scroll;border:1px solid var(--line);border-radius:10px;background:var(--panel2)}
.plist::-webkit-scrollbar{width:12px}.plist::-webkit-scrollbar-track{background:#0f1117}.plist::-webkit-scrollbar-thumb{background:#3a4052;border-radius:8px;border:2px solid #0f1117}
.ph,.pr{display:grid;grid-template-columns:40px minmax(190px,1.3fr) minmax(170px,1fr) 90px 130px 250px;align-items:center;padding:9px 14px;gap:8px;border-bottom:1px solid var(--line);font-size:14px}
.ph{position:sticky;top:0;background:#171a23;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.5px;font-weight:600;z-index:1}
.pr:hover{background:#171b25}.pr .nm{font-weight:600}.pr .pa{color:var(--muted);font-size:13px}
.pr.none{display:block;color:var(--muted)}
.st{display:inline-block;padding:1px 9px;border-radius:99px;font-size:12px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.st.chg{color:#f0c36a;border-color:#6b5320;background:#211b0c}.st.new{color:#b3a3ff;border-color:#4b3f94;background:#171335}.st.ok{color:#4ade80;border-color:#1f5a38}
.what{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.opt{flex-direction:row;display:flex;gap:14px;align-items:flex-start;padding:16px 18px;border:1px solid var(--line);border-radius:12px;background:var(--panel2);cursor:pointer;color:var(--text)}
.opt.on{border-color:var(--accent);box-shadow:inset 3px 0 0 var(--accent)}
.opt b{display:block;font-size:15px;margin-bottom:3px}.opt .d{display:block;color:var(--muted);font-size:13.5px;line-height:1.5}
.opt input{margin-top:2px}
.money{display:grid;grid-template-columns:1.1fr 1fr;gap:22px;align-items:start}
.facts{display:grid;grid-template-columns:auto 1fr;gap:7px 18px;font-size:14px;margin:0}.facts dt{color:var(--muted)}.facts dd{margin:0}
.cap{display:flex;align-items:center;gap:10px}.cap input{width:130px}
.live{display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:10px;border:1px solid #1d5f64;background:#0e1c1f;color:#bfeff2;font-size:14px;margin-bottom:14px}
.bar{height:7px;border-radius:99px;background:#0b2a2d;flex:1;overflow:hidden}.bar i{display:block;height:100%;width:0;background:var(--teal)}
.fail{color:#ff8b8b}
.veil{position:fixed;inset:0;background:rgba(5,6,10,.72);display:flex;align-items:flex-start;justify-content:center;padding:70px 16px 0;z-index:9;overflow:auto}
.modal{width:760px;max-width:100%;border:1px solid var(--line);border-radius:16px;background:var(--panel);padding:26px 28px;box-shadow:0 30px 80px rgba(0,0,0,.6)}
.modal h3{font:600 22px/1.2 "Palatino Linotype","Book Antiqua",Palatino,Georgia,serif;color:var(--title);margin:0 0 6px;display:block}
.warn{margin:16px 0;padding:12px 14px;border-radius:10px;border:1px solid #6b5320;background:#211b0c;color:#f0c36a;font-size:14px;line-height:1.5}
.agree{display:flex;gap:12px;align-items:flex-start;color:var(--text);font-size:14px;line-height:1.5;margin:6px 0 18px;flex-direction:row}
.agree input{margin-top:3px}
@media(max-width:860px){.layout{grid-template-columns:1fr}.side{flex-direction:row;position:static;flex-wrap:wrap}.job .nums,form.grid,.when,.what,.money{grid-template-columns:1fr}.ph,.pr{grid-template-columns:34px minmax(100px,1fr) 100px 130px}.ph span:nth-child(3),.pr span:nth-child(3),.ph span:nth-child(4),.pr span:nth-child(4){display:none}}`;

/** Admin shell; the interactive part lives in {@link ADMIN_JS}, run under the CSP nonce. */

/** Step 3 of the LLM tab: one stacked block per AI job (model, limits, sampling values, prompts). Texts come from ai-jobs.ts. */
function jobBlocks(): string {
  const def = (role: 'text' | 'image' | 'pdf') => JOB_DEFS[role];
  const fmt = (n: number) => n.toLocaleString('en-US');
  return (['text', 'image', 'pdf'] as const)
    .map((role) => {
      const d = def(role);
      const ph = d.placeholders.length
        ? `<span class="hint">Placeholders the server fills in: ${d.placeholders.map((p) => `<code>{{${esc(p.name)}}}</code> = ${esc(p.meaning)}${p.required ? ' <b>(required)</b>' : ''}`).join(' · ')}</span>`
        : '';
      const ai = `<div class="nums">
      <label>Max output tokens<input id="maxTokens-${role}" inputmode="numeric" placeholder="${fmt(d.defaults.maxTokens)}" autocomplete="off"><span class="hint">The most the AI may write in one call. You pay per token written, so this is the cost ceiling of a call; the agreement popup shows the worst case. Big projects and reasoning models need a high limit. Default ${fmt(d.defaults.maxTokens)}, allowed 256 to ${fmt(MAX_OUTPUT_TOKENS)}.</span></label>
      <label>Temperature<input id="temperature-${role}" inputmode="decimal" placeholder="provider default" autocomplete="off"><span class="hint">0 to 2. Lower = more factual and repeatable, higher = more varied. Empty = the provider's own default (the value is not sent).</span></label>
      <label>Top-p<input id="topP-${role}" inputmode="decimal" placeholder="provider default" autocomplete="off"><span class="hint">0.01 to 1. The share of most-likely words the AI may choose from; lower = safer wording. Empty = the provider's own default (not sent).</span></label>
      <label>Time limit per call (minutes)<input id="timeoutMinutes-${role}" inputmode="numeric" placeholder="${d.defaults.timeoutMinutes}" autocomplete="off"><span class="hint">A call that takes longer is stopped. Default ${d.defaults.timeoutMinutes}, allowed 1 to 60.</span></label>
    </div>
    <label class="wide">${esc(d.systemLabel)}<textarea id="sys-${role}" rows="6" spellcheck="false"></textarea></label>
    <label class="wide">${esc(d.userLabel)}<textarea id="usr-${role}" rows="14" spellcheck="false"></textarea>${ph}</label>`;
      return `<form class="job" data-role="${role}" id="job-${role}">
    <div class="jobhead"><h4>${esc(d.title)}</h4><span class="tag${d.usesAi ? ' ai' : ''}">${d.usesAi ? 'AI call · costs money' : 'no AI call yet'}</span></div>
    <p class="sub">${esc(d.summary)}</p>
    <label class="wide">Model<select id="m-${role}"></select><span class="hint">Picked from the models your keys can use (step 2).</span></label>
    ${ai}
    <div class="row"><button class="btn primary" type="submit">Save ${esc(d.title)} settings</button><button class="btn" type="button" data-reset="${role}">Reset to defaults</button><span id="msg-${role}" class="msg"></span></div>
  </form>`;
    })
    .join('\n  ');
}

export function adminPage(v: AdminView): string {
  const base = esc(v.basePath);
  return shell(
    'Mnemosyne admin',
    `<header class="top">
  <span class="brand">Mnemosyne <span class="muted">admin</span></span>
  <div class="right">${topBtn(`${base}/`, 'Projects', ICON_GRID, 'Back to the projects and their documentation')}<span>${esc(v.user.name)} <span>@${esc(v.user.username)}</span></span>
  <form method="post" action="${base}/admin/auth/logout"><button class="btn small" type="submit">Sign out</button></form></div>
</header>
<div class="layout">
  <nav class="side" aria-label="Admin sections"><a href="#llm" data-tab="llm" class="active">LLM</a><a href="#auto" data-tab="auto">Auto</a><a href="#sso" data-tab="sso">SSO</a><a href="#audit" data-tab="audit">Audit</a><a href="#license" data-tab="license">License</a></nav>
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
        <h3><span class="num">3</span> Choose the model and settings for each job</h3>
        <p class="sub">Every value the AI calls use is set here, nothing is fixed in the program. Leave a number empty to use the default; “Reset to defaults” puts the built-in prompts back. A change applies to the next run (the agreement popup then shows the new worst-case cost).</p>
        <div class="jobs">
  ${jobBlocks()}
        </div>
      </div>
    </section>

    <section id="tab-auto" class="tab" hidden>
      <h2>Auto</h2>
      <p class="lead">Let Mnemosyne update the documentation by itself at a time when nobody is working. Only projects whose notes changed since their last article are touched; everything else is left alone.</p>
      <div class="notice error" id="autoPaused" hidden></div>

      <div class="step">
        <div class="row between"><h3><span class="num">1</span> When</h3>
          <label class="switch"><input type="checkbox" id="autoOn" class="swin"><b id="autoOnText">Automatic update is OFF</b></label></div>
        <p class="sub">Set the day and the time. The switch is the kill switch: turned off, nothing runs and nothing is spent.</p>
        <div class="when">
          <div class="box">
            <label class="radio"><input type="radio" name="autoMode" id="autoWeekly" checked> Every week on</label>
            <div class="days" id="autoDays"></div>
            <label class="radio" style="margin-top:6px"><input type="radio" name="autoMode" id="autoOnce"> Once, on a date</label>
            <div class="days"><input type="date" id="autoDate" style="width:180px"></div>
          </div>
          <div class="box">
            <div class="fields">
              <label>Start at (24-hour clock, HH:MM)<input id="autoTime" value="02:00" maxlength="5" placeholder="02:00" inputmode="numeric" autocomplete="off"></label>
              <label>Time zone<select id="autoTz"></select></label>
            </div>
            <div class="next" id="autoNext">Loading…</div>
            <span class="hint2">A run that was missed because the server was down starts when it is back, if it is less than 12 hours late; otherwise it is skipped and shown in the run list.</span>
          </div>
        </div>
      </div>

      <div class="step">
        <h3><span class="num">2</span> Which projects</h3>
        <p class="sub">Tick the projects that are kept up to date automatically. The badge shows what a run would do <em>right now</em>; this check reads the notes only and costs nothing.</p>
        <div class="tools">
          <input type="search" id="autoSearch" placeholder="Search projects…">
          <button class="btn small" type="button" id="autoAll">Select all</button>
          <button class="btn small" type="button" id="autoChanged">Only projects with changes</button>
          <button class="btn small" type="button" id="autoNone">Clear</button>
          <span class="count" id="autoCount"></span>
        </div>
        <div class="plist">
          <div class="ph"><span></span><span>Project</span><span>GitLab</span><span>Notes</span><span>Last article</span><span>State</span></div>
          <div id="autoRows"></div>
        </div>
        <p class="hint2" id="autoNewNote" hidden style="margin:10px 0 0">Projects added since you saved are marked “new” and are <b>not</b> included until you tick them: nothing is added to the spending without you.</p>
      </div>

      <div class="step">
        <h3><span class="num">3</span> What to create</h3>
        <p class="sub">Both are AI calls and cost money. The picture is always made from the newest article of the project.</p>
        <div class="what">
          <label class="opt on" id="autoTextBox"><input type="checkbox" class="cbx" id="autoText" checked><span><b>TEXT</b><span class="d">The project documentation article, written by AI from all notes of the project (what “Generate documentation” does today).</span></span></label>
          <label class="opt on" id="autoChartsBox"><input type="checkbox" class="cbx" id="autoCharts" checked><span><b>AI flow charts</b><span class="d">The architecture diagrams: AI plans the pictures from the article, Mnemosyne draws them (what “Create workflow diagram” does today).</span></span></label>
        </div>
      </div>

      <div class="step">
        <h3><span class="num">4</span> Spending limit and agreement</h3>
        <p class="sub">Automatic runs use the models and limits chosen in LLM. Nothing runs until you have agreed to the cost below.</p>
        <div class="money">
          <div><dl class="facts" id="autoFacts"></dl><p class="err" id="autoFactsErr"></p></div>
          <div class="box">
            <label>Stop the run when the cost reaches (USD, required)
              <span class="cap"><input id="autoLimit" inputmode="decimal" value="10.00" autocomplete="off"> <span class="muted">per run</span></span></label>
            <span class="hint2">The cost is counted from the tokens the provider reports. When the next project could take the run over this limit, the run stops and lists the projects it did not reach. The agreement popup shows the highest amount a month can cost with this limit.</span>
            <div class="row"><button class="btn primary" type="button" id="autoSave">Save schedule…</button><span class="msg" id="autoMsg"></span></div>
          </div>
        </div>
      </div>

      <div class="step">
        <h3><span class="num">5</span> Runs</h3>
        <div class="live" id="autoLive" hidden><span id="autoLiveText"></span><span class="bar"><i id="autoBar"></i></span><span id="autoLiveTime"></span></div>
        <div class="tablewrap"><table><thead><tr><th>Started (UTC)</th><th>Trigger</th><th>Updated</th><th>Unchanged</th><th>Failed / not reached</th><th>Tokens in / out</th><th>Cost</th><th>Result</th></tr></thead>
          <tbody id="autoRuns"><tr><td colspan="8" class="muted">Loading…</td></tr></tbody></table></div>
        <p class="hint2" style="margin:10px 0 0">Every automatic AI call is also written to the Audit tab (who agreed, which project, tokens, cost).</p>
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
        <div class="pager" id="auditPager"></div>
        <div class="row" style="margin-top:8px"><span id="auditMsg" class="msg"></span></div>
      </div>
    </section>

    <section id="tab-license" class="tab" hidden>
      <h2>License</h2>
    </section>
  </main>
</div>
<div class="veil" id="autoModal" hidden>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="autoModalTitle">
    <h3 id="autoModalTitle">Agree to automatic AI use</h3>
    <p class="sub" style="margin:0">Mnemosyne will call an AI model by itself, on a schedule, with no one pressing a button. This costs money.</p>
    <dl class="facts" id="autoModalFacts" style="margin-top:16px"></dl>
    <div class="warn">The agreement is tied to exactly this setup. If the project list, what is created, the schedule, the model, the token limits or the spending limit change, the schedule pauses and asks you to agree again. The switch in step 1 stops everything at any time.</div>
    <label class="agree"><input type="checkbox" class="cbx" id="autoAgree"><span>I agree that Mnemosyne uses AI automatically on this schedule and I accept the cost.</span></label>
    <div class="row"><button class="btn primary" type="button" id="autoGo" disabled>Agree and save schedule</button><button class="btn" type="button" id="autoCancel">Cancel</button><span class="msg" id="autoModalMsg"></span></div>
  </div>
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
    var TABS=['llm','auto','sso','audit','license'];
    var t=(location.hash||'#llm').slice(1);if(TABS.indexOf(t)<0)t='llm';
    TABS.forEach(function(n){$('tab-'+n).hidden=(n!==t)});
    if(t==='audit')loadAudit();
    if(t==='auto')loadAuto(autoLoaded);
    Array.prototype.forEach.call(document.querySelectorAll('.side a'),function(a){a.className=a.getAttribute('data-tab')===t?'active':''});
  }
  var autoLoaded=false;
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
  var JOBS={};
  function modelOptions(role,sel,any){
    sel.textContent='';sel.disabled=!any;
    var none=document.createElement('option');none.value='';none.textContent='— not set —';sel.appendChild(none);
    data.providers.forEach(function(p){
      if(!p.models.length)return;
      var g=document.createElement('optgroup');g.label=p.label;
      ordered(role,p.models).forEach(function(mid){var o=document.createElement('option');o.value=p.id+'::'+mid;o.textContent=mid;g.appendChild(o)});
      sel.appendChild(g);
    });
  }
  function fillJob(role){
    var j=JOBS[role];if(!j)return;
    var a=j.assignment;if(a)$('m-'+role).value=a.providerId+'::'+a.model;
    var st=j.settings||{},e=j.effective;
    ['maxTokens','temperature','topP','timeoutMinutes'].forEach(function(k){$(k+'-'+role).value=st[k]===undefined?'':st[k]});
    $('sys-'+role).value=e.systemPrompt;$('usr-'+role).value=e.userPrompt;
  }
  function renderRoles(){
    var any=data.providers.some(function(p){return p.models.length});
    $('step3').className='step'+(any?'':' off');
    ROLES.forEach(function(role){modelOptions(role,$('m-'+role),any);fillJob(role)});
    Array.prototype.forEach.call(document.querySelectorAll('#step3 .job button[type=submit]'),function(b){b.disabled=!any});
  }
  ROLES.forEach(function(role){
    $('job-'+role).addEventListener('submit',function(ev){
      ev.preventDefault();note('msg-'+role,'');
      var body={},v=$('m-'+role).value;
      if(v){var i=v.indexOf('::');body.model={providerId:v.slice(0,i),model:v.slice(i+2)}}
      ['maxTokens','temperature','topP','timeoutMinutes'].forEach(function(k){body[k]=$(k+'-'+role).value.trim()});
      body.systemPrompt=$('sys-'+role).value;body.userPrompt=$('usr-'+role).value;
      call('PUT','/llm/jobs/'+role,body).then(function(r){JOBS=r.jobs;data.assignments={};ROLES.forEach(function(x){if(JOBS[x].assignment)data.assignments[x]=JOBS[x].assignment});fillJob(role);note('msg-'+role,'Saved. It applies to the next run.',true)}).catch(function(e){note('msg-'+role,e.message)});
    });
    var rb=document.querySelector('[data-reset="'+role+'"]');
    if(rb)rb.addEventListener('click',function(){
      var d=JOBS[role].def.defaults;
      ['maxTokens','temperature','topP','timeoutMinutes'].forEach(function(k){$(k+'-'+role).value=''});
      $('sys-'+role).value=d.systemPrompt;$('usr-'+role).value=d.userPrompt;
      note('msg-'+role,'Defaults filled in - press Save to keep them.',true);
    });
  });

  function load(){return Promise.all([call('GET','/providers'),call('GET','/llm/jobs')]).then(function(r){data=r[0];JOBS=(r[1]&&r[1].jobs)||{};renderRows();renderRoles()}).catch(function(e){note('fetchMsg',e.message)})}

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
  var auditPage=0,AUDIT_PER_PAGE=10;
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
    cell(tr,e.user);cell(tr,e.ip);changeCell(cell(tr,'','chg'),e.changes);cell(tr,e.description,'desc');
    return tr;
  }
  function pageBtn(label,page,cur,off){
    var b=document.createElement('button');b.type='button';b.className='btn small'+(cur?' primary':'');b.textContent=label;b.disabled=!!off;
    b.addEventListener('click',function(){auditPage=page;loadAudit()});return b;
  }
  function renderPager(total){
    var box=$('auditPager');box.textContent='';
    var pages=Math.max(1,Math.ceil(total/AUDIT_PER_PAGE));
    if(pages<2)return;
    box.appendChild(pageBtn('‹ Previous',auditPage-1,false,auditPage===0));
    var last=-1;
    for(var p=0;p<pages;p++){
      if(p===0||p===pages-1||Math.abs(p-auditPage)<=2){
        if(last!==-1&&p-last>1){var gap=document.createElement('span');gap.className='muted';gap.textContent='…';box.appendChild(gap)}
        box.appendChild(pageBtn(String(p+1),p,p===auditPage,false));last=p;
      }
    }
    box.appendChild(pageBtn('Next ›',auditPage+1,false,auditPage>=pages-1));
    var t=document.createElement('span');t.className='muted';t.style.marginLeft='10px';t.textContent='Page '+(auditPage+1)+' of '+pages;box.appendChild(t);
  }
  function loadAudit(){
    note('auditMsg','');var rows=$('auditRows');
    call('GET','/audit?q='+encodeURIComponent($('auditSearch').value.trim())+'&offset='+(auditPage*AUDIT_PER_PAGE)+'&limit='+AUDIT_PER_PAGE).then(function(d){
      var pages=Math.max(1,Math.ceil(d.total/AUDIT_PER_PAGE));
      if(auditPage>pages-1){auditPage=pages-1;return loadAudit()}
      rows.textContent='';
      if(!d.events.length){var tr=document.createElement('tr');cell(tr,$('auditSearch').value.trim()?'No matching events.':'No events yet.','muted').colSpan=8;rows.appendChild(tr)}
      d.events.forEach(function(e){rows.appendChild(auditRow(e))});
      $('auditCount').textContent=d.total?((auditPage*AUDIT_PER_PAGE+1)+'–'+(auditPage*AUDIT_PER_PAGE+d.events.length)+' of '+d.total+' events'):'0 events';
      renderPager(d.total);
    }).catch(function(e){note('auditMsg',e.message)});
  }
  var st;$('auditSearch').addEventListener('input',function(){clearTimeout(st);st=setTimeout(function(){auditPage=0;loadAudit()},250)});
  $('auditRefresh').addEventListener('click',function(){loadAudit()});
  setInterval(function(){if(!$('tab-audit').hidden&&auditPage===0&&!$('auditSearch').value)loadAudit()},15000);

  // --- Auto tab: schedule, project selection, agreement, runs ---
  var DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var ZONES=['UTC','Europe/London','Europe/Zurich','Europe/Berlin','Europe/Paris','Europe/Amsterdam','Europe/Madrid','Europe/Rome','Europe/Vienna','Europe/Istanbul','Europe/Moscow','Africa/Johannesburg','Asia/Dubai','Asia/Kolkata','Asia/Singapore','Asia/Hong_Kong','Asia/Shanghai','Asia/Tokyo','Asia/Seoul','Australia/Sydney','Pacific/Auckland','America/Sao_Paulo','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Anchorage','Pacific/Honolulu'];
  var RESULT={completed:'completed',nothing:'nothing changed',limit:'stopped at the limit',missed:'missed',stopped:'stopped',running:'running'};
  var AUTO=null,autoSel={},autoDay={},autoWas=false,autoTimer=0,autoToken=null;
  function span(parent,text,cls){var s=document.createElement('span');s.textContent=text;if(cls)s.className=cls;parent.appendChild(s);return s}
  function fillDl(dl,rows){dl.textContent='';(rows||[]).forEach(function(r){var dt=document.createElement('dt');dt.textContent=r[0];var dd=document.createElement('dd');dd.textContent=r[1];dl.appendChild(dt);dl.appendChild(dd)})}
  function fmtZ(iso,tz){try{return new Date(iso).toLocaleString('en-GB',{timeZone:tz,weekday:'long',day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})+' ('+tz+')'}catch(e){return iso}}
  function fmtT(iso){return iso?iso.slice(0,16).replace('T',' '):''}
  function secs(since){var s=Math.max(0,Math.round((Date.now()-Date.parse(since))/1000));return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2)}
  function autoZones(want){
    var sel=$('autoTz'),list=ZONES.slice(),mine='';
    try{mine=Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){}
    [mine,want].forEach(function(z){if(z&&list.indexOf(z)<0)list.push(z)});
    sel.textContent='';list.forEach(function(z){var o=document.createElement('option');o.value=z;o.textContent=z;sel.appendChild(o)});
    sel.value=want||'UTC';
  }
  function autoDays(){
    var box=$('autoDays');box.textContent='';
    [1,2,3,4,5,6,0].forEach(function(d){
      var b=document.createElement('button');b.type='button';b.className='day'+(autoDay[d]?' on':'');b.textContent=DAYS[d];
      b.addEventListener('click',function(){autoDay[d]=!autoDay[d];autoDays();autoDirty()});box.appendChild(b);
    });
  }
  // what a run would do for this project with the ticks as they are now
  function autoWould(p){
    var t=$('autoText').checked,c=$('autoCharts').checked;
    var text=t&&p.textDue,charts=c&&(p.chartsDue||text)&&(p.hasArticle||text);
    if(text)return p.hasArticle?{k:'chg',l:p.detail,w:true}:{k:'new',l:'no article yet',w:true};
    if(charts)return {k:'chg',l:p.detail,w:true};
    if(p.textDue)return {k:'',l:'changed - TEXT is not ticked',w:false};
    return {k:'ok',l:'up to date',w:false};
  }
  function autoRows(){
    var rows=$('autoRows');rows.textContent='';
    var q=$('autoSearch').value.trim().toLowerCase(),known=AUTO&&AUTO.config?AUTO.config.known:null,shown=0;
    (AUTO?AUTO.projects:[]).forEach(function(p){
      if(q&&(p.project+' '+(p.glPath||'')).toLowerCase().indexOf(q)<0)return;
      shown++;
      var r=document.createElement('div');r.className='pr';
      var cb=document.createElement('input');cb.type='checkbox';cb.className='cbx';cb.checked=!!autoSel[p.project];
      cb.addEventListener('change',function(){autoSel[p.project]=cb.checked;autoDirty()});r.appendChild(cb);
      var nm=span(r,p.project,'nm');
      if(known&&known.indexOf(p.project)<0){var nw=span(nm,'new','st new');nw.style.marginLeft='8px'}
      span(r,p.glPath||'—','pa');span(r,String(p.notes));span(r,p.lastArticle?p.lastArticle.slice(0,10):'—');
      var w=autoWould(p),c=document.createElement('span');span(c,w.l,'st '+w.k);r.appendChild(c);
      rows.appendChild(r);
    });
    if(!shown){var e=document.createElement('div');e.className='pr none';e.textContent=AUTO&&AUTO.projects.length?'No matching project.':'No project has notes yet.';rows.appendChild(e)}
  }
  function autoCounts(){
    var n=0,ch=0,nw=0,all=AUTO?AUTO.projects:[];
    all.forEach(function(p){if(autoSel[p.project]){n++;if(autoWould(p).w)ch++;if(!p.hasArticle)nw++}});
    $('autoCount').textContent=n+' of '+all.length+' selected · '+ch+' have changes · '+nw+' have no article yet';
  }
  function autoRead(){
    var d=[],sel=[];
    [0,1,2,3,4,5,6].forEach(function(x){if(autoDay[x])d.push(x)});
    (AUTO?AUTO.projects:[]).forEach(function(p){if(autoSel[p.project])sel.push(p.project)});
    return {schedule:{mode:$('autoOnce').checked?'once':'weekly',days:d,date:$('autoDate').value,time:$('autoTime').value,tz:$('autoTz').value},projects:sel,text:$('autoText').checked,charts:$('autoCharts').checked,limitUsd:$('autoLimit').value};
  }
  function autoOpts(){$('autoTextBox').className='opt'+($('autoText').checked?' on':'');$('autoChartsBox').className='opt'+($('autoCharts').checked?' on':'')}
  // the form shows the saved setup (or the defaults: Saturday and Sunday, 02:00, both ticked, 10 dollars)
  function autoWrite(){
    var c=AUTO&&AUTO.config,s=c?c.schedule:{mode:'weekly',days:[6,0],time:'02:00',tz:'UTC',date:''};
    autoDay={};(s.days||[]).forEach(function(d){autoDay[d]=true});autoDays();
    $('autoWeekly').checked=s.mode!=='once';$('autoOnce').checked=s.mode==='once';
    $('autoDate').value=s.date||'';$('autoTime').value=s.time;autoZones(s.tz);
    $('autoText').checked=c?c.text:true;$('autoCharts').checked=c?c.charts:true;autoOpts();
    $('autoLimit').value=c?Number(c.limitUsd).toFixed(2):'10.00';
    autoSel={};if(c)c.projects.forEach(function(p){autoSel[p]=true});
  }
  function autoSwitch(){var on=!!(AUTO&&AUTO.config&&AUTO.config.enabled);$('autoOn').checked=on;$('autoOnText').textContent='Automatic update is '+(on?'ON':'OFF')}
  function autoNext(){
    var el=$('autoNext');el.textContent='';var s=AUTO,c=s&&s.config;
    if(!c){el.textContent='Not set up yet. Choose the days, the projects and the limit, then press “Save schedule…”.';return}
    if(!c.enabled){el.textContent='Switched off — nothing will run.';return}
    if(s.pausedReason){el.textContent='Paused — see the warning at the top of this page.';return}
    if(!s.nextRunAt){el.textContent='No further run is planned (a one-time schedule has run).';return}
    span(el,'Next run:');var b=document.createElement('b');b.textContent=fmtZ(s.nextRunAt,c.schedule.tz);el.appendChild(b);
  }
  function autoPaused(){var el=$('autoPaused');el.hidden=!(AUTO&&AUTO.pausedReason);el.textContent=AUTO&&AUTO.pausedReason?AUTO.pausedReason:''}
  function autoRuns(runs){
    var tb=$('autoRuns');tb.textContent='';
    if(!runs||!runs.length){var e=document.createElement('tr');cell(e,'No automatic run yet.','muted').colSpan=8;tb.appendChild(e);return}
    runs.forEach(function(r){
      var tr=document.createElement('tr');
      cell(tr,fmtT(r.startedAt));cell(tr,r.trigger);cell(tr,String(r.updated.length));cell(tr,String(r.unchanged.length));
      var f=cell(tr,r.failed.length+' / '+r.notReached.length+(r.failed.length?' — '+r.failed[0].project+': '+r.failed[0].error:''));if(r.failed.length)f.className='fail';
      cell(tr,Number(r.inputTokens).toLocaleString('en-US')+' / '+Number(r.outputTokens).toLocaleString('en-US'));cell(tr,'$'+Number(r.usd).toFixed(2));
      var td=cell(tr,'');var b=document.createElement('span');b.className='badge'+(r.status==='completed'?' ok':'');b.textContent=RESULT[r.status]||r.status;td.appendChild(b);
      if(r.note){var n=document.createElement('div');n.className='hint2';n.textContent=r.note;td.appendChild(n)}
      tb.appendChild(tr);
    });
  }
  function autoLive(run){
    var box=$('autoLive');if(!run){box.hidden=true;return}box.hidden=false;
    var done=run.total-run.queue.length,cur=run.current;
    $('autoLiveText').textContent=(cur?'While a run is going: project '+(done+1)+' of '+run.total+' — '+cur.project+' — '+(cur.kind==='wiki'?'writing the article':'planning the diagrams'):'Run in progress: '+done+' of '+run.total+' projects done')+' · spent so far $'+Number(run.usd).toFixed(2);
    $('autoBar').style.width=(run.total?Math.round(100*done/run.total):0)+'%';
    $('autoLiveTime').textContent=cur?secs(cur.since):'';
  }
  // what the setup would cost (free: reads notes only), asked from the server so the numbers are the ones the agreement shows
  function autoFacts(){
    clearTimeout(autoTimer);
    autoTimer=setTimeout(function(){
      if(AUTO&&!AUTO.model){fillDl($('autoFacts'),[]);$('autoFactsErr').textContent='Choose a model for Text in LLM first.';return}
      call('POST','/auto/estimate',{config:autoRead()}).then(function(r){$('autoFactsErr').textContent='';fillDl($('autoFacts'),r.live)})
        .catch(function(e){fillDl($('autoFacts'),[]);$('autoFactsErr').textContent=e.message});
    },300);
  }
  function autoDirty(){autoCounts();autoFacts()}
  function autoShow(keepForm){
    if(!keepForm)autoWrite();
    autoSwitch();autoNext();autoPaused();autoRows();autoCounts();autoRuns(AUTO.runs);autoLive(AUTO.run);autoWas=!!AUTO.run;
    $('autoNewNote').hidden=!(AUTO.config&&AUTO.projects.some(function(p){return AUTO.config.known.indexOf(p.project)<0}));
    autoFacts();
  }
  function loadAuto(keepForm){
    return call('GET','/auto').then(function(d){d.projects=d.projects||[];d.runs=d.runs||[];AUTO=d;autoLoaded=true;autoShow(keepForm)}).catch(function(e){note('autoMsg',e.message)});
  }
  function autoPoll(){
    if($('tab-auto').hidden||!AUTO)return;
    call('GET','/auto/status').then(function(s){
      var now=!!s.run;AUTO.run=s.run||null;AUTO.runs=s.runs||[];AUTO.nextRunAt=s.nextRunAt;AUTO.pausedReason=s.pausedReason;
      if(AUTO.config)AUTO.config.enabled=!!s.enabled;
      autoLive(s.run);autoRuns(AUTO.runs);autoNext();autoPaused();autoSwitch();
      if(autoWas&&!now)loadAuto(true);autoWas=now;
    }).catch(function(){});
  }
  setInterval(autoPoll,5000);
  ['autoWeekly','autoOnce'].forEach(function(id){$(id).addEventListener('change',autoDirty)});
  ['autoDate','autoTime','autoTz','autoLimit'].forEach(function(id){$(id).addEventListener('input',autoDirty);$(id).addEventListener('change',autoDirty)});
  ['autoText','autoCharts'].forEach(function(id){$(id).addEventListener('change',function(){autoOpts();autoRows();autoDirty()})});
  $('autoSearch').addEventListener('input',autoRows);
  function pick(all,fn){(AUTO?AUTO.projects:[]).forEach(function(p){if(all||!$('autoSearch').value.trim()||(p.project+' '+(p.glPath||'')).toLowerCase().indexOf($('autoSearch').value.trim().toLowerCase())>=0)fn(p)});autoRows();autoDirty()}
  $('autoAll').addEventListener('click',function(){pick(false,function(p){autoSel[p.project]=true})});
  $('autoNone').addEventListener('click',function(){pick(false,function(p){autoSel[p.project]=false})});
  $('autoChanged').addEventListener('click',function(){autoSel={};pick(true,function(p){if(autoWould(p).w)autoSel[p.project]=true})});
  $('autoOn').addEventListener('change',function(){
    var want=$('autoOn').checked;note('autoMsg','');
    call('PUT','/auto/switch',{enabled:want}).then(function(d){d.projects=d.projects||[];d.runs=d.runs||[];AUTO=d;autoShow(true)}).catch(function(e){note('autoMsg',e.message);autoSwitch()});
  });
  // saving asks for the agreement first: the popup shows what it can cost, the server only accepts the setup with that agreement
  $('autoSave').addEventListener('click',function(){
    note('autoMsg','');$('autoSave').disabled=true;
    call('POST','/auto/estimate',{config:autoRead()}).then(function(r){
      autoToken=r.token;fillDl($('autoModalFacts'),r.agree);$('autoAgree').checked=false;$('autoGo').disabled=true;note('autoModalMsg','');$('autoModal').hidden=false;
    }).catch(function(e){note('autoMsg',e.message)}).then(function(){$('autoSave').disabled=false});
  });
  $('autoAgree').addEventListener('change',function(){$('autoGo').disabled=!$('autoAgree').checked});
  $('autoCancel').addEventListener('click',function(){$('autoModal').hidden=true});
  $('autoGo').addEventListener('click',function(){
    $('autoGo').disabled=true;
    call('PUT','/auto',{config:autoRead(),token:autoToken}).then(function(d){
      $('autoModal').hidden=true;d.projects=d.projects||[];d.runs=d.runs||[];AUTO=d;autoShow(false);note('autoMsg','Saved and agreed. The schedule is ON.',true);
    }).catch(function(e){note('autoModalMsg',e.message);$('autoGo').disabled=!$('autoAgree').checked});
  });

  load();loadSso();
})();`;
}

// ============================================================================
// Documentation pages (signed-in area at `/`): project overview, project page, note page.
// Same palette as the login screen: purple main titles, turquoise second-level titles.
// ============================================================================

export interface DocsUser {
  name: string;
  username: string;
  /** A GitLab instance administrator: the header offers a button to the admin area. */
  admin?: boolean;
}


export interface ProjectCard {
  title: string;
  /** GitLab path or a hint such as "no GitLab project". */
  sub: string;
  count: number;
  updated: string | null;
  href: string;
  /** The project's ID in GitLab (shown on the card), when a GitLab project matches. */
  glId?: number;
  /** Only visible because the viewer is a GitLab administrator. */
  adminOnly: boolean;
}

const DOCS_CSS = `
:root{--bg:#0d0e13;--panel:#161922;--panel2:#12141b;--line:#262a36;--text:#e6e9ef;--muted:#8b90a0;--accent:#7a66e0;--accent-h:#9482ee;--title:#8473de;--teal:#3cc4cc}
html,body{background:var(--bg)}
body{background:radial-gradient(ellipse 50% 40% at 12% 0%,rgba(120,58,182,.20),transparent 100%),radial-gradient(ellipse 45% 40% at 95% 0%,rgba(30,152,164,.14),transparent 100%),var(--bg);background-attachment:fixed}
a{color:var(--teal)}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 24px;border-bottom:1px solid var(--line);background:rgba(22,25,34,.85)}
.brand{font:600 24px/1 "Palatino Linotype","Book Antiqua",Palatino,Georgia,"Times New Roman",serif;letter-spacing:.4px;color:var(--title);text-decoration:none}
.top .right{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:14px}.top form{margin:0}
${TOPBTN_CSS}
main.docs{max-width:1180px;margin:0 auto;padding:30px 24px 70px;display:flex;flex-direction:column;gap:18px}
h1{margin:0;font:600 34px/1.15 "Palatino Linotype","Book Antiqua",Palatino,Georgia,"Times New Roman",serif;letter-spacing:.3px;color:var(--title)}
h2{margin:6px 0 0;font-size:19px;font-weight:600;color:var(--teal)}
h3,h4,h5,h6{margin:14px 0 2px;color:var(--teal)}
.lead{margin:0;color:var(--muted)}
.crumbs{font-size:13px;color:var(--muted)}.crumbs a{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px}
.card{display:flex;flex-direction:column;gap:6px;padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--panel);text-decoration:none;color:var(--text);box-shadow:0 14px 40px rgba(0,0,0,.28)}
a.card:hover{border-color:var(--accent)}
.card .t{font-size:17px;font-weight:600;color:var(--teal)}
.card .s{font-size:13px;color:var(--muted)}
.card{position:relative}.card .t{padding-right:46px}
.card .gid{align-self:flex-start;margin-top:2px;padding:2px 10px;border-radius:8px;border:1px solid var(--teal);color:var(--teal);font-size:14px}.card .gid b{font-size:17px;color:#fff}
.card .n{margin-top:4px;font-size:13px;color:var(--muted)}

.card .c{position:absolute;top:12px;right:12px;min-width:30px;height:30px;padding:0 6px;box-sizing:border-box;border-radius:99px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--teal);background:transparent;border:2px solid var(--teal)}

.badge{display:inline-block;padding:1px 9px;border-radius:99px;font-size:12px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.badge.working,.badge.resolved{color:#4ade80;border-color:#1f5a38}
.badge.broken{color:#ff8b8b;border-color:#6a2e2e}
.badge.in-progress{color:#b3a3ff;border-color:#4b3f94}
.badge.admin{color:#f0c36a;border-color:#6b5420}
.notice{padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:var(--panel2);color:#a3a8b8;font-size:14px}
form.search{display:flex;gap:10px}form.search input{flex:1;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:#0f1117;color:var(--text);font:inherit}
form.search input:focus{outline:none;border-color:var(--accent)}
.btn{display:inline-flex;align-items:center;padding:9px 14px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.btn:hover{border-color:var(--accent)}.btn.small{padding:5px 10px;font-size:13px}
ul.notes{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:12px;background:var(--panel);overflow:hidden}
ul.notes li{display:flex;gap:12px;align-items:baseline;padding:11px 16px;border-bottom:1px solid var(--line)}
ul.notes li:last-child{border-bottom:0}
ul.notes a{flex:1;text-decoration:none;color:var(--text);font-weight:500}ul.notes a:hover{color:var(--teal)}
.muted{color:var(--muted)}.date{font-size:13px;color:var(--muted);white-space:nowrap}
.meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
article{padding:22px 26px;border:1px solid var(--line);border-radius:14px;background:var(--panel);line-height:1.65}
article p{margin:0 0 12px}article ul,article ol{margin:0 0 12px;padding-left:22px}
article code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;color:#c7cbe0;background:#0f1117;border:1px solid var(--line);border-radius:5px;padding:0 5px}
article pre{margin:0 0 14px;padding:12px 14px;overflow-x:auto;background:#0f1117;border:1px solid var(--line);border-radius:10px}
article pre code{border:0;padding:0;background:none;white-space:pre}
article blockquote{margin:0 0 12px;padding:2px 14px;border-left:3px solid var(--accent);color:#a3a8b8}
article hr{border:0;border-top:1px solid var(--line);margin:18px 0}
.tablewrap{overflow-x:auto;margin:0 0 14px}
article table{border-collapse:collapse;font-size:14px}article th,article td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
article th{color:var(--teal);background:var(--panel2)}
dl.refs{margin:0;display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;font-size:14px}dl.refs dt{color:var(--muted)}dl.refs dd{margin:0}
@media(max-width:700px){main.docs{padding:22px 16px 60px}.top{padding:12px 16px}}`;

function docsShell(title: string, basePath: string, user: DocsUser, body: string): string {
  const base = esc(basePath);
  return shell(
    title,
    `<header class="top"><a class="brand" href="${base}/">Mnemosyne</a>
  <div class="right">${user.admin ? topBtn(`${base}/admin/`, 'Admin', ICON_WRENCH, 'Open the admin area') : ''}<span>${esc(user.name)} <span>@${esc(user.username)}</span></span>
  <form method="post" action="${base}/auth/logout"><button class="btn small" type="submit">Sign out</button></form></div></header>
<main class="docs">${body}</main>`,
    DOCS_CSS,
  );
}

export function homePage(v: { basePath: string; user: DocsUser; cards: ProjectCard[]; notice?: string; isAdmin: boolean }): string {
  // the ring in the corner is the project's ID in GitLab ("-" when no GitLab project matches)
  const card = (c: ProjectCard) => `<a class="card" href="${esc(c.href)}" title="${c.glId !== undefined ? `GitLab project ID ${c.glId}` : 'No GitLab project'}">
    <span class="c" aria-label="GitLab project ID">${c.glId !== undefined ? c.glId : '–'}</span>
    <span class="t">${esc(c.title)}</span><span class="s">${esc(c.sub)}</span>
    <span class="n">${c.count === 0 ? 'no notes yet' : `${c.count} ${c.count === 1 ? 'note' : 'notes'}`}${c.updated ? ` · updated ${esc(c.updated)}` : ''}</span>
    ${c.adminOnly ? '<span class="badge admin">administrators only</span>' : ''}</a>`;

  // five cards per row (easier to count); fewer on narrower windows
  const body = `<style>main.docs{max-width:1760px}.grid{grid-template-columns:repeat(5,minmax(0,1fr))}@media(max-width:1500px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}}@media(max-width:1150px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:800px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:520px){.grid{grid-template-columns:1fr}}</style><h1>Your projects</h1>
<p class="lead">Documentation for the projects you belong to in GitLab${v.isAdmin ? ' — as a GitLab administrator you see every project' : ''}.${v.cards.length ? ` <b>${v.cards.length} projects.</b>` : ''}</p>
${v.notice ? `<div class="notice">${esc(v.notice)}</div>` : ''}
${v.cards.length ? `<div class="grid">${v.cards.map((c) => card(c)).join('')}</div>` : v.notice ? '' : '<div class="notice">No documentation exists yet for the projects you belong to.</div>'}`;
  return docsShell('Mnemosyne', v.basePath, v.user, body);
}

const TYPE_TITLES: Record<string, string> = {
  decision: 'Decisions',
  howto: 'How-tos',
  gotcha: 'Gotchas',
  status: 'Status',
  reference: 'Reference',
};

export interface NoteRow {
  id: string;
  title: string;
  type: string;
  status: string;
  observed_at: string | null;
}

export function notesPage(v: { basePath: string; user: DocsUser; project: string; subtitle: string; q: string; notes: NoteRow[]; total: number }): string {
  const base = esc(v.basePath);
  const enc = encodeURIComponent(v.project);
  const groups = new Map<string, NoteRow[]>();
  for (const n of v.notes) groups.set(n.type, [...(groups.get(n.type) ?? []), n]);
  const order = ['decision', 'howto', 'gotcha', 'status', 'reference'].filter((t) => groups.has(t));
  const sections = order
    .map(
      (t) => `<h2>${esc(TYPE_TITLES[t] ?? t)} <span class="muted">(${groups.get(t)!.length})</span></h2>
<ul class="notes">${groups
        .get(t)!
        .map(
          (n) => `<li><a href="${base}/p/${enc}/${encodeURIComponent(n.id)}">${esc(n.title)}</a>
<span class="badge ${esc(n.status)}">${esc(n.status)}</span><span class="date">${esc(n.observed_at ?? '')}</span></li>`,
        )
        .join('')}</ul>`,
    )
    .join('\n');
  const body = `<div class="crumbs"><a href="${base}/">Projects</a> / ${esc(v.project)}</div>
<h1>${esc(v.project)}</h1>
<p class="lead">${esc(v.subtitle)}</p>
<form class="search" method="get" action="${base}/p/${enc}"><input name="q" value="${esc(v.q)}" placeholder="Search this project's notes…" maxlength="200"><button class="btn" type="submit">Search</button></form>
${v.q ? `<p class="lead">${v.notes.length} of ${v.total} notes match “${esc(v.q)}”.</p>` : `<p class="lead">${v.total} notes.</p>`}
${sections || '<div class="notice">No notes found.</div>'}`;
  return docsShell(`${v.project} · Mnemosyne`, v.basePath, v.user, body);
}

export function nodePage(v: {
  basePath: string;
  user: DocsUser;
  project: string;
  title: string;
  type: string;
  status: string;
  observedAt: string | null;
  components: string[];
  authors: string[];
  bodyHtml: string;
  links: { rel: string; id: string; title: string | null }[];
  codeRefs: string[];
}): string {
  const base = esc(v.basePath);
  const enc = encodeURIComponent(v.project);
  const links = v.links.length
    ? `<h2>Related</h2><dl class="refs">${v.links
        .map((l) => `<dt>${esc(l.rel)}</dt><dd>${l.title ? `<a href="${base}/p/${enc}/${encodeURIComponent(l.id)}">${esc(l.title)}</a>` : `<span class="muted">${esc(l.id)} (not in this project)</span>`}</dd>`)
        .join('')}</dl>`
    : '';
  const refs = v.codeRefs.length ? `<h2>Code</h2><dl class="refs">${v.codeRefs.map((r) => `<dt>file</dt><dd><code>${esc(r)}</code></dd>`).join('')}</dl>` : '';
  const body = `<div class="crumbs"><a href="${base}/">Projects</a> / <a href="${base}/p/${enc}">${esc(v.project)}</a></div>
<h1>${esc(v.title)}</h1>
<div class="meta"><span class="badge">${esc(TYPE_TITLES[v.type] ?? v.type)}</span><span class="badge ${esc(v.status)}">${esc(v.status)}</span>${v.observedAt ? `<span class="date">observed ${esc(v.observedAt)}</span>` : ''}${v.components.map((c) => `<span class="badge">${esc(c)}</span>`).join('')}</div>
<article>${v.bodyHtml}</article>
${links}${refs}
${v.authors.length ? `<p class="lead">Recorded by ${esc(v.authors.join(', '))}</p>` : ''}`;
  return docsShell(`${v.title} · Mnemosyne`, v.basePath, v.user, body);
}

export function docsNotFound(basePath: string, user: DocsUser, message: string): string {
  return docsShell('Not found · Mnemosyne', basePath, user, `<h1>Not available</h1><div class="notice">${esc(message)}</div><p><a class="btn" href="${esc(basePath)}/">Back to your projects</a></p>`);
}

// ----------------------------------------------------------------------------
// Project home: blank by default; shows the generated article, diagram and PDF once they exist.
// AI actions (administrators only) always go through an explicit agreement popup.
// ----------------------------------------------------------------------------
export interface ProjectHomeView {
  basePath: string;
  nonce: string;
  user: DocsUser;
  project: string;
  subtitle: string;
  isAdmin: boolean;
  /** Text and image models are chosen in Admin → LLM; the buttons explain what is missing. */
  wiki: { meta: DocMeta; html: string; toc: { level: number; text: string; id: string }[] } | null;
  /** The newest notes (built by the server, not the AI). */
  history: HistoryEntry[];
  glUrl: string | null;
  wikiVersions: DocMeta[];
  diagram: DocMeta | null;
  diagramVersions: DocMeta[];
  pdf: DocMeta | null;
  pdfVersions: DocMeta[];
  /** A generation is already running for this project. */
  busy: string | null;
}

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

const HOME_CSS = `
.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn.primary:hover{background:var(--accent-h)}
.btn[disabled]{opacity:.45;cursor:not-allowed}.btn[disabled]:hover{border-color:var(--line)}
.btn.ai::after{content:"AI";margin-left:8px;padding:0 6px;border-radius:99px;border:1px solid currentColor;font-size:10px;letter-spacing:.5px}
.blank{display:flex;flex-direction:column;align-items:center;gap:8px;padding:70px 20px;border:1px dashed var(--line);border-radius:14px;color:var(--muted);text-align:center}
.blank strong{color:var(--text);font-size:18px}
.banner{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;padding:12px 16px;border:1px solid var(--line);border-radius:12px;background:var(--panel2);font-size:13.5px;color:var(--muted)}
.banner b{color:var(--text)}
.toc{padding:14px 18px;border:1px solid var(--line);border-radius:12px;background:var(--panel2);max-width:420px}
.toc strong{color:var(--teal)}.toc ol,.toc ul{margin:6px 0 0;padding-left:18px}.toc li{margin:2px 0;font-size:14px}.toc a{color:var(--text);text-decoration:none}.toc a:hover{color:var(--teal)}
.toc ul{padding-left:16px;list-style:circle;color:var(--muted)}
.wp{margin-top:18px}
/* Wikipedia layout, ONE scrollbar (the page's): the info box floats at the top right INSIDE the article card and the text flows around it,
   then continues over the full width below it. No sticky column, no inner scrollbar. */
.wp article{display:flow-root}
.side{float:right;width:310px;margin:0 0 18px 26px;display:flex;flex-direction:column;gap:16px;line-height:1.5}
@media(max-width:900px){.side{float:none;width:auto;margin:0 0 18px}}
.card{border:1px solid var(--line);border-radius:12px;background:var(--panel2);overflow:hidden}
.contents{padding:12px 16px 14px}.contents strong{color:var(--title);font:600 16px/1.2 "Palatino Linotype","Book Antiqua",Palatino,Georgia,serif}.contents ol,.contents ul{margin:8px 0 0;padding-left:18px}.contents li{margin:3px 0;font-size:13.5px}.contents ul{list-style:circle;color:var(--muted)}.contents a{color:var(--text);text-decoration:none}.contents a:hover{color:var(--teal)}
.card h3{margin:0;padding:11px 14px;text-align:center;font:600 18px/1.2 "Palatino Linotype","Book Antiqua",Palatino,Georgia,serif;color:var(--title);border-bottom:1px solid var(--line)}
.card .pic{display:block;margin:12px;padding:6px;border-radius:8px;background:#fff;cursor:zoom-in}
.card .pic img{display:block;width:100%;height:auto}
.card .cap{margin:0 12px 12px;font-size:12px;color:var(--muted);text-align:center}
.card .noimg{margin:12px;padding:30px 12px;border:1px dashed var(--line);border-radius:8px;text-align:center;color:var(--muted);font-size:13px}
.card .subs{margin:0 12px 12px;display:flex;flex-direction:column;gap:8px}.card .subs .cap{margin:2px 0 0}.card .pic.sub{margin:0;padding:4px}.card .pic.sub span{display:block;margin-top:4px;font-size:12px;color:#33384a;text-align:center}
.card dl{margin:0;padding:4px 14px 12px;font-size:13px}.card dt{margin-top:9px;color:var(--teal);font-weight:600}.card dd{margin:2px 0 0;color:var(--text);overflow-wrap:anywhere}
.card a{color:var(--teal)}
.wp article h2{margin:34px 0 14px;padding-bottom:6px;border-bottom:1px solid var(--line);font:600 25px/1.25 "Palatino Linotype","Book Antiqua",Palatino,Georgia,serif;color:var(--title);scroll-margin-top:16px}
.wp article h3{margin:24px 0 6px;font-size:18px;color:var(--teal);scroll-margin-top:16px}
.wp article>h2:first-of-type{margin-top:6px}
hr.rule{border:0;border-top:1px solid var(--line);margin:34px 0 8px}
.hist table{width:100%;border-collapse:collapse;font-size:13.5px}.hist th,.hist td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.hist th{color:var(--teal);font-weight:600}.hist td:first-child{white-space:nowrap;color:var(--muted)}
#lightbox{position:fixed;inset:0;z-index:60;background:rgba(5,6,10,.88);display:flex;align-items:center;justify-content:center;padding:24px;cursor:zoom-out}
#lightbox[hidden]{display:none}#lightbox img{max-width:100%;max-height:100%;background:#fff;border-radius:8px}
.versions{font-size:13px;color:var(--muted)}.versions a{margin-right:10px}
.overlay{position:fixed;inset:0;background:rgba(5,6,10,.72);display:flex;align-items:center;justify-content:center;padding:20px;z-index:50}
.overlay[hidden]{display:none}
.modal{width:100%;max-width:560px;border:1px solid var(--line);border-radius:16px;background:var(--panel);padding:26px;box-shadow:0 30px 80px rgba(0,0,0,.6)}
.modal h2{margin:0 0 10px;font:600 24px/1.2 "Palatino Linotype","Book Antiqua",Palatino,Georgia,serif;color:var(--title)}
.modal p{margin:8px 0;color:#c9cdda;font-size:14.5px}
.modal .facts{margin:14px 0;padding:12px 14px;border-radius:10px;background:var(--panel2);border:1px solid var(--line);font-size:14px}
.modal .facts div{display:flex;justify-content:space-between;gap:14px;padding:3px 0}.modal .facts span:first-child{color:var(--muted)}
.modal .warn{color:#f0c36a}
.modal label{display:flex;gap:10px;align-items:flex-start;margin:16px 0;font-size:14.5px;color:var(--text);cursor:pointer}
.modal label input{margin-top:3px;width:18px;height:18px;accent-color:#7a66e0}
.modal .row{display:flex;justify-content:flex-end;gap:10px}
.spin{display:inline-block;width:16px;height:16px;border:2px solid var(--line);border-top-color:var(--teal);border-radius:50%;animation:sp 1s linear infinite;vertical-align:-3px;margin-right:8px}
@keyframes sp{to{transform:rotate(360deg)}}
#status{min-height:22px;font-size:14px}.ok{color:#4ade80}.err{color:#ff8b8b}`;

export function projectHome(v: ProjectHomeView): string {
  const base = esc(v.basePath);
  const enc = encodeURIComponent(v.project);
  const api = `${v.basePath}/p/${enc}/api`;
  const has = Boolean(v.wiki);
  const vers = (items: DocMeta[], path: string, label: string) =>
    items.length > 1
      ? `<p class="versions">Earlier ${label}: ${items
          .slice(1, 8)
          .map((m) => `<a href="${path}${esc(m.id)}">${esc(when(m.generatedAt))}</a>`)
          .join('')}</p>`
      : '';

  const hist = `<hr class="rule"><section class="hist"><h2 id="h-change-history">Change history</h2><p class="versions">The ${v.history.length} most recently submitted notes, newest first, show what was changed or deployed last. ${v.isAdmin ? `Open a note, or search all of them under <a href="${base}/p/${enc}/notes">Source notes</a>, for the details.` : 'An administrator can open the source notes for the details.'}</p><table><thead><tr><th>Date (UTC)</th><th>Note</th><th>Type</th></tr></thead><tbody>${v.history
    .map((e) => `<tr><td>${esc(e.date)}</td><td>${v.isAdmin ? `<a href="${base}/p/${enc}/${encodeURIComponent(e.id)}">${esc(e.title)}</a>` : esc(e.title)}</td><td>${esc(e.type)}</td></tr>`)
    .join('')}</tbody></table></section>`;

  const contents = v.wiki
    ? (() => {
        const groups: { id: string; text: string; subs: { id: string; text: string }[] }[] = [];
        for (const t of v.wiki.toc) {
          if (t.level === 2) groups.push({ id: t.id, text: t.text, subs: [] });
          else if (t.level === 3 && groups.length) groups[groups.length - 1]!.subs.push({ id: t.id, text: t.text });
        }
        groups.push({ id: 'h-change-history', text: 'Change history', subs: [] });
        const link = (g: { id: string; text: string }) => `<a href="#${esc(g.id)}">${esc(g.text)}</a>`;
        return `<nav class="card contents"><strong>Contents</strong><ol>${groups
          .map((g) => `<li>${link(g)}${g.subs.length ? `<ul>${g.subs.map((x) => `<li>${link(x)}</li>`).join('')}</ul>` : ''}</li>`)
          .join('')}</ol></nav>`;
      })()
    : '';

  const card = v.wiki
    ? `<aside class="side"><div class="card"><h3>${esc(v.project)}</h3>${
        v.diagram
          ? `<a class="pic" id="pic" href="${base}/p/${enc}/diagram/${esc(v.diagram.id)}" target="_blank" rel="noopener"><img src="${base}/p/${enc}/diagram/${esc(v.diagram.id)}" alt="Workflow diagram of ${esc(v.project)}"></a><p class="cap">Workflow diagram · click to enlarge<br>created ${esc(when(v.diagram.generatedAt))} by ${esc(v.diagram.model)}</p>${(v.diagram.pictures ?? []).length ? `<div class="subs"><p class="cap">Detail pictures · click to enlarge</p>${(v.diagram.pictures ?? []).map((p, i) => `<a class="pic sub" href="${base}/p/${enc}/diagram/${esc(v.diagram!.id)}/${i + 1}" target="_blank" rel="noopener"><img src="${base}/p/${enc}/diagram/${esc(v.diagram!.id)}/${i + 1}" alt="${esc(p.name)} diagram of ${esc(v.project)}"><span>${esc(p.name)}</span></a>`).join('')}</div>` : ''}${vers(v.diagramVersions, `${base}/p/${enc}/diagram/`, 'diagrams')}`
          : `<div class="noimg">Workflow diagram<br>not created yet${v.isAdmin ? '<br>Use “Create workflow diagram” above.' : ''}</div>`
      }<dl><dt>Documentation</dt><dd>${esc(when(v.wiki.meta.generatedAt))}</dd><dt>Written by</dt><dd>${esc(v.wiki.meta.model)}</dd><dt>Source notes</dt><dd>${v.wiki.meta.noteCount ?? '?'} notes</dd><dt>Latest note</dt><dd>${esc(v.history[0]?.date ?? 'unknown')} UTC</dd>${v.glUrl ? `<dt>GitLab project</dt><dd><a href="${esc(v.glUrl)}" rel="noopener noreferrer">${esc(v.glUrl.replace(/^https?:\/\//, ''))}</a></dd>` : ''}</dl></div>${contents}</aside>`
    : '';

  const article = v.wiki
    ? `<div class="banner"><span><b>Documentation</b> generated <b>${esc(when(v.wiki.meta.generatedAt))}</b></span><span>by ${esc(v.wiki.meta.model)}</span><span>from ${v.wiki.meta.noteCount ?? '?'} project notes</span></div>
${v.wikiVersions.length > 1 ? `<p class="versions">Other versions: ${v.wikiVersions.slice(0, 8).map((m, i) => (m.id === v.wiki!.meta.id ? `<b>${esc(when(m.generatedAt))}</b>` : `<a href="${base}/p/${enc}?v=${esc(m.id)}">${esc(when(m.generatedAt))}${i === 0 ? ' (latest)' : ''}</a>`)).join(' · ')}</p>` : ''}
<div class="wp"><div class="main"><article>${card}${v.wiki.html}</article>${hist}</div></div>
${v.diagram ? `<div id="lightbox" hidden><img alt="Workflow diagram of ${esc(v.project)}"></div>` : ''}`
    : `<div class="blank"><strong>No documentation has been generated yet</strong><span>${v.isAdmin ? 'Use “Generate documentation” to write the project page from all its notes.' : 'An administrator can generate it from the project notes.'}</span></div>`;

  const pdfLine = v.pdf
    ? `<p class="versions">Project PDF · created <b>${esc(when(v.pdf.generatedAt))}</b> · <a href="${base}/p/${enc}/pdf/${esc(v.pdf.id)}">Download PDF</a>${vers(v.pdfVersions, `${base}/p/${enc}/pdf/`, 'PDFs').replace(/^<p class="versions">/, ' · ').replace(/<\/p>$/, '')}</p>`
    : '';

  const body = `<div class="crumbs"><a href="${base}/">Projects</a> / ${esc(v.project)}</div>
<h1>${esc(v.project)}</h1>
<p class="lead">${esc(v.subtitle)}</p>
<div class="actions">
  ${v.isAdmin ? `<button class="btn primary ai" type="button" data-ai="wiki"${v.busy ? ' disabled' : ''}>${has ? 'Regenerate documentation' : 'Generate documentation'}</button>
  <button class="btn ai" type="button" data-ai="diagram"${has && !v.busy ? '' : ' disabled'} title="${has ? '' : 'Generate the documentation first'}">Create workflow diagram</button>` : ''}
  <button class="btn" type="button" id="pdfBtn"${has && !v.busy ? '' : ' disabled'} title="${has ? '' : 'Becomes active once the documentation exists'}">Create project PDF</button>
  ${v.isAdmin ? `<a class="btn" href="${base}/p/${enc}/notes">Source notes</a>` : ''}
</div>
<div id="status">${v.busy ? `<span class="spin"></span>Working on it (${esc(v.busy)})… this page updates when it is done.` : ''}</div>
${pdfLine}
${article}
<div class="overlay" id="consent" hidden role="dialog" aria-modal="true" aria-labelledby="cTitle"><div class="modal">
  <h2 id="cTitle">Use AI to generate this?</h2>
  <p id="cWhat"></p>
  <div class="facts" id="cFacts"></div>
  <p class="warn">This calls an external AI service and <strong>costs money</strong>. Nothing is sent or spent unless you agree below.</p>
  <label><input type="checkbox" id="cAgree"><span>I agree to use AI to generate this and accept the estimated cost.</span></label>
  <div class="row"><button class="btn" type="button" id="cCancel">Cancel</button><button class="btn primary" type="button" id="cGo" disabled>Generate with AI</button></div>
</div></div>
<script nonce="${esc(v.nonce)}">${HOME_JS(api, v.busy)}</script>`;
  return shell(`${v.project} · Mnemosyne`, docsShellBody(v.basePath, v.user, body), DOCS_CSS + HOME_CSS);
}

function docsShellBody(basePath: string, user: DocsUser, body: string): string {
  const base = esc(basePath);
  return `<header class="top"><a class="brand" href="${base}/">Mnemosyne</a>
  <div class="right">${user.admin ? topBtn(`${base}/admin/`, 'Admin', ICON_WRENCH, 'Open the admin area') : ''}<span>${esc(user.name)} <span>@${esc(user.username)}</span></span>
  <form method="post" action="${base}/auth/logout"><button class="btn small" type="submit">Sign out</button></form></div></header>
<main class="docs">${body}</main>`;
}

function HOME_JS(api: string, busy: string | null): string {
  return `
(function(){
  var API=${JSON.stringify(api)};
  var $=function(id){return document.getElementById(id)};
  var pending=null,poll=null;
  function call(method,path,body){
    return fetch(API+path,{method:method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-Requested-With':'mnemosyne-docs'},body:body?JSON.stringify(body):undefined})
      .then(function(r){return r.json().catch(function(){return {}}).then(function(j){if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j})});
  }
  function status(t,cls){var s=$('status');s.className=cls||'';s.textContent=t||''}
  function working(t){var s=$('status');s.className='';s.innerHTML='<span class="spin"></span>';s.appendChild(document.createTextNode(t))}
  function row(k,v){var d=document.createElement('div'),a=document.createElement('span'),b=document.createElement('span');a.textContent=k;b.textContent=v;d.appendChild(a);d.appendChild(b);return d}
  function closeModal(){$('consent').hidden=true;$('cAgree').checked=false;$('cGo').disabled=true;pending=null}

  // 1) ask the server what this would do and cost; the answer carries the one-time consent token
  Array.prototype.forEach.call(document.querySelectorAll('[data-ai]'),function(b){
    b.addEventListener('click',function(){
      var kind=b.getAttribute('data-ai');status('');
      call('GET','/estimate?kind='+kind).then(function(e){
        pending={kind:kind,token:e.token};
        $('cWhat').textContent=e.what;
        var f=$('cFacts');f.textContent='';
        e.facts.forEach(function(x){f.appendChild(row(x[0],x[1]))});
        $('consent').hidden=false;$('cAgree').focus();
      }).catch(function(err){status(err.message,'err')});
    });
  });
  $('cAgree').addEventListener('change',function(){$('cGo').disabled=!$('cAgree').checked});
  $('cCancel').addEventListener('click',closeModal);
  $('consent').addEventListener('click',function(ev){if(ev.target===$('consent'))closeModal()});
  document.addEventListener('keydown',function(ev){if(ev.key==='Escape'&&!$('consent').hidden)closeModal()});

  // 2) only after the person ticked "I agree" and pressed the button is anything started
  $('cGo').addEventListener('click',function(){
    if(!pending||!$('cAgree').checked)return;
    var p=pending;closeModal();
    working('Generating with AI… this can take a few minutes. You can leave this page open.');
    call('POST','/generate',{kind:p.kind,token:p.token}).then(watch).catch(function(err){status(err.message,'err')});
  });
  function watch(){
    clearInterval(poll);
    poll=setInterval(function(){
      call('GET','/status').then(function(s){
        if(s.state==='running'){working('Working on it ('+s.kind+')… '+s.seconds+' s')}
        else{clearInterval(poll);if(s.state==='error'){status(s.error,'err')}else if(s.warning){status(s.warning,'err')}else{status('Done. Reloading…','ok');location.reload()}}
      }).catch(function(){});
    },3000);
  }
  ${busy ? 'watch();' : ''}

  // click the small diagram to see it large
  var pics=document.querySelectorAll('a.pic'),lb=$('lightbox');
  if(pics.length&&lb){
    pics.forEach(function(pic){pic.addEventListener('click',function(ev){ev.preventDefault();lb.querySelector('img').src=pic.getAttribute('href');lb.hidden=false})});
    lb.addEventListener('click',function(){lb.hidden=true});
    document.addEventListener('keydown',function(ev){if(ev.key==='Escape')lb.hidden=true});
  }

  // PDF: no AI, no cost
  var pb=$('pdfBtn');
  if(pb)pb.addEventListener('click',function(){
    pb.disabled=true;working('Building the PDF…');
    call('POST','/pdf',{}).then(function(){status('PDF created. Reloading…','ok');location.reload()}).catch(function(err){status(err.message,'err');pb.disabled=false});
  });
})();`;
}
