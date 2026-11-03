// SPDX-License-Identifier: Apache-2.0
/** HTML for the web portal. Dark theme, no external assets, no inline handlers. */

import { esc } from './html.js';
import type { DocMeta, HistoryEntry } from './docgen.js';
import { shownVersion } from './version.js';
import type { TokenInfo } from './token-store.js';
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
body{position:relative;min-height:100vh;padding-bottom:56px}
.site-foot{position:absolute;left:0;right:0;bottom:0;padding:0 16px 20px;text-align:center;color:var(--muted);font-size:12.5px}
.site-foot span{margin:0 6px;opacity:.6}
`;

/** The line at the bottom of every page: "2026 © LSE Group Corporation | Version 0.6". */
export function siteFooter(year = new Date().getFullYear()): string {
  return `<div class="site-foot">${year} &copy; LSE Group Corporation <span aria-hidden="true">|</span>Version ${esc(shownVersion())}</div>`;
}

function shell(title: string, body: string, extraCss = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>${CSS}${extraCss}</style></head><body>${body}${siteFooter()}</body></html>`;
}

export interface LoginView {
  basePath: string;
  /** Portal is switched on (secret and public URL set). */
  configured: boolean;
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
  nosso: 'GitLab sign-in is not set up yet.',
};

export function loginPage(v: LoginView): string {
  const base = esc(v.basePath);
  let action: string;
  if (v.user) {
    action = `<p class="who">Signed in as <strong>${esc(v.user.name)}</strong> <span class="muted">@${esc(v.user.username)}</span></p>
      <form method="post" action="${base}/auth/logout"><button class="btn" type="submit">Sign out</button></form>`;
  } else if (v.configured && v.sso) {
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
      <p class="tag">Self-hosted AI team memory</p>
      ${err}
      ${action}
    </section>
    <footer>MCP clients connect to <code>${base}/mcp</code></footer>
  </div>
</main>`,
    // Palette sampled from the approved mockup: near-black base, violet glow left, teal glow right.
    `:root{--bg:#0d0e13;--panel:#161922;--line:#262a36;--text:#e6e9ef;--muted:#8b90a0;--accent:#7a66e0;--accent-h:#9482ee}
html,body{background:var(--bg)}
body{padding-bottom:0}
.site-foot{position:fixed;left:0;right:0;bottom:12px;padding:0;z-index:3;pointer-events:none}
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

// Same palette as the login screen: near-black base, violet main titles, turquoise second-level titles.
const ICON_WRENCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
/** Header buttons that flip between the user area and the admin area (each area keeps its own sign-in). */
const topBtn = (href: string, label: string, icon: string, title: string) => `<a class="topbtn" href="${href}" title="${esc(title)}">${icon}<span>${esc(label)}</span></a>`;
const TOPBTN_CSS = '.topbtn{display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);color:var(--text);font-size:14px;text-decoration:none;white-space:nowrap}.topbtn:hover{border-color:var(--accent);color:#fff}.topbtn svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]!.toUpperCase())
    .join('') || '?';

/** The signed-in person in the header. A click opens a card (no script needed: a details element) with a link to their profile. */
const userMenu = (base: string, user: { name: string; username: string }, role: string, profile: boolean) => `<details class="usermenu">
    <summary title="Your account"><span class="avatar" aria-hidden="true">${esc(initials(user.name))}</span><span class="uname">${esc(user.name)} <span>@${esc(user.username)}</span></span></summary>
    <div class="usercard">
      <div class="uc-head"><span class="avatar big" aria-hidden="true">${esc(initials(user.name))}</span><div><strong>${esc(user.name)}</strong><span class="at">@${esc(user.username)}</span></div></div>
      <span class="upill">${esc(role)}</span>
      ${profile ? `<a class="btn primary" href="${base}/profile">Profile</a>` : '<p class="uc-note">This built-in account has no GitLab profile, so it cannot hold an MCP token.</p>'}
    </div>
  </details>`;
const USERMENU_CSS = `.usermenu{position:relative}
.usermenu summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:9px;padding:4px 10px 4px 5px;border:1px solid transparent;border-radius:10px;color:var(--text)}
.usermenu summary::-webkit-details-marker{display:none}
.usermenu summary:hover,.usermenu[open] summary{border-color:var(--line);background:var(--panel2)}
.usermenu summary:after{content:"";width:6px;height:6px;margin:-3px 0 0 2px;border-right:1.6px solid var(--muted);border-bottom:1.6px solid var(--muted);transform:rotate(45deg)}
.usermenu[open] summary:after{margin-top:3px;transform:rotate(225deg)}
.uname span{color:var(--muted)}
.avatar{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;font-size:11px;font-weight:700;letter-spacing:.3px}
.avatar.big{width:46px;height:46px;font-size:17px;flex:none}
.usercard{position:absolute;right:0;top:calc(100% + 8px);z-index:30;width:300px;max-width:calc(100vw - 32px);padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--panel);box-shadow:0 14px 36px rgba(0,0,0,.5);color:var(--text)}
.uc-head{display:flex;align-items:center;gap:12px;margin-bottom:10px}.uc-head strong{display:block;font-size:15px}.uc-head .at{color:var(--muted);font-size:13px}
.upill{display:inline-block;padding:2px 10px;border-radius:99px;border:1px solid var(--line);color:var(--muted);font-size:12px}
.usercard .btn{display:flex;justify-content:center;width:100%;margin-top:14px}.usercard .btn.primary{color:#fff}
.uc-note{margin:12px 0 0;color:var(--muted);font-size:13px}`;

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
${USERMENU_CSS}
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
  <div class="right">${user.admin ? topBtn(`${base}/admin/`, 'Admin', ICON_WRENCH, 'Open the admin area') : ''}${userMenu(base, user, user.admin ? 'GitLab administrator' : 'Member', true)}
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
  <div class="right">${user.admin ? topBtn(`${base}/admin/`, 'Admin', ICON_WRENCH, 'Open the admin area') : ''}${userMenu(base, user, user.admin ? 'GitLab administrator' : 'Member', true)}
  <form method="post" action="${base}/auth/logout"><button class="btn small" type="submit">Sign out</button></form></div></header>
<main class="docs">${body}</main>`;
}

// ============================================================================
// Profile: who the signed-in person is, and their personal MCP tokens.
// ============================================================================

export interface ProfileView {
  basePath: string;
  nonce: string;
  user: DocsUser;
  details: {
    /** Empty when GitLab did not share it. */
    email: string;
    admin: boolean;
    /** GitLab projects the person belongs to; null when GitLab did not share the list. */
    projects: number | null;
    /** Epoch ms of the last check against GitLab. */
    verifiedAt: number;
    /** Epoch ms the sign-in cookie runs out. */
    signedInUntil: number;
    gitlabProfile: string | null;
  };
  /** The address MCP clients connect to. */
  mcpUrl: string;
  tokens: TokenInfo[] | null;
  /** The longest a token may live. */
  maxDays: number;
}

const PROFILE_CSS = `
.pcard{padding:22px 26px;border:1px solid var(--line);border-radius:14px;background:var(--panel);box-shadow:0 14px 40px rgba(0,0,0,.22)}
.pcard h2{margin:0 0 12px}
.pcard p{margin:0 0 12px;color:#a3a8b8}
.pcard code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;color:#c7cbe0;background:#0f1117;border:1px solid var(--line);border-radius:5px;padding:0 5px}
.pcard dl.refs{gap:8px 18px}
.pwho{display:flex;align-items:center;gap:16px;margin-bottom:16px}.pwho .avatar{width:56px;height:56px;font-size:21px}
.pwho strong{display:block;font-size:18px}.pwho span.at{color:var(--muted)}
.tokform{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin:4px 0 16px}
.tokform label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
.tokform input,.tokform select{padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:#0f1117;color:var(--text);font:inherit}
.tokform input{width:280px;max-width:100%}.tokform input:focus,.tokform select:focus{outline:none;border-color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn.primary:hover{background:var(--accent-h)}.btn:disabled{opacity:.5;cursor:not-allowed}
.toterr{color:#ffb4b4;font-size:14px;margin:0 0 10px}
.newtok{margin:0 0 18px;padding:16px 18px;border:1px solid #6b5420;border-radius:12px;background:#1a1710}
.newtok h3{margin:0 0 6px;color:#f0c36a}.newtok .row{display:flex;gap:8px;align-items:center;margin:8px 0}
.newtok input{flex:1;min-width:0;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:#0f1117;color:var(--text);font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.newtok pre{margin:6px 0 0;padding:10px 12px;overflow-x:auto;background:#0f1117;border:1px solid var(--line);border-radius:8px;font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#c7cbe0;white-space:pre-wrap;word-break:break-all}
.tablewrap table.tok{border-collapse:collapse;width:100%;font-size:14px}
table.tok th,table.tok td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
table.tok th{color:var(--teal);font-weight:600;white-space:nowrap}table.tok td.act{text-align:right}
.hintline{font-size:13px;color:var(--muted)}`;

export function profilePage(v: ProfileView): string {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const stamp = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const d = v.details;
  const status = (s: TokenInfo['status']) => (s === 'active' ? 'working' : s === 'revoked' ? 'broken' : '');
  const row = (t: TokenInfo) =>
    `<tr><td>${esc(t.name)}</td><td><code>mnm_${esc(t.hint)}…</code></td><td>${day(t.createdAt)}</td><td>${day(t.expiresAt)}</td><td>${t.lastUsedAt ? `${stamp(t.lastUsedAt)}${t.lastIp ? ` · ${esc(t.lastIp)}` : ''}` : 'never'}</td><td><span class="badge ${status(t.status)}">${t.status}</span></td><td class="act">${t.status === 'active' ? `<button class="btn small" type="button" data-revoke="${esc(t.id)}" data-name="${esc(t.name)}">Revoke</button>` : ''}</td></tr>`;
  const plain = v.mcpUrl.startsWith('http://');
  const tokens = v.tokens;
  const days = [v.maxDays, 60, 30, 7, 1].filter((n, i, all) => n <= v.maxDays && all.indexOf(n) === i);
  const tokenSection = tokens
    ? `<section class="pcard">
  <h2>MCP access</h2>
  <p>A personal token lets an MCP client (Claude Code, Cline, Continue, ...) work on this server as <strong>you</strong>. A token is valid for at most <strong>${v.maxDays} days</strong>, then you issue a new one, like a password you rotate. You can revoke it at any time.</p>
  <p>MCP address: <code>${esc(v.mcpUrl)}</code></p>
  ${plain ? '<p class="notice">This address is plain http. Anything sent over it, including a token, can be read on the network. Use https where you can.</p>' : ''}
  <div class="newtok" id="newBox" hidden>
    <h3>Your new token</h3>
    <p style="margin:0">Copy it now. It is shown <strong>only once</strong> and cannot be shown again. Valid until <strong id="newUntil"></strong>.</p>
    <div class="row"><input id="newTok" type="text" readonly aria-label="Your new MCP token"><button class="btn small" type="button" id="copyTok">Copy token</button></div>
    <p style="margin:10px 0 0">Claude Code:</p><pre id="newCmd"></pre>
    <p style="margin:10px 0 0">Other clients (JSON):</p><pre id="newJson"></pre>
    <div class="row"><button class="btn small" type="button" id="doneTok">I have copied it</button></div>
  </div>
  <form class="tokform" id="tokForm">
    <label>Name<input id="tokName" maxlength="60" placeholder="Claude Code on my laptop" autocomplete="off" required></label>
    <label>Valid for<select id="tokDays">${days.map((n, i) => `<option value="${n}"${i === 0 ? ' selected' : ''}>${n} day${n === 1 ? '' : 's'}${n === v.maxDays ? ' (maximum)' : ''}</option>`).join('')}</select></label>
    <button class="btn primary" type="submit" id="tokGo">Create token</button>
  </form>
  <p class="toterr" id="tokErr" hidden></p>
  <div class="tablewrap"><table class="tok"><thead><tr><th>Name</th><th>Token</th><th>Created</th><th>Expires</th><th>Last used</th><th>Status</th><th></th></tr></thead>
  <tbody id="tokBody">${tokens.map(row).join('')}</tbody></table></div>
  <p class="hintline" id="tokEmpty"${tokens.length ? ' hidden' : ''}>You have no tokens yet.</p>
</section>`
    : '<section class="pcard"><h2>MCP access</h2><p>Personal tokens are not available on this server.</p></section>';
  const body = `<h1>Your profile</h1>
<section class="pcard">
  <h2>Account</h2>
  <div class="pwho"><span class="avatar" aria-hidden="true">${esc(initials(v.user.name))}</span><div><strong>${esc(v.user.name)}</strong><span class="at">@${esc(v.user.username)}</span></div></div>
  <dl class="refs">
    <dt>Name</dt><dd>${esc(v.user.name)}</dd>
    <dt>Username</dt><dd>@${esc(v.user.username)}</dd>
    <dt>E-mail</dt><dd>${d.email ? esc(d.email) : '<span class="muted">GitLab did not share it</span>'}</dd>
    <dt>Role</dt><dd>${d.admin ? 'GitLab administrator' : 'Member'}</dd>
    <dt>GitLab projects</dt><dd>${d.projects === null ? '<span class="muted">GitLab did not share the list</span>' : d.projects}</dd>
    <dt>Checked with GitLab</dt><dd>${stamp(d.verifiedAt)}</dd>
    <dt>Signed in until</dt><dd>${stamp(d.signedInUntil)}</dd>
    ${d.gitlabProfile ? `<dt>GitLab profile</dt><dd><a href="${esc(d.gitlabProfile)}" rel="noopener noreferrer">${esc(d.gitlabProfile)}</a></dd>` : ''}
  </dl>
</section>
${tokenSection}
${tokens ? `<script nonce="${esc(v.nonce)}">${PROFILE_JS(`${v.basePath}/profile/api/tokens`, v.mcpUrl)}</script>` : ''}`;
  return shell('Your profile · Mnemosyne', docsShellBody(v.basePath, v.user, body), DOCS_CSS + PROFILE_CSS);
}

/** Embeds a value in a script as a JS string literal that cannot end the script element. */
const jsString = (s: string) => JSON.stringify(s).replace(/</g, '\\u003c');

function PROFILE_JS(api: string, mcpUrl: string): string {
  return `
(function(){
  var api=${jsString(api)},mcp=${jsString(mcpUrl)};
  var H={'Content-Type':'application/json','X-Requested-With':'mnemosyne-docs'};
  var $=function(id){return document.getElementById(id)};
  function day(ms){return new Date(ms).toISOString().slice(0,10)}
  function stamp(ms){return new Date(ms).toISOString().slice(0,16).replace('T',' ')+' UTC'}
  function cell(tr,text,cls){var td=document.createElement('td');td.textContent=text;if(cls)td.className=cls;tr.appendChild(td);return td}
  function fail(msg){var e=$('tokErr');e.textContent=msg;e.hidden=!msg}
  function copy(text,btn){
    var done=function(){var old=btn.textContent;btn.textContent='Copied';setTimeout(function(){btn.textContent=old},1500)};
    if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).then(done,function(){fail('Could not copy; select the text and copy it by hand.')});return}
    var f=$('newTok');f.focus();f.select();try{document.execCommand('copy');done()}catch(e){fail('Could not copy; select the text and copy it by hand.')}
  }
  function render(list){
    var body=$('tokBody');body.textContent='';
    $('tokEmpty').hidden=list.length>0;
    list.forEach(function(t){
      var tr=document.createElement('tr');
      cell(tr,t.name);
      var c=cell(tr,'');var code=document.createElement('code');code.textContent='mnm_'+t.hint+'\\u2026';c.appendChild(code);
      cell(tr,day(t.createdAt));cell(tr,day(t.expiresAt));
      cell(tr,t.lastUsedAt?stamp(t.lastUsedAt)+(t.lastIp?' \\u00b7 '+t.lastIp:''):'never');
      var s=cell(tr,'');var b=document.createElement('span');b.className='badge '+(t.status==='active'?'working':t.status==='revoked'?'broken':'');b.textContent=t.status;s.appendChild(b);
      var a=cell(tr,'','act');
      if(t.status==='active'){var r=document.createElement('button');r.type='button';r.className='btn small';r.textContent='Revoke';r.dataset.revoke=t.id;r.dataset.name=t.name;a.appendChild(r)}
      body.appendChild(tr);
    });
  }
  function call(url,method,body){
    return fetch(url,{method:method,headers:H,credentials:'same-origin',body:body?JSON.stringify(body):undefined})
      .then(function(r){return r.json().catch(function(){return {}}).then(function(j){return {ok:r.ok,j:j}})});
  }
  function revoke(id,name){
    if(!window.confirm('Revoke "'+name+'"? Every MCP client that uses it stops working.'))return;
    fail('');
    call(api+'/'+encodeURIComponent(id)+'/revoke','POST').then(function(x){
      if(!x.ok){fail(x.j.error||'Could not revoke the token.');return}
      render(x.j.tokens);
    }).catch(function(){fail('The server could not be reached.')});
  }
  function show(token,info){
    var cmd='claude mcp add --transport http mnemosyne '+mcp+' --header "Authorization: Bearer '+token+'"';
    var json=JSON.stringify({mcpServers:{mnemosyne:{type:'http',url:mcp,headers:{Authorization:'Bearer '+token}}}},null,2);
    $('newTok').value=token;$('newCmd').textContent=cmd;$('newJson').textContent=json;$('newUntil').textContent=day(info.expiresAt);
    $('newBox').hidden=false;$('newTok').focus();$('newTok').select();
  }
  function hide(){$('newTok').value='';$('newCmd').textContent='';$('newJson').textContent='';$('newBox').hidden=true}
  $('copyTok').addEventListener('click',function(){copy($('newTok').value,$('copyTok'))});
  $('doneTok').addEventListener('click',hide);
  $('tokForm').addEventListener('submit',function(e){
    e.preventDefault();fail('');
    var go=$('tokGo');go.disabled=true;
    call(api,'POST',{name:$('tokName').value,days:Number($('tokDays').value)}).then(function(x){
      go.disabled=false;
      if(!x.ok){fail(x.j.error||'Could not create the token.');return}
      $('tokName').value='';render(x.j.tokens);show(x.j.token,x.j.info);
    }).catch(function(){go.disabled=false;fail('The server could not be reached.')});
  });
  $('tokBody').addEventListener('click',function(e){
    var b=e.target.closest?e.target.closest('button[data-revoke]'):null;
    if(b)revoke(b.dataset.revoke,b.dataset.name);
  });
})();`;
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
