const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
let localtunnel;
try { localtunnel = require('localtunnel'); } catch {}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 4800;
const DATA = path.join(__dirname, 'data');
const FILES = {
  connections: path.join(DATA, 'connections.json'),
  history: path.join(DATA, 'history.json'),
  settings: path.join(DATA, 'settings.json'),
  schedules: path.join(DATA, 'schedules.json'),
};
const CATALOG_FILE = path.join(DATA, 'catalog.json');

fs.mkdirSync(DATA, { recursive: true });

function loadJ(fp, def) { try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return def; } }
function saveJ(fp, d) { fs.writeFileSync(fp, JSON.stringify(d, null, 2)); }

let connections = loadJ(FILES.connections, []);
let history = loadJ(FILES.history, []);
let schedules = loadJ(FILES.schedules, []);
let settings = { accentColor: '#6366f1', tunnelEnabled: true, ...loadJ(FILES.settings, {}) };
let tunnelUrl = null;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));

// ── Catalog ──────────────────────────────────────────────────────────

app.get('/api/catalog', (_req, res) => res.json(loadJ(CATALOG_FILE, [])));
app.get('/api/catalog/:id', (req, res) => {
  const e = loadJ(CATALOG_FILE, []).find(c => c.id === req.params.id);
  e ? res.json(e) : res.status(404).json({ error: 'Not found' });
});

// ── Connections ──────────────────────────────────────────────────────

app.get('/api/connections', (_req, res) => res.json(connections));

app.post('/api/connections', (req, res) => {
  const { catalogId, name, baseUrl, authType, authValue, headers, description } = req.body;
  let conn;
  if (catalogId) {
    const tpl = loadJ(CATALOG_FILE, []).find(c => c.id === catalogId);
    if (!tpl) return res.status(400).json({ error: 'Not found in catalog' });
    conn = { id: uuidv4(), catalogId: tpl.id, name: tpl.name, baseUrl: tpl.baseUrl, authType: tpl.authType || 'none', authParam: tpl.authParam || '', authIn: tpl.authIn || 'header', authPrefix: tpl.authPrefix || '', authValue: authValue || '', extraHeaders: tpl.extraHeaders || {}, headers: {}, description: tpl.description || '', color: tpl.color || '#6366f1', icon: tpl.icon || tpl.name[0], category: tpl.category || '', capabilities: tpl.capabilities || [], created: new Date().toISOString(), lastUsed: null, requestCount: 0 };
  } else {
    if (!name || !baseUrl) return res.status(400).json({ error: 'name and baseUrl required' });
    conn = { id: uuidv4(), catalogId: null, name, baseUrl: baseUrl.replace(/\/+$/, ''), authType: authType || 'none', authParam: '', authIn: 'header', authPrefix: '', authValue: authValue || '', extraHeaders: {}, headers: headers || {}, description: description || '', color: '#6366f1', icon: (name || 'A')[0].toUpperCase(), category: 'Custom', capabilities: [], created: new Date().toISOString(), lastUsed: null, requestCount: 0 };
  }
  connections.push(conn);
  saveJ(FILES.connections, connections);
  io.emit('connection:added', conn);
  res.status(201).json(conn);
});

