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
  /** Sign-in is wired up (secret, public URL and GitLab OAuth app all set). */
  configured: boolean;
  /** Error key from `?error=`. */
  error?: string;
  /** Already signed in. */
  user?: { name: string; username: string; admin: boolean };
}

const ERRORS: Record<string, string> = {
  state: 'The sign-in attempt expired or was tampered with. Please try again.',
  denied: 'GitLab sign-in was cancelled or refused.',
  gitlab: 'GitLab could not be reached or rejected the sign-in. Please try again.',
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
  } else if (v.configured) {
    action = `<a class="btn primary" href="${base}/auth/login">Sign in with GitLab</a>`;
  } else {
    action = `<div class="notice">Sign-in is not configured on this server yet.</div>`;
  }
  const err = v.error && ERRORS[v.error] ? `<div class="notice error">${esc(ERRORS[v.error]!)}</div>` : '';
  return shell(
    'Mnemosyne',
    `<main>
  <section class="card">
    <div class="mark" aria-hidden="true">M</div>
    <h1>Mnemosyne</h1>
    <p class="tag">Self-hosted AI team memory</p>
    ${err}
    ${action}
  </section>
  <footer>MCP clients connect to <code>${base}/mcp</code></footer>
</main>`,
    `main{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;
background:radial-gradient(900px 500px at 50% -10%,#1a2140 0%,transparent 70%),var(--bg)}
.card{width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px;align-items:stretch;text-align:center;
padding:36px 32px;border:1px solid var(--line);border-radius:16px;background:var(--panel);box-shadow:0 20px 60px rgba(0,0,0,.45)}
.mark{width:52px;height:52px;margin:0 auto;border-radius:14px;display:grid;place-items:center;font-size:26px;font-weight:700;color:#0b0d12;background:linear-gradient(135deg,var(--accent),#b78cff)}
h1{margin:4px 0 0;font-size:26px;letter-spacing:.2px}
.tag{margin:0 0 6px;color:var(--muted)}
.who{margin:0}.muted{color:var(--muted)}
form{margin:0}form .btn{width:100%}.card .btn{width:100%}
footer{margin-top:22px;color:var(--muted);font-size:13px}
code{background:#161a23;border:1px solid var(--line);padding:1px 6px;border-radius:5px}`,
  );
}

export interface AdminView {
  basePath: string;
  nonce: string;
  user: { name: string; username: string };
  gitlabUrl: string;
  adminUsers: string[];
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
  const admins = v.adminUsers.length
    ? `<ul class="plain">${v.adminUsers.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`
    : '<p class="sub">No admin users configured.</p>';
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
    <h2>Access</h2>
    <p class="sub">Sign-in uses GitLab at <strong>${esc(v.gitlabUrl)}</strong>. Admin access is limited to:</p>
    ${admins}
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
  load();
})();`;
}
