const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const cfg = {
      port: 8787,
      masterKey: 'mg-' + crypto.randomBytes(24).toString('hex'),
      providers: []
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return cfg;
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

const config = loadConfig();

// in-memory key health
const keyState = new Map(); // providerId:key -> { exhaustedUntil: number }

function isKeyAvailable(providerId, key) {
  const st = keyState.get(providerId + ':' + key);
  if (!st) return true;
  return Date.now() >= st.exhaustedUntil;
}

function markKeyExhausted(providerId, key, ms = 60000) {
  keyState.set(providerId + ':' + key, { exhaustedUntil: Date.now() + ms });
}

function maskKey(k) {
  if (!k || k.length < 8) return '***';
  return k.slice(0, 4) + '...' + k.slice(-4);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function authMaster(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-api-key'] || '');
  return token && token === config.masterKey;
}

function providerBaseUrl(p) {
  return p.baseUrl.replace(/\/+$/, '');
}

async function fetchModels(provider) {
  const base = providerBaseUrl(provider);
  const models = new Set();
  if (provider.type === 'openai' || provider.type === 'openai-compatible') {
    for (const key of provider.keys) {
      if (!isKeyAvailable(provider.id, key)) continue;
      try {
        const r = await requestJson('GET', base + '/v1/models', { Authorization: 'Bearer ' + key });
        if (r.status === 200 && r.data && Array.isArray(r.data.data)) {
          r.data.data.forEach((m) => models.add(m.id));
          break;
        }
        if (r.status === 429 || r.status === 402 || r.status === 403) markKeyExhausted(provider.id, key);
      } catch (e) {}
    }
  }
  if (provider.type === 'anthropic') {
    for (const key of provider.keys) {
      if (!isKeyAvailable(provider.id, key)) continue;
      try {
        const r = await requestJson('GET', base + '/v1/models', { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
        if (r.status === 200 && r.data && Array.isArray(r.data.data)) {
          r.data.data.forEach((m) => models.add(m.id));
          break;
        }
      } catch (e) {}
    }
  }
  if (provider.models && provider.models.length) {
    provider.models.forEach((m) => models.add(m));
  }
  return Array.from(models);
}

function requestJson(method, targetUrl, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: Object.assign({}, headers)
    };
    if (body) {
      const b = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(b);
    }
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = data; }
        resolve({ status: res.statusCode, headers: res.headers, data: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function requestStream(method, targetUrl, headers, body, res) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const b = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: Object.assign({}, headers)
    };
    if (b) {
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(b);
    }
    const req = lib.request(opts, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
      upRes.on('end', () => resolve(upRes.statusCode));
      upRes.on('error', reject);
    });
    req.on('error', reject);
    if (b) req.write(b);
    req.end();
  });
}

function openaiChatUrl(p) {
  return providerBaseUrl(p) + '/v1/chat/completions';
}

function anthropicMessagesUrl(p) {
  return providerBaseUrl(p) + '/v1/messages';
}

function toAnthropicBody(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemParts = [];
  const anthMsgs = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    } else {
      anthMsgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
  }
  const out = {
    model: body.model,
    messages: anthMsgs,
    max_tokens: body.max_tokens || body.max_completion_tokens || 1024
  };
  if (systemParts.length) out.system = systemParts.join('\n\n');
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stream === true) out.stream = true;
  return out;
}

function fromAnthropicResponse(data, model) {
  let content = '';
  if (Array.isArray(data.content)) {
    content = data.content.map((c) => (c && c.text) ? c.text : '').join('');
  } else if (typeof data.content === 'string') {
    content = data.content;
  }
  return {
    id: data.id || ('msg_' + Date.now()),
    object: 'chat.completion',
    model: data.model || model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: data.stop_reason || 'stop' }],
    usage: {
      prompt_tokens: (data.usage && data.usage.input_tokens) || 0,
      completion_tokens: (data.usage && data.usage.output_tokens) || 0,
      total_tokens: ((data.usage && data.usage.input_tokens) || 0) + ((data.usage && data.usage.output_tokens) || 0)
    }
  };
}

async function handleChatCompletions(req, res) {
  if (!authMaster(req)) return sendJson(res, 401, { error: 'invalid master key' });
  let body;
  try { body = await parseBody(req); } catch (e) { return sendJson(res, 400, { error: 'bad json' }); }
  const model = body.model;
  if (!model) return sendJson(res, 400, { error: 'model required' });

  // find providers supporting model
  let candidates = config.providers.filter((p) => {
    if (!p.models || !p.models.length) return true; // unknown: try all
    return p.models.includes(model);
  });
  if (!candidates.length) candidates = config.providers;

  const stream = body.stream === true;

  for (const provider of candidates) {
    const keys = provider.keys.filter((k) => isKeyAvailable(provider.id, k));
    // if none available, still try all after reset? try all
    const tryKeys = keys.length ? keys : provider.keys;
    for (const key of tryKeys) {
      try {
        const isAnthropic = provider.type === 'anthropic';
        if (isAnthropic) {
          const anthBody = toAnthropicBody(body);
          const r = await requestJson('POST', anthropicMessagesUrl(provider), {
            'x-api-key': key,
            'anthropic-version': '2023-06-01'
          }, anthBody);
          if (r.status >= 200 && r.status < 300) {
            const converted = fromAnthropicResponse(r.data, body.model);
            if (stream) {
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
              res.write('data: ' + JSON.stringify({ id: converted.id, object: 'chat.completion.chunk', model: converted.model, choices: [{ index: 0, delta: { role: 'assistant', content: converted.choices[0].message.content }, finish_reason: null }] }) + '\n\n');
              res.write('data: ' + JSON.stringify({ id: converted.id, object: 'chat.completion.chunk', model: converted.model, choices: [{ index: 0, delta: {}, finish_reason: converted.choices[0].finish_reason }] }) + '\n\n');
              res.write('data: [DONE]\n\n');
              res.end();
            } else {
              return sendJson(res, 200, converted);
            }
            return;
          }
          if (r.status === 429 || r.status === 402 || r.status === 403) markKeyExhausted(provider.id, key);
        } else {
          if (stream) {
            const status = await requestStream('POST', openaiChatUrl(provider), { Authorization: 'Bearer ' + key }, body, res);
            if (status >= 400) {
              if (status === 429 || status === 402 || status === 403) markKeyExhausted(provider.id, key);
              // response already sent; stop trying this provider
              return;
            }
            return;
          } else {
            const r = await requestJson('POST', openaiChatUrl(provider), { Authorization: 'Bearer ' + key }, body);
            if (r.status >= 200 && r.status < 300) {
              return sendJson(res, r.status, r.data);
            }
            if (r.status === 429 || r.status === 402 || r.status === 403) markKeyExhausted(provider.id, key);
          }
        }
      } catch (e) {
        // network error, try next
      }
    }
  }
  if (!stream) sendJson(res, 502, { error: 'all providers/keys failed' });
}