app.put('/api/connections/:id', (req, res) => {
  const i = connections.findIndex(c => c.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  const safe = { ...req.body }; delete safe.id;
  connections[i] = { ...connections[i], ...safe };
  saveJ(FILES.connections, connections);
  res.json(connections[i]);
});

app.delete('/api/connections/:id', (req, res) => {
  connections = connections.filter(c => c.id !== req.params.id);
  saveJ(FILES.connections, connections);
  res.json({ ok: true });
});

// ── Execute request ──────────────────────────────────────────────────

async function executeRequest({ connectionId, method = 'GET', endpoint = '', body, queryParams, pathParams, customHeaders }) {
  const conn = connections.find(c => c.id === connectionId);
  if (!conn) throw new Error('Connection not found');

  let ep = endpoint;
  if (pathParams) { for (const [k, v] of Object.entries(pathParams)) ep = ep.replace(`{{${k}}}`, encodeURIComponent(v)); }
  let url = conn.baseUrl + (ep.startsWith('/') ? ep : '/' + ep);
  const qp = { ...(queryParams || {}) };
  if (conn.authIn === 'query' && conn.authParam && conn.authValue) qp[conn.authParam] = conn.authValue;
  if (Object.keys(qp).length) url += (url.includes('?') ? '&' : '?') + new URLSearchParams(qp).toString();

  const headers = { ...(conn.extraHeaders || {}), ...(conn.headers || {}), ...(customHeaders || {}) };
  if (conn.authIn === 'header' && conn.authParam && conn.authValue) {
    if (conn.authType === 'bearer') headers['Authorization'] = `Bearer ${conn.authValue}`;
    else if (conn.authType === 'basic') headers['Authorization'] = `Basic ${Buffer.from(conn.authValue).toString('base64')}`;
    else if (conn.authPrefix) headers[conn.authParam] = conn.authPrefix + conn.authValue;
    else headers[conn.authParam] = conn.authValue;
  }
  if (body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const start = Date.now();
  const opts = { method: method.toUpperCase(), headers };
  if (body && !['GET', 'HEAD'].includes(method.toUpperCase())) opts.body = typeof body === 'string' ? body : JSON.stringify(body);

  try {
    const resp = await fetch(url, opts);
    const elapsed = Date.now() - start;
    const ct = resp.headers.get('content-type') || '';
    let rb;
    if (ct.includes('json')) { try { rb = await resp.json(); } catch { rb = await resp.text(); } }
    else rb = await resp.text();
    const rh = {}; resp.headers.forEach((v, k) => { rh[k] = v; });

    const entry = { id: uuidv4(), connectionId, connectionName: conn.name, connectionColor: conn.color, method: method.toUpperCase(), url, endpoint: ep, status: resp.status, statusText: resp.statusText, elapsed, responseHeaders: rh, responseBody: rb, responseType: ct, requestBody: body || null, timestamp: new Date().toISOString() };
    history.unshift(entry); if (history.length > 200) history.length = 200;
    saveJ(FILES.history, history);
    conn.lastUsed = new Date().toISOString(); conn.requestCount = (conn.requestCount || 0) + 1;
    saveJ(FILES.connections, connections);
    io.emit('request:complete', entry);
    return entry;
  } catch (err) {
    const entry = { id: uuidv4(), connectionId, connectionName: conn.name, connectionColor: conn.color, method: method.toUpperCase(), url, endpoint: ep, status: 0, statusText: 'Network Error', elapsed: Date.now() - start, responseBody: err.message, responseType: 'error', requestBody: body || null, timestamp: new Date().toISOString() };
    history.unshift(entry); saveJ(FILES.history, history);
    io.emit('request:error', entry);
    return entry;
  }
}

app.post('/api/request', async (req, res) => {
  try { res.json(await executeRequest(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Schedules / Cron ─────────────────────────────────────────────────

app.get('/api/schedules', (_req, res) => res.json(schedules));

app.post('/api/schedules', (req, res) => {
  const { name, connectionId, capabilityId, params, intervalMin, enabled = true } = req.body;
  if (!connectionId || !capabilityId || !intervalMin) return res.status(400).json({ error: 'connectionId, capabilityId, intervalMin required' });
  const sched = { id: uuidv4(), name: name || 'Scheduled job', connectionId, capabilityId, params: params || {}, intervalMin: Math.max(1, intervalMin), enabled, lastRun: null, nextRun: new Date(Date.now() + intervalMin * 60000).toISOString(), runCount: 0, lastResult: null, created: new Date().toISOString() };
  schedules.push(sched);
  saveJ(FILES.schedules, schedules);
  io.emit('schedule:added', sched);
  res.status(201).json(sched);
});

app.put('/api/schedules/:id', (req, res) => {
  const i = schedules.findIndex(s => s.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  const safe = { ...req.body }; delete safe.id;
  schedules[i] = { ...schedules[i], ...safe };
  saveJ(FILES.schedules, schedules);
  res.json(schedules[i]);
});

app.delete('/api/schedules/:id', (req, res) => {
  schedules = schedules.filter(s => s.id !== req.params.id);
  saveJ(FILES.schedules, schedules);
  res.json({ ok: true });
});

async function runScheduledJob(sched) {
  const conn = connections.find(c => c.id === sched.connectionId);
  if (!conn) return;
  const cap = (conn.capabilities || []).find(c => c.id === sched.capabilityId);
  if (!cap) return;

  let endpoint = cap.endpoint;
  const pathParams = {}, queryParams = {};
  for (const [k, v] of Object.entries(sched.params || {})) {
    if (endpoint.includes(`{{${k}}}`)) pathParams[k] = v;
    else if (cap.method === 'GET') queryParams[k] = v;
  }

  let body = null;
  if (cap.bodyTemplate && cap.method !== 'GET') {
    body = JSON.parse(JSON.stringify(cap.bodyTemplate));
    (function fill(o) { for (const k in o) { if (typeof o[k] === 'string' && o[k].startsWith('{{')) { const pk = o[k].replace(/\{\{|\}\}/g, ''); if (sched.params[pk] !== undefined) o[k] = sched.params[pk]; } else if (typeof o[k] === 'object' && o[k] !== null) { if (Array.isArray(o[k])) o[k].forEach(i => { if (typeof i === 'object') fill(i); }); else fill(o[k]); } } })(body);
    if (sched.params.model && body.model) body.model = sched.params.model;
  }

  const result = await executeRequest({ connectionId: sched.connectionId, method: cap.method, endpoint, pathParams, queryParams, body });
  sched.lastRun = new Date().toISOString();
  sched.nextRun = new Date(Date.now() + sched.intervalMin * 60000).toISOString();
  sched.runCount = (sched.runCount || 0) + 1;
  sched.lastResult = { status: result.status, elapsed: result.elapsed };
  saveJ(FILES.schedules, schedules);
  io.emit('schedule:ran', { id: sched.id, result: sched.lastResult });
}

setInterval(() => {
  const now = Date.now();
  schedules.filter(s => s.enabled && s.nextRun && new Date(s.nextRun).getTime() <= now).forEach(s => {
    runScheduledJob(s).catch(e => console.error('[sched] Error:', e.message));
  });
}, 15000);

// ── History / Settings / Status ──────────────────────────────────────

app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const cid = req.query.connectionId;
  res.json((cid ? history.filter(h => h.connectionId === cid) : history).slice(0, limit));
});
app.delete('/api/history', (_req, res) => { history = []; saveJ(FILES.history, history); res.json({ ok: true }); });
app.get('/api/settings', (_req, res) => res.json(settings));
app.put('/api/settings', (req, res) => { Object.assign(settings, req.body); saveJ(FILES.settings, settings); io.emit('settings:updated', settings); res.json({ ok: true }); });

app.get('/api/status', (_req, res) => {
  res.json({ uptime: fmtUp(process.uptime()), tunnelUrl, hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, memPct: Math.round((1 - os.freemem() / os.totalmem()) * 100), localIP: getIP(), clients: io.engine.clientsCount, connectionCount: connections.length, totalRequests: history.length, activeSchedules: schedules.filter(s => s.enabled).length });
});

function fmtUp(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; }
function getIP() { for (const i of Object.values(os.networkInterfaces())) for (const c of i) if (c.family === 'IPv4' && !c.internal) return c.address; return '127.0.0.1'; }

io.on('connection', (socket) => { if (tunnelUrl) socket.emit('tunnel:url', tunnelUrl); socket.on('disconnect', () => {}); });

async function startTunnel() {
  if (!settings.tunnelEnabled || !localtunnel) return;
  try { const t = await localtunnel({ port: PORT }); tunnelUrl = t.url; console.log(`[hub] Tunnel: ${tunnelUrl}`); io.emit('tunnel:url', tunnelUrl); t.on('close', () => { tunnelUrl = null; setTimeout(startTunnel, 3000); }); }
  catch (e) { console.error('[hub] Tunnel failed:', e.message); setTimeout(startTunnel, 10000); }
}

server.listen(PORT, '0.0.0.0', () => { console.log(`\n  HUB v3.0\n  Local: http://localhost:${PORT}\n  Wi-Fi: http://${getIP()}:${PORT}\n`); startTunnel(); });
