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
const DATA_DIR = path.join(__dirname, 'data');
const CONNECTIONS_FILE = path.join(DATA_DIR, 'connections.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SAVED_FILE = path.join(DATA_DIR, 'saved.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

let tunnelUrl = null;

function loadJson(fp, def = []) { try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return def; } }
function saveJson(fp, data) { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); }

let connections = loadJson(CONNECTIONS_FILE, []);
let history = loadJson(HISTORY_FILE, []);
let saved = loadJson(SAVED_FILE, []);
let settings = { ...{ pin: '', authEnabled: false, accentColor: '#6366f1', refreshInterval: 5, tunnelEnabled: true }, ...loadJson(SETTINGS_FILE, {}) };

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));

// ── Connections CRUD ──────────────────────────────────────────────────

app.get('/api/connections', (_req, res) => res.json(connections));

app.post('/api/connections', (req, res) => {
  const { name, baseUrl, authType, authValue, headers, description } = req.body;
  if (!name || !baseUrl) return res.status(400).json({ error: 'name and baseUrl required' });
  const conn = {
    id: uuidv4(), name, baseUrl: baseUrl.replace(/\/+$/, ''),
    authType: authType || 'none', authValue: authValue || '',
    headers: headers || {}, description: description || '',
    created: new Date().toISOString(), lastUsed: null, requestCount: 0,
  };
  connections.push(conn);
  saveJson(CONNECTIONS_FILE, connections);
  io.emit('connection:added', conn);
  res.status(201).json(conn);
});

app.put('/api/connections/:id', (req, res) => {
  const idx = connections.findIndex(c => c.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  connections[idx] = { ...connections[idx], ...req.body, id: connections[idx].id };
  saveJson(CONNECTIONS_FILE, connections);
  res.json(connections[idx]);
});

app.delete('/api/connections/:id', (req, res) => {
  connections = connections.filter(c => c.id !== req.params.id);
  saveJson(CONNECTIONS_FILE, connections);
  res.json({ ok: true });
});

// ── Proxy requests through server (avoids CORS) ──────────────────────

app.post('/api/request', async (req, res) => {
  const { connectionId, method = 'GET', endpoint = '', body, queryParams, customHeaders } = req.body;
  const conn = connections.find(c => c.id === connectionId);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  let url = conn.baseUrl + (endpoint.startsWith('/') ? endpoint : '/' + endpoint);
  if (queryParams && Object.keys(queryParams).length) {
    const qs = new URLSearchParams(queryParams).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }

  const headers = { ...conn.headers, ...(customHeaders || {}) };
  if (conn.authType === 'bearer' && conn.authValue) headers['Authorization'] = `Bearer ${conn.authValue}`;
  else if (conn.authType === 'apikey' && conn.authValue) headers['X-API-Key'] = conn.authValue;
  else if (conn.authType === 'basic' && conn.authValue) headers['Authorization'] = `Basic ${Buffer.from(conn.authValue).toString('base64')}`;
  if (body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const start = Date.now();
  try {
    const fetchOpts = { method: method.toUpperCase(), headers };
    if (body && !['GET', 'HEAD'].includes(method.toUpperCase())) {
      fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const resp = await fetch(url, fetchOpts);
    const elapsed = Date.now() - start;
    const contentType = resp.headers.get('content-type') || '';
    let responseBody;
    if (contentType.includes('json')) { try { responseBody = await resp.json(); } catch { responseBody = await resp.text(); } }
    else { responseBody = await resp.text(); }

    const respHeaders = {};
    resp.headers.forEach((v, k) => { respHeaders[k] = v; });

    const entry = {
      id: uuidv4(), connectionId, connectionName: conn.name,
      method: method.toUpperCase(), url, endpoint,
      status: resp.status, statusText: resp.statusText,
      elapsed, responseHeaders: respHeaders,
      responseBody, responseType: contentType,
      requestBody: body || null,
      timestamp: new Date().toISOString(),
    };
    history.unshift(entry);
    if (history.length > 200) history.length = 200;
    saveJson(HISTORY_FILE, history);

    conn.lastUsed = new Date().toISOString();
    conn.requestCount = (conn.requestCount || 0) + 1;
    saveJson(CONNECTIONS_FILE, connections);

    io.emit('request:complete', entry);
    res.json(entry);
  } catch (err) {
    const entry = {
      id: uuidv4(), connectionId, connectionName: conn.name,
      method: method.toUpperCase(), url, endpoint,
      status: 0, statusText: 'Network Error', elapsed: Date.now() - start,
      responseBody: err.message, responseType: 'error',
      requestBody: body || null, timestamp: new Date().toISOString(),
    };
    history.unshift(entry);
    saveJson(HISTORY_FILE, history);
    io.emit('request:error', entry);
    res.json(entry);
  }
});

// ── Saved requests ───────────────────────────────────────────────────

app.get('/api/saved', (_req, res) => res.json(saved));
app.post('/api/saved', (req, res) => {
  const s = { id: uuidv4(), ...req.body, savedAt: new Date().toISOString() };
  saved.push(s);
  saveJson(SAVED_FILE, saved);
  res.status(201).json(s);
});
app.delete('/api/saved/:id', (req, res) => {
  saved = saved.filter(s => s.id !== req.params.id);
  saveJson(SAVED_FILE, saved);
  res.json({ ok: true });
});

// ── History ──────────────────────────────────────────────────────────

app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const connId = req.query.connectionId;
  let filtered = connId ? history.filter(h => h.connectionId === connId) : history;
  res.json(filtered.slice(0, limit));
});
app.delete('/api/history', (_req, res) => {
  history = [];
  saveJson(HISTORY_FILE, history);
  res.json({ ok: true });
});

// ── Settings ─────────────────────────────────────────────────────────

app.get('/api/settings', (_req, res) => res.json({ ...settings, pin: undefined }));
app.put('/api/settings', (req, res) => {
  Object.assign(settings, req.body);
  saveJson(SETTINGS_FILE, settings);
  io.emit('settings:updated', settings);
  res.json({ ok: true });
});

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

// ── Helpers ──────────────────────────────────────────────────────────

function fmtUp(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; }
function getIP() { for (const i of Object.values(os.networkInterfaces())) for (const c of i) if (c.family === 'IPv4' && !c.internal) return c.address; return '127.0.0.1'; }

io.on('connection', (socket) => {
  console.log(`[hub] +${socket.id} (${io.engine.clientsCount})`);
  if (tunnelUrl) socket.emit('tunnel:url', tunnelUrl);
  socket.on('disconnect', () => console.log(`[hub] -${socket.id}`));
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
  console.log(`\n  API HUB v1.0\n  Local: http://localhost:${PORT}\n  Wi-Fi: http://${getIP()}:${PORT}\n`);
  startTunnel();
});
