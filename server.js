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
};
const CATALOG_FILE = path.join(DATA, 'catalog.json');

fs.mkdirSync(DATA, { recursive: true });

function loadJ(fp, def) { try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return def; } }
function saveJ(fp, d) { fs.writeFileSync(fp, JSON.stringify(d, null, 2)); }

let connections = loadJ(FILES.connections, []);
let history = loadJ(FILES.history, []);
let settings = { accentColor: '#6366f1', tunnelEnabled: true, ...loadJ(FILES.settings, {}) };
let tunnelUrl = null;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));

// ── Catalog ──────────────────────────────────────────────────────────

app.get('/api/catalog', (_req, res) => {
  const catalog = loadJ(CATALOG_FILE, []);
  res.json(catalog);
});

app.get('/api/catalog/:id', (req, res) => {
  const catalog = loadJ(CATALOG_FILE, []);
  const entry = catalog.find(c => c.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  res.json(entry);
});

// ── Connections ──────────────────────────────────────────────────────

app.get('/api/connections', (_req, res) => res.json(connections));

app.post('/api/connections', (req, res) => {
  const { catalogId, name, baseUrl, authType, authValue, headers, description } = req.body;

  let conn;
  if (catalogId) {
    const catalog = loadJ(CATALOG_FILE, []);
    const tpl = catalog.find(c => c.id === catalogId);
    if (!tpl) return res.status(400).json({ error: 'Catalog entry not found' });
    conn = {
      id: uuidv4(),
      catalogId: tpl.id,
      name: tpl.name,
      baseUrl: tpl.baseUrl,
      authType: tpl.authType || 'none',
      authParam: tpl.authParam || '',
      authIn: tpl.authIn || 'header',
      authPrefix: tpl.authPrefix || '',
      authValue: authValue || '',
      extraHeaders: tpl.extraHeaders || {},
      headers: {},
      description: tpl.description || '',
      color: tpl.color || '#6366f1',
      icon: tpl.icon || tpl.name[0],
      category: tpl.category || '',
      capabilities: tpl.capabilities || [],
      created: new Date().toISOString(),
      lastUsed: null,
      requestCount: 0,
    };
  } else {
    if (!name || !baseUrl) return res.status(400).json({ error: 'name and baseUrl required' });
    conn = {
      id: uuidv4(),
      catalogId: null,
      name,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      authType: authType || 'none',
      authParam: '',
      authIn: 'header',
      authPrefix: '',
      authValue: authValue || '',
      extraHeaders: {},
      headers: headers || {},
      description: description || '',
      color: '#6366f1',
      icon: (name || 'A')[0].toUpperCase(),
      category: 'Custom',
      capabilities: [],
      created: new Date().toISOString(),
      lastUsed: null,
      requestCount: 0,
    };
  }

  connections.push(conn);
  saveJ(FILES.connections, connections);
  io.emit('connection:added', conn);
  res.status(201).json(conn);
});

app.put('/api/connections/:id', (req, res) => {
  const idx = connections.findIndex(c => c.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const safe = { ...req.body };
  delete safe.id;
  connections[idx] = { ...connections[idx], ...safe };
  saveJ(FILES.connections, connections);
  res.json(connections[idx]);
});

app.delete('/api/connections/:id', (req, res) => {
  connections = connections.filter(c => c.id !== req.params.id);
  saveJ(FILES.connections, connections);
  res.json({ ok: true });
});

app.get('/api/connections/:id/capabilities', (req, res) => {
  const conn = connections.find(c => c.id === req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  res.json(conn.capabilities || []);
});

// ── Execute request ──────────────────────────────────────────────────

app.post('/api/request', async (req, res) => {
  const { connectionId, method = 'GET', endpoint = '', body, queryParams, customHeaders } = req.body;
  const conn = connections.find(c => c.id === connectionId);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  let ep = endpoint;
  if (req.body.pathParams) {
    for (const [k, v] of Object.entries(req.body.pathParams)) {
      ep = ep.replace(`{{${k}}}`, encodeURIComponent(v));
    }
  }

  let url = conn.baseUrl + (ep.startsWith('/') ? ep : '/' + ep);

  const qp = { ...(queryParams || {}) };
  if (conn.authIn === 'query' && conn.authParam && conn.authValue) {
    qp[conn.authParam] = conn.authValue;
  }
  if (Object.keys(qp).length) {
    url += (url.includes('?') ? '&' : '?') + new URLSearchParams(qp).toString();
  }

  const headers = { ...(conn.extraHeaders || {}), ...(conn.headers || {}), ...(customHeaders || {}) };
  if (conn.authIn === 'header' && conn.authParam && conn.authValue) {
    if (conn.authType === 'bearer') {
      headers['Authorization'] = `Bearer ${conn.authValue}`;
    } else if (conn.authType === 'basic') {
      headers['Authorization'] = `Basic ${Buffer.from(conn.authValue).toString('base64')}`;
    } else if (conn.authPrefix) {
      headers[conn.authParam] = conn.authPrefix + conn.authValue;
    } else {
      headers[conn.authParam] = conn.authValue;
    }
  }
  if (body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const start = Date.now();
  try {
    const opts = { method: method.toUpperCase(), headers };
    if (body && !['GET', 'HEAD'].includes(method.toUpperCase())) {
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const resp = await fetch(url, opts);
    const elapsed = Date.now() - start;
    const ct = resp.headers.get('content-type') || '';
    let rb;
    if (ct.includes('json')) { try { rb = await resp.json(); } catch { rb = await resp.text(); } }
    else { rb = await resp.text(); }

    const rh = {};
    resp.headers.forEach((v, k) => { rh[k] = v; });

    const entry = {
      id: uuidv4(), connectionId, connectionName: conn.name, connectionColor: conn.color,
      method: method.toUpperCase(), url, endpoint: ep,
      status: resp.status, statusText: resp.statusText,
      elapsed, responseHeaders: rh, responseBody: rb, responseType: ct,
      requestBody: body || null, timestamp: new Date().toISOString(),
    };
    history.unshift(entry);
    if (history.length > 200) history.length = 200;
    saveJ(FILES.history, history);

    conn.lastUsed = new Date().toISOString();
    conn.requestCount = (conn.requestCount || 0) + 1;
    saveJ(FILES.connections, connections);

    io.emit('request:complete', entry);
    res.json(entry);
  } catch (err) {
    const entry = {
      id: uuidv4(), connectionId, connectionName: conn.name, connectionColor: conn.color,
      method: method.toUpperCase(), url, endpoint: ep,
      status: 0, statusText: 'Network Error', elapsed: Date.now() - start,
      responseBody: err.message, responseType: 'error',
      requestBody: body || null, timestamp: new Date().toISOString(),
    };
    history.unshift(entry);
    saveJ(FILES.history, history);
    io.emit('request:error', entry);
    res.json(entry);
  }
});

// ── History ──────────────────────────────────────────────────────────

app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const cid = req.query.connectionId;
  const list = cid ? history.filter(h => h.connectionId === cid) : history;
  res.json(list.slice(0, limit));
});
app.delete('/api/history', (_req, res) => { history = []; saveJ(FILES.history, history); res.json({ ok: true }); });

// ── Settings ─────────────────────────────────────────────────────────

app.get('/api/settings', (_req, res) => res.json(settings));
app.put('/api/settings', (req, res) => { Object.assign(settings, req.body); saveJ(FILES.settings, settings); io.emit('settings:updated', settings); res.json({ ok: true }); });

// ── Status ───────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  res.json({
    uptime: fmtUp(process.uptime()), tunnelUrl,
    hostname: os.hostname(), platform: `${os.type()} ${os.release()}`,
    memPct: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    localIP: getIP(), clients: io.engine.clientsCount,
    connectionCount: connections.length, totalRequests: history.length,
  });
});

function fmtUp(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; }
function getIP() { for (const i of Object.values(os.networkInterfaces())) for (const c of i) if (c.family === 'IPv4' && !c.internal) return c.address; return '127.0.0.1'; }

io.on('connection', (socket) => {
  if (tunnelUrl) socket.emit('tunnel:url', tunnelUrl);
  socket.on('disconnect', () => {});
});

async function startTunnel() {
  if (!settings.tunnelEnabled || !localtunnel) return;
  try {
    const tunnel = await localtunnel({ port: PORT });
    tunnelUrl = tunnel.url;
    console.log(`[hub] Tunnel: ${tunnelUrl}`);
    io.emit('tunnel:url', tunnelUrl);
    tunnel.on('close', () => { tunnelUrl = null; setTimeout(startTunnel, 3000); });
  } catch (e) { console.error('[hub] Tunnel failed:', e.message); setTimeout(startTunnel, 10000); }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  API HUB v2.0\n  Local: http://localhost:${PORT}\n  Wi-Fi: http://${getIP()}:${PORT}\n`);
  startTunnel();
});