async function handleModels(req, res) {
  if (!authMaster(req)) return sendJson(res, 401, { error: 'invalid master key' });
  const all = new Set();
  for (const p of config.providers) {
    const ms = await fetchModels(p);
    ms.forEach((m) => all.add(m));
    p.models = ms;
  }
  saveConfig(config);
  const data = Array.from(all).map((id) => ({ id, object: 'model', owned_by: 'gateway' }));
  sendJson(res, 200, { object: 'list', data });
}

function adminHtml() {
  return `<!doctype html><html><head><meta charset=utf-8><title>Model Gateway</title>
<style>body{font-family:sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}input,button{padding:.4rem;margin:.2rem}section{border:1px solid #ddd;padding:1rem;margin:1rem 0;border-radius:8px}code{background:#f4f4f4;padding:2px 6px;border-radius:4px}</style></head><body>
<h1>Model Gateway</h1>
<p>Master key: <code id=mk></code> | Base URL: <code id=bu></code></p>
<section><h2>Add provider</h2>
<input id=name placeholder="name"><input id=base placeholder="base url"><select id=type><option value=openai>openai</option><option value=anthropic>anthropic</option></select><br>
<textarea id=keys placeholder="one key per line" rows=4 cols=60></textarea><br>
<button onclick=addProvider()>Add</button></section>
<section><h2>Providers</h2><div id=providers></div></section>
<section><h2>Models</h2><button onclick=loadModels()>Refresh models</button><pre id=models></pre></section>
<script>
const mk=localStorage.getItem('mg_key')||prompt('Master key?');localStorage.setItem('mg_key',mk);document.getElementById('mk').textContent=mk;
document.getElementById('bu').textContent=location.origin+'/v1';
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{'Authorization':'Bearer '+mk,'Content-Type':'application/json',...(opts.headers||{})}});return r.json();}
async function addProvider(){
 const keys=document.getElementById('keys').value.split(/\\n/).map(s=>s.trim()).filter(Boolean);
 await api('/api/providers',{method:'POST',body:JSON.stringify({name:document.getElementById('name').value,baseUrl:document.getElementById('base').value,type:document.getElementById('type').value,keys})});
 loadProviders();
}
async function loadProviders(){
 const d=await api('/api/providers');
 document.getElementById('providers').innerHTML=d.providers.map(p=>'<div><b>'+p.name+'</b> '+p.type+' '+p.baseUrl+' keys:'+p.keys.length+' models:'+p.models.length+' <button onclick="delProvider(\\''+p.id+'\\')">delete</button></div>').join('');
}
async function delProvider(id){await api('/api/providers/'+id,{method:'DELETE'});loadProviders();}
async function loadModels(){const d=await api('/v1/models');document.getElementById('models').textContent=JSON.stringify(d,null,2);}
loadProviders();
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-api-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    if (pathname === '/' || pathname === '/admin') {
      const adminPath = path.join(ROOT, 'admin.html');
      if (fs.existsSync(adminPath)) {
        const html = fs.readFileSync(adminPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(html);
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(adminHtml());
    }

    if (pathname === '/api/providers' && req.method === 'GET') {
      if (!authMaster(req)) return sendJson(res, 401, { error: 'invalid master key' });
      return sendJson(res, 200, { providers: config.providers.map((p) => ({ id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, keys: p.keys.map(maskKey), models: p.models || [] })) });
    }
    if (pathname === '/api/providers' && req.method === 'POST') {
      if (!authMaster(req)) return sendJson(res, 401, { error: 'invalid master key' });
      const body = await parseBody(req);
      const p = {
        id: 'p-' + crypto.randomBytes(4).toString('hex'),
        name: body.name || 'provider',
        type: body.type || 'openai',
        baseUrl: body.baseUrl,
        keys: Array.isArray(body.keys) ? body.keys : [],
        models: []
      };
      config.providers.push(p);
      saveConfig(config);
      return sendJson(res, 201, { provider: p });
    }
    if (pathname.startsWith('/api/providers/') && req.method === 'DELETE') {
      if (!authMaster(req)) return sendJson(res, 401, { error: 'invalid master key' });
      const id = pathname.split('/')[3];
      config.providers = config.providers.filter((p) => p.id !== id);
      saveConfig(config);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/v1/models' && req.method === 'GET') {
      return handleModels(req, res);
    }
    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      return handleChatCompletions(req, res);
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(config.port, () => {
  console.log('Model Gateway listening on http://localhost:' + config.port);
  console.log('Master key: ' + config.masterKey);
});
