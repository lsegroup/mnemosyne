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
  /** Local admin account sign-in is available. */
  local: boolean;
  /** GitLab SSO is configured. */
  sso: boolean;
  /** Error key from `?error=`. */
  error?: string;
  /** Already signed in. */
  user?: { name: string; username: string; admin: boolean };
}

const ERRORS: Record<string, string> = {
  state: 'The sign-in attempt expired or was tampered with. Please try again.',
  denied: 'GitLab sign-in was cancelled or refused.',
  gitlab: 'GitLab could not be reached or rejected the sign-in. Please try again.',
  local: 'Wrong user name or password.',
  throttled: 'Too many attempts. Please wait a minute and try again.',
  nosso: 'GitLab sign-in is not set up yet.',
};

export function loginPage(v: LoginView): string {
  const base = esc(v.basePath);
  let action: string;
  if (v.user) {
    action = `<p class="who">Signed in as <strong>${esc(v.user.name)}</strong> <span class="muted">@${esc(v.user.username)}</span></p>
      ${
        v.user.admin
          ? `<a class="btn primary" href="${base}/admin/">Open admin</a>`
          : `<div class="notice">Your GitLab account has no admin rights on this Mnemosyne.</div>`
      }
      <form method="post" action="${base}/auth/logout"><button class="btn" type="submit">Sign out</button></form>`;
  } else if (v.configured && (v.sso || v.local)) {
    const sso = v.sso ? `<a class="btn primary" href="${base}/auth/login">Sign in with GitLab</a>` : '';
    const local = v.local
      ? `<form class="local" method="post" action="${base}/auth/local">
        <input name="username" autocomplete="username" placeholder="User name" required maxlength="100">
        <input name="password" type="password" autocomplete="current-password" placeholder="Password" required maxlength="200">
        <button class="btn${v.sso ? '' : ' primary'}" type="submit">Sign in</button></form>`
      : '';
    action = v.sso && v.local ? `${sso}<div class="or">or local admin</div>${local}` : sso + local;
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
  /** Callback URL to register in GitLab (Admin → Applications). */
  redirectUri: string;
}

const ADMIN_CSS = `
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 24px;border-bottom:1px solid var(--line);background:var(--panel)}
header .brand{font-weight:700;font-size:17px}header .right{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:14px}
header form{margin:0}
main{max-width:980px;margin:0 auto;padding:28px 24px 60px;display:flex;flex-direction:column;gap:26px}
h2{margin:0 0 4px;font-size:18px}.sub{margin:0 0 14px;color:var(--muted);font-size:14px}
section{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:22px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
td.actions{text-align:right;white-space:nowrap}td.actions .btn{margin-left:6px}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line);color:var(--muted)}
.badge.active{color:var(--ok);border-color:#1f5a38}
form.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
form.grid .full{grid-column:1/-1}
label{display:flex;flex-direction:column;gap:5px;font-size:13px;color:var(--muted)}
input,select{padding:9px 10px;border-radius:8px;border:1px solid var(--line);background:#0d1017;color:var(--text);font:inherit}
input:focus,select:focus{outline:none;border-color:var(--accent)}
.row{display:flex;gap:10px;align-items:center}
#msg{min-height:22px;font-size:14px}.ok{color:var(--ok)}.err{color:var(--danger)}
ul.plain{margin:0;padding-left:18px;color:var(--muted)}
@media(max-width:700px){form.grid{grid-template-columns:1fr}}`;

/** Admin shell; the interactive part lives in {@link ADMIN_JS}, run under the CSP nonce. */
export function adminPage(v: AdminView): string {
  const base = esc(v.basePath);
  const html = shell(
    'Mnemosyne admin',
    `<header>
  <span class="brand">Mnemosyne <span class="muted">admin</span></span>
  <div class="right"><span>${esc(v.user.name)} <span>@${esc(v.user.username)}</span></span>
  <form method="post" action="${base}/auth/logout"><button class="btn small" type="submit">Sign out</button></form></div>
</header>
<main>
  <section>
    <h2>LLM providers</h2>
    <p class="sub">Models Mnemosyne may connect to. API keys are stored encrypted on the server and are never shown again after saving.</p>
    <table><thead><tr><th>Name</th><th>API</th><th>Model</th><th>Key</th><th>Status</th><th></th></tr></thead>
      <tbody id="rows"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table>
  </section>
  <section>
    <h2 id="formTitle">Add provider</h2>
    <p class="sub">Presets fill the endpoint and a default model; adjust as needed.</p>
    <form id="form" class="grid" autocomplete="off">
      <label>Preset
        <select id="preset">
          <option value="">Custom</option>
          <option value="meta-openai">Meta Model API (OpenAI-compatible)</option>
          <option value="meta-anthropic">Meta Model API (Anthropic Messages)</option>
          <option value="openai">OpenAI</option>
          <option value="xai">xAI</option>
        </select></label>
      <label>Name<input id="label" required maxlength="80" placeholder="Meta Muse Spark"></label>
      <label>API format
        <select id="kind"><option value="openai-compatible">OpenAI-compatible</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
      <label>Model<input id="model" required maxlength="120" placeholder="muse-spark-1.3"></label>
      <label class="full">Base URL<input id="baseUrl" required maxlength="300" placeholder="https://api.meta.ai/v1"></label>
      <label class="full">API key<input id="apiKey" type="password" maxlength="500" placeholder="" autocomplete="new-password"></label>
      <div class="row full"><button class="btn primary" type="submit">Save provider</button>
        <button class="btn" type="button" id="cancel" hidden>Cancel edit</button><span id="msg"></span></div>
    </form>
  </section>
  <section>
    <h2>GitLab SSO</h2>
    <p class="sub">Lets GitLab users sign in with their GitLab account. In GitLab create an application (Admin → Applications) with scope <code>read_user</code>, tick <em>Trusted</em> so signed-in users are not asked again, and use this redirect URI:</p>
    <p class="sub"><code>${esc(v.redirectUri)}</code></p>
    <form id="ssoForm" class="grid" autocomplete="off">
      <label class="full">GitLab URL<input id="gitlabUrl" maxlength="300" placeholder="https://gitlab.example.com"></label>
      <label>Application ID<input id="clientId" maxlength="200"></label>
      <label>Secret<input id="clientSecret" type="password" maxlength="500" autocomplete="new-password"></label>
      <label class="full">GitLab admins <span class="muted">(user names or e-mails, comma separated; they may open this admin page after GitLab sign-in)</span><input id="adminUsers" maxlength="2000"></label>
      <div class="row full"><button class="btn primary" type="submit">Save GitLab SSO</button><span id="ssoMsg"></span></div>
    </form>
    <p class="sub" id="ssoState"></p>
  </section>
</main>
<script nonce="${esc(v.nonce)}">${ADMIN_JS(v.basePath)}</script>`,
    ADMIN_CSS,
  );
  return html;
}

const PRESETS = {
  'meta-openai': { label: 'Meta Muse Spark', kind: 'openai-compatible', baseUrl: 'https://api.meta.ai/v1', model: 'muse-spark-1.3' },
  'meta-anthropic': { label: 'Meta Muse Wonder', kind: 'anthropic-messages', baseUrl: 'https://api.meta.ai', model: 'muse-wonder-1.0' },
  openai: { label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  xai: { label: 'xAI', kind: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', model: 'grok-3-fast' },
};

function ADMIN_JS(basePath: string): string {
  return `
(function(){
  var API=${JSON.stringify(basePath + '/admin/api')};
  var PRESETS=${JSON.stringify(PRESETS)};
  var $=function(id){return document.getElementById(id)};
  var editing=null;
  function msg(t,ok){var m=$('msg');m.textContent=t||'';m.className=ok?'ok':'err'}
  function call(method,path,body){
    return fetch(API+path,{method:method,credentials:'same-origin',
      headers:{'Content-Type':'application/json','X-Requested-With':'mnemosyne-admin'},
      body:body?JSON.stringify(body):undefined}).then(function(r){
        return r.json().catch(function(){return {}}).then(function(j){
          if(r.status===401){location.href=${JSON.stringify(basePath + '/')};throw new Error('signed out')}
          if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j})})
  }
  function cell(tr,text,cls){var td=document.createElement('td');td.textContent=text;if(cls)td.className=cls;tr.appendChild(td);return td}
  function btn(label,cls,fn){var b=document.createElement('button');b.type='button';b.className='btn small '+cls;b.textContent=label;b.addEventListener('click',fn);return b}
  function render(data){
    var rows=$('rows');rows.textContent='';
    if(!data.providers.length){var tr=document.createElement('tr');cell(tr,'No providers configured yet.','muted').colSpan=6;rows.appendChild(tr);return}
    data.providers.forEach(function(p){
      var tr=document.createElement('tr');
      cell(tr,p.label);cell(tr,p.kind==='anthropic-messages'?'Anthropic':'OpenAI');cell(tr,p.model);
      cell(tr,p.hasKey?p.keyHint:'none');
      var st=cell(tr,'');var b=document.createElement('span');b.className='badge'+(p.id===data.activeId?' active':'');b.textContent=p.id===data.activeId?'active':'inactive';st.appendChild(b);
      var act=cell(tr,'','actions');
      if(p.id!==data.activeId)act.appendChild(btn('Activate','',function(){call('POST','/providers/'+p.id+'/activate').then(load).catch(function(e){msg(e.message)})}));
      act.appendChild(btn('Edit','',function(){startEdit(p)}));
      act.appendChild(btn('Delete','danger',function(){if(confirm('Delete provider "'+p.label+'"?'))call('DELETE','/providers/'+p.id).then(load).catch(function(e){msg(e.message)})}));
      rows.appendChild(tr);
    });
  }
  function load(){return call('GET','/providers').then(render).catch(function(e){$('rows').innerHTML='';msg(e.message)})}
  function startEdit(p){
    editing=p.id;$('formTitle').textContent='Edit provider';$('cancel').hidden=false;
    $('label').value=p.label;$('kind').value=p.kind;$('model').value=p.model;$('baseUrl').value=p.baseUrl;
    $('apiKey').value='';$('apiKey').placeholder=p.hasKey?'Leave empty to keep '+p.keyHint:'';$('preset').value='';
    window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'});
  }
  function reset(){editing=null;$('form').reset();$('formTitle').textContent='Add provider';$('cancel').hidden=true;$('apiKey').placeholder=''}
  $('cancel').addEventListener('click',function(){reset();msg('')});
  $('preset').addEventListener('change',function(){var p=PRESETS[$('preset').value];if(!p)return;
    $('label').value=p.label;$('kind').value=p.kind;$('baseUrl').value=p.baseUrl;$('model').value=p.model});
  $('form').addEventListener('submit',function(ev){
    ev.preventDefault();msg('');
    call('POST','/providers',{id:editing||undefined,label:$('label').value,kind:$('kind').value,
      baseUrl:$('baseUrl').value,model:$('model').value,apiKey:$('apiKey').value})
      .then(function(){reset();msg('Saved.',true);return load()}).catch(function(e){msg(e.message)});
  });
  function ssoMsg(t,ok){var m=$('ssoMsg');m.textContent=t||'';m.className=ok?'ok':'err'}
  function loadSso(){return call('GET','/settings').then(function(c){
    $('gitlabUrl').value=c.gitlabUrl;$('clientId').value=c.clientId;$('adminUsers').value=c.adminUsers.join(', ');
    $('clientSecret').value='';$('clientSecret').placeholder=c.hasSecret?'Leave empty to keep '+c.secretHint:'';
    $('ssoState').textContent=(c.ssoActive?'GitLab sign-in is active.':'GitLab sign-in is not active yet.')+(c.localUser?' Local admin account: '+c.localUser+'.':'')
  }).catch(function(e){ssoMsg(e.message)})}
  $('ssoForm').addEventListener('submit',function(ev){
    ev.preventDefault();ssoMsg('');
    call('PUT','/settings',{gitlabUrl:$('gitlabUrl').value,clientId:$('clientId').value,clientSecret:$('clientSecret').value,adminUsers:$('adminUsers').value})
      .then(function(){ssoMsg('Saved.',true);return loadSso()}).catch(function(e){ssoMsg(e.message)});
  });
  load();loadSso();
})();`;
}
