require('dotenv').config();
const http    = require('http');
const https   = require('https');
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const WebSocket = require('ws');
const multer  = require('multer');
const { init: initSip, handleSipUpgrade, getSipRegistrations } = require('./sip-server');

// ── Supabase (optional — only when env vars are set) ───────────────────────
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    console.log('✅ Supabase connected');
  } catch (e) { console.warn('⚠️  Supabase init failed:', e.message); }
}

// ── File uploads: memory (Supabase) or disk (local fallback) ──────────────
const _uploadStorage = supabase
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => {
        const sub = file.fieldname === 'photo' ? 'avatars' : 'posts';
        const dir = path.join(__dirname, 'uploads', sub);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.bin';
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
      }
    });
const upload = multer({ storage: _uploadStorage, limits: { fileSize: 5 * 1024 * 1024 } });

async function uploadToStorage(bucket, filename, buffer, contentType, localPath) {
  if (supabase) {
    const { error } = await supabase.storage.from(bucket).upload(filename, buffer, { contentType, upsert: true });
    if (error) throw new Error('Supabase upload error: ' + error.message);
    const { data } = supabase.storage.from(bucket).getPublicUrl(filename);
    return data.publicUrl;
  }
  return localPath; // disk path already written by multer
}

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'dialer-secret-dev-key';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ═══════════════════════════════════════════════════════════════════════
// DATABASE (JSON file)
// ═══════════════════════════════════════════════════════════════════════
const DB_PATH = path.join(__dirname, 'db.json');

function readDB() {
  if (!fs.existsSync(DB_PATH)) return initDB();
  try {
    const d = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return { users: [], contacts: [], callLogs: [], settings: {}, teams: [], dialLists: [], messages: [], meetings: [], posts: [], directMessages: [], tasks: [], todos: [], ...d };
  } catch { return initDB(); }
}
function initDB() {
  const d = { users: [], contacts: [], callLogs: [], settings: {}, teams: [], dialLists: [], messages: [], meetings: [], posts: [], directMessages: [], tasks: [], todos: [] };
  writeDB(d); return d;
}
function writeDB(d) { fs.writeFileSync(DB_PATH, JSON.stringify(d, null, 2)); }

let _id = 2000;
// Initialize ID counter from existing data to avoid collisions after restart
(function initIdCounter() {
  try {
    const d = readDB();
    const allIds = ['users','contacts','callLogs','teams','dialLists','messages','meetings','posts']
      .flatMap(k => (d[k]||[]).map(x => x.id))
      .filter(Number.isInteger);
    if (allIds.length) _id = Math.max(...allIds) + 1;
  } catch {}
})();
function genId() { return ++_id; }

// Helper for outgoing HTTPS requests (used for Telnyx API)
function httpsRequest(url, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const req  = https.request({
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(opts.headers || {}) }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ ok: false, status: res.statusCode, data: { error: raw } }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ensureAdmin() {
  const db = readDB();
  if (db.users.length === 0) {
    const pw = await bcrypt.hash('admin123', 10);
    db.users.push({ id: 1, username: 'admin', password: pw, role: 'admin', name: 'Administrator', teamId: null, createdAt: new Date().toISOString() });
    writeDB(db);
    console.log('✅ Default admin created: admin / admin123');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════
function getUserTeam(userId, db) {
  return db.teams.find(t => t.memberIds?.includes(userId) || t.leaderId === userId) || null;
}

function enrichUser(u, db) {
  const { password, ...safe } = u;
  const team = getUserTeam(u.id, db);
  return { ...safe, teamId: u.teamId || null, teamName: team?.name || null };
}

// ═══════════════════════════════════════════════════════════════════════
// WEBSOCKET SIGNALING + CHAT
// ═══════════════════════════════════════════════════════════════════════
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === '/sip-ws') {
    handleSipUpgrade(req, socket, head);
  } else if (pathname === '/widget-ws') {
    wss.handleUpgrade(req, socket, head, (ws) => { ws._fromWidget = true; wss.emit('connection', ws, req); });
  } else {
    socket.destroy();
  }
});

const wsClients = new Map(); // userId → WebSocket
const wsCalls   = new Map(); // callId → { callerId, calleeId, to, state }

function wsSend(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws, req) => {
  const url   = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  let userId;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    userId      = decoded.id;
    ws.userId   = userId;
    ws.userName = decoded.name;
    ws.role     = decoded.role || 'agent';
  } catch {
    ws.close(4001, 'Unauthorized');
    return;
  }

  wsClients.set(userId, ws);
  wsSend(ws, { type: 'registered', userId });

  if (ws.role !== 'guest') {
    wsClients.forEach((client, id) => {
      if (id !== userId && client.role !== 'guest') wsSend(client, { type: 'user-online', userId });
    });
    console.log(`📞 Agent connected: ${ws.userName} (id=${userId})`);
  } else {
    console.log(`👤 Widget visitor connected: ${userId}`);
  }

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'call': {
        const callId = msg.callId;
        wsCalls.set(callId, { callerId: userId, to: msg.to, calleeId: null, state: 'ringing' });
        if (msg.to === 'queue') {
          const agentEntry = [...wsClients.entries()].find(([id, w]) => id !== userId && w.role !== 'guest' && w.readyState === WebSocket.OPEN);
          if (agentEntry) {
            const [agentId, agentWs] = agentEntry;
            wsCalls.get(callId).calleeId = agentId;
            wsSend(agentWs, { type: 'incoming', callId, from: userId, fromName: ws.userName || 'Website Visitor', offer: msg.offer });
          } else {
            wsSend(ws, { type: 'call-error', callId, message: 'No agents available right now.' });
            wsCalls.delete(callId);
          }
        } else {
          const targetId       = Number(msg.to);
          const internalTarget = wsClients.get(targetId);
          if (internalTarget && internalTarget.readyState === WebSocket.OPEN) {
            wsCalls.get(callId).calleeId = targetId;
            wsSend(internalTarget, { type: 'incoming', callId, from: userId, fromName: ws.userName, offer: msg.offer });
          } else if (/^\d+$/.test(String(msg.to))) {
            wsSend(ws, { type: 'call-error', callId, message: 'Agent is offline or not available right now.' });
            wsCalls.delete(callId);
          } else {
            wsSend(ws, { type: 'call-error', callId, message: 'PSTN calls require SIP mode.' });
            wsCalls.delete(callId);
          }
        }
        break;
      }

      case 'answer': {
        const call = wsCalls.get(msg.callId);
        if (!call) break;
        call.state = 'active';
        wsSend(wsClients.get(call.callerId), { type: 'answer', callId: msg.callId, answer: msg.answer });
        break;
      }

      case 'ice-candidate': {
        const call = wsCalls.get(msg.callId);
        if (!call) break;
        const otherId = call.callerId === userId ? call.calleeId : call.callerId;
        wsSend(wsClients.get(otherId), { type: 'ice-candidate', callId: msg.callId, candidate: msg.candidate });
        break;
      }

      case 'hangup': {
        const call = wsCalls.get(msg.callId);
        if (call) {
          const otherId = call.callerId === userId ? call.calleeId : call.callerId;
          wsSend(wsClients.get(otherId), { type: 'hangup', callId: msg.callId });
          wsCalls.delete(msg.callId);
        }
        break;
      }

      case 'reject': {
        const call = wsCalls.get(msg.callId);
        if (call) {
          wsSend(wsClients.get(call.callerId), { type: 'rejected', callId: msg.callId });
          wsCalls.delete(msg.callId);
        }
        break;
      }

      case 'ping':
        wsSend(ws, { type: 'pong' });
        break;

      case 'chat': {
        if (!msg.text?.trim() || ws.role === 'guest') break;
        const db   = readDB();
        const team = getUserTeam(userId, db);
        const scope = msg.scope === 'team' ? 'team' : 'all';
        const chatMsg = {
          id: genId(), userId, text: msg.text.trim(),
          userName: ws.userName, role: ws.role, teamName: team?.name || null,
          scope, createdAt: new Date().toISOString()
        };
        if (!db.messages) db.messages = [];
        db.messages.push(chatMsg);
        if (db.messages.length > 500) db.messages = db.messages.slice(-500);
        writeDB(db);
        if (scope === 'team') {
          const myTeamId = team?.id;
          wsClients.forEach((client, cid) => {
            if (client.role !== 'guest') {
              const ct = getUserTeam(cid, db);
              if (ct?.id === myTeamId) wsSend(client, { type: 'chat', message: chatMsg });
            }
          });
        } else {
          wsClients.forEach(client => {
            if (client.role !== 'guest') wsSend(client, { type: 'chat', message: chatMsg });
          });
        }
        break;
      }

      case 'dm': {
        if (!msg.text?.trim() || !msg.to || ws.role === 'guest') break;
        const toId = Number(msg.to);
        const db   = readDB();
        const dmMsg = {
          id: genId(), fromId: userId, toId,
          text: msg.text.trim(), fromName: ws.userName, role: ws.role,
          createdAt: new Date().toISOString()
        };
        if (!db.directMessages) db.directMessages = [];
        db.directMessages.push(dmMsg);
        if (db.directMessages.length > 2000) db.directMessages = db.directMessages.slice(-2000);
        writeDB(db);
        // Relay to sender and receiver only
        [userId, toId].forEach(id => {
          const client = wsClients.get(id);
          if (client) wsSend(client, { type: 'dm', message: dmMsg });
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    wsClients.delete(userId);
    wsCalls.forEach((call, callId) => {
      if (call.callerId === userId || call.calleeId === userId) {
        const otherId = call.callerId === userId ? call.calleeId : call.callerId;
        wsSend(wsClients.get(otherId), { type: 'hangup', callId });
        wsCalls.delete(callId);
      }
    });
    if (ws.role !== 'guest') {
      wsClients.forEach((client, id) => {
        if (id !== userId && client.role !== 'guest') wsSend(client, { type: 'user-offline', userId });
      });
      console.log(`📞 Agent disconnected: ${ws.userName}`);
    } else {
      console.log(`👤 Visitor disconnected: ${userId}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}
function adminOnly(req, res, next) {
  auth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}
function teamLeaderOrAdmin(req, res, next) {
  auth(req, res, () => {
    if (req.user.role === 'admin' || req.user.role === 'team_leader') return next();
    res.status(403).json({ error: 'Team leader or admin required' });
  });
}

// ═══════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const db   = readDB();
  const user = db.users.find(u => u.username === username);
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.name },
    JWT_SECRET, { expiresIn: '7d' }
  );
  const team = getUserTeam(user.id, db);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, name: user.name, teamId: user.teamId || null, teamName: team?.name || null } });
});

app.get('/api/auth/me', auth, (req, res) => {
  const db   = readDB();
  const user = db.users.find(u => u.id === req.user.id);
  const team = getUserTeam(req.user.id, db);
  res.json({ user: { ...req.user, teamId: user?.teamId || null, teamName: team?.name || null } });
});

// ═══════════════════════════════════════════════════════════════════════
// SETTINGS  (read by auth, write by admin only)
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/settings', auth, (req, res) => {
  const db = readDB();
  const s  = db.settings?.[req.user.id] || { mode: 'webrtc', sipServer: '', sipUsername: '', sipPassword: '', sipDisplayName: '' };
  res.json({ settings: { ...s, sipPassword: s.sipPassword ? '••••••••' : '' } });
});

// Admin sets SIP settings — can target any user (targetUserId) or self
app.put('/api/settings', adminOnly, (req, res) => {
  const db  = readDB();
  if (!db.settings) db.settings = {};
  const data = req.body.settings || req.body;
  const { mode, sipServer, sipUsername, sipPassword, sipDisplayName, builtinSip, targetUserId } = data;
  const uid = targetUserId ? Number(targetUserId) : req.user.id;
  const ex  = db.settings[uid] || {};
  db.settings[uid] = {
    mode:           mode           || ex.mode           || 'webrtc',
    sipServer:      sipServer      ?? ex.sipServer      ?? '',
    sipUsername:    sipUsername    ?? ex.sipUsername     ?? '',
    sipPassword:    sipPassword && sipPassword !== '••••••••' ? sipPassword : (ex.sipPassword ?? ''),
    sipDisplayName: sipDisplayName ?? ex.sipDisplayName ?? '',
    builtinSip:     builtinSip     ?? ex.builtinSip     ?? false,
  };
  writeDB(db);
  res.json({ success: true });
});

app.get('/api/settings/credentials', auth, (req, res) => {
  const db = readDB();
  res.json({ settings: db.settings?.[req.user.id] || { mode: 'webrtc' } });
});

// ═══════════════════════════════════════════════════════════════════════
// ADMIN — Users
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/admin/users', adminOnly, (req, res) => {
  const db = readDB();
  res.json({ users: db.users.map(u => enrichUser(u, db)) });
});

app.post('/api/admin/users', adminOnly, async (req, res) => {
  const { username, password, name, role = 'agent', teamId } = req.body;
  if (!username || !password || !name)
    return res.status(400).json({ error: 'username, password, name required' });
  const db = readDB();
  if (db.users.find(u => u.username === username))
    return res.status(400).json({ error: 'Username already taken' });
  const newId = genId();
  const user = { id: newId, username, password: await bcrypt.hash(password, 10), role, name, teamId: teamId ? Number(teamId) : null, createdAt: new Date().toISOString() };
  db.users.push(user);
  if (teamId) {
    const team = db.teams.find(t => t.id === Number(teamId));
    if (team && !team.memberIds.includes(newId)) team.memberIds.push(newId);
  }
  writeDB(db);
  res.status(201).json({ user: enrichUser(user, db) });
});

app.delete('/api/admin/users/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (id === 1) return res.status(400).json({ error: 'Cannot delete main admin' });
  const db = readDB();
  db.users = db.users.filter(u => u.id !== id);
  db.teams.forEach(t => {
    t.memberIds = t.memberIds.filter(mid => mid !== id);
    if (t.leaderId === id) t.leaderId = null;
  });
  writeDB(db);
  res.json({ success: true });
});

// Promote / demote role
app.patch('/api/admin/users/:id/role', adminOnly, (req, res) => {
  const id     = Number(req.params.id);
  const { role } = req.body;
  if (!['admin', 'team_leader', 'agent'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (id === 1 && role !== 'admin') return res.status(400).json({ error: 'Cannot demote main admin' });
  const db   = readDB();
  const user = db.users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.role = role;
  // If demoted from team_leader, update the team's leaderId
  if (role !== 'team_leader') {
    db.teams.forEach(t => { if (t.leaderId === id) t.leaderId = null; });
  }
  writeDB(db);
  res.json({ user: enrichUser(user, db) });
});

// Move user to a team
app.patch('/api/admin/users/:id/team', adminOnly, (req, res) => {
  const id     = Number(req.params.id);
  const teamId = req.body.teamId ? Number(req.body.teamId) : null;
  const db     = readDB();
  const user   = db.users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Remove from old teams
  db.teams.forEach(t => { t.memberIds = t.memberIds.filter(mid => mid !== id); });
  user.teamId = teamId;
  if (teamId) {
    const team = db.teams.find(t => t.id === teamId);
    if (team && !team.memberIds.includes(id)) team.memberIds.push(id);
  }
  writeDB(db);
  res.json({ user: enrichUser(user, db) });
});

// ═══════════════════════════════════════════════════════════════════════
// ADMIN — All calls (team leader sees team only)
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/admin/calls', teamLeaderOrAdmin, (req, res) => {
  const db = readDB();
  let calls = db.callLogs;
  if (req.user.role === 'team_leader') {
    const me     = db.users.find(u => u.id === req.user.id);
    const myTeam = db.teams.find(t => t.id === me?.teamId);
    const ids    = myTeam ? [...(myTeam.memberIds || []), myTeam.leaderId].filter(Boolean) : [req.user.id];
    calls = calls.filter(c => ids.includes(c.userId));
  } else if (req.query.userId) {
    calls = calls.filter(c => c.userId === Number(req.query.userId));
  }
  const userMap = Object.fromEntries(db.users.map(u => [u.id, u.name]));
  res.json({ calls: calls.slice(-300).reverse().map(c => ({ ...c, userName: userMap[c.userId] || 'Unknown' })) });
});

// Recordings — admin and team leader only
app.use('/recordings', teamLeaderOrAdmin, express.static(path.join(__dirname, 'recordings')));

// ═══════════════════════════════════════════════════════════════════════
// TEAMS
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/teams', adminOnly, (req, res) => {
  const db = readDB();
  res.json({ teams: db.teams.map(t => ({
    ...t,
    leaderName: db.users.find(u => u.id === t.leaderId)?.name || null,
    members: db.users.filter(u => t.memberIds?.includes(u.id)).map(u => enrichUser(u, db))
  })) });
});

app.get('/api/teams/my', auth, (req, res) => {
  const db   = readDB();
  const me   = db.users.find(u => u.id === req.user.id);
  const team = me?.teamId ? db.teams.find(t => t.id === me.teamId) : null;
  if (!team) return res.json({ team: null });
  res.json({ team: { ...team, leaderName: db.users.find(u => u.id === team.leaderId)?.name || null, members: db.users.filter(u => team.memberIds?.includes(u.id)).map(u => enrichUser(u, db)) } });
});

app.post('/api/teams', adminOnly, (req, res) => {
  const { name, leaderId } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const db   = readDB();
  const team = { id: genId(), name, leaderId: leaderId ? Number(leaderId) : null, memberIds: [], createdAt: new Date().toISOString() };
  db.teams.push(team);
  if (leaderId) {
    const leader = db.users.find(u => u.id === Number(leaderId));
    if (leader) {
      db.teams.forEach(t => { if (t.id !== team.id) t.memberIds = t.memberIds.filter(mid => mid !== leader.id); });
      leader.teamId = team.id;
      leader.role   = 'team_leader';
      if (!team.memberIds.includes(leader.id)) team.memberIds.push(leader.id);
    }
  }
  writeDB(db);
  res.status(201).json({ team });
});

app.put('/api/teams/:id', adminOnly, (req, res) => {
  const id   = Number(req.params.id);
  const { name, leaderId } = req.body;
  const db   = readDB();
  const team = db.teams.find(t => t.id === id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (name) team.name = name;
  if (leaderId !== undefined) {
    if (team.leaderId) {
      const old = db.users.find(u => u.id === team.leaderId);
      if (old?.role === 'team_leader') old.role = 'agent';
    }
    team.leaderId = leaderId ? Number(leaderId) : null;
    if (team.leaderId) {
      const nw = db.users.find(u => u.id === team.leaderId);
      if (nw) { nw.role = 'team_leader'; nw.teamId = id; if (!team.memberIds.includes(nw.id)) team.memberIds.push(nw.id); }
    }
  }
  writeDB(db);
  res.json({ team });
});

app.delete('/api/teams/:id', adminOnly, (req, res) => {
  const id   = Number(req.params.id);
  const db   = readDB();
  const team = db.teams.find(t => t.id === id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  db.users.forEach(u => { if (u.teamId === id) u.teamId = null; });
  if (team.leaderId) { const l = db.users.find(u => u.id === team.leaderId); if (l?.role === 'team_leader') l.role = 'agent'; }
  db.teams = db.teams.filter(t => t.id !== id);
  writeDB(db);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════
// DIAL LISTS
// ═══════════════════════════════════════════════════════════════════════
app.post('/api/dial-lists', adminOnly, (req, res) => {
  const { name, teamId, contacts } = req.body;
  if (!name || !teamId || !Array.isArray(contacts)) return res.status(400).json({ error: 'name, teamId, contacts[] required' });
  const db   = readDB();
  const list = {
    id: genId(), name, teamId: Number(teamId), assignedBy: req.user.id,
    contacts: contacts.map((c, i) => ({ ...c, _id: c._id || `item-${i}`, status: 'pending' })),
    createdAt: new Date().toISOString()
  };
  db.dialLists.push(list);
  writeDB(db);
  res.status(201).json({ list });
});

app.get('/api/dial-lists', adminOnly, (req, res) => {
  const db      = readDB();
  const teamMap = Object.fromEntries(db.teams.map(t => [t.id, t.name]));
  res.json({ lists: db.dialLists.map(l => ({
    ...l, teamName: teamMap[l.teamId] || 'Unknown',
    total: l.contacts.length,
    done:  l.contacts.filter(c => c.status === 'completed').length,
    fail:  l.contacts.filter(c => ['failed','no-answer','busy'].includes(c.status)).length,
  })) });
});

app.get('/api/dial-lists/my', auth, (req, res) => {
  const db = readDB();
  const me = db.users.find(u => u.id === req.user.id);
  if (!me?.teamId) return res.json({ dialList: null });
  // Return the most recently assigned list for the team
  const lists = db.dialLists.filter(l => l.teamId === me.teamId);
  const dialList = lists.length ? lists[lists.length - 1] : null;
  res.json({ dialList });
});

app.get('/api/dial-lists/team/:teamId', adminOnly, (req, res) => {
  const db     = readDB();
  const teamId = Number(req.params.teamId);
  const lists  = db.dialLists.filter(l => l.teamId === teamId);
  res.json({ lists: lists.map(l => ({
    ...l,
    total: l.contacts.length,
    done:  l.contacts.filter(c => c.status === 'completed').length,
    fail:  l.contacts.filter(c => ['failed','no-answer','busy'].includes(c.status)).length,
  })) });
});

app.patch('/api/dial-lists/:id/contact/:contactId', auth, (req, res) => {
  const db   = readDB();
  const list = db.dialLists.find(l => l.id === Number(req.params.id));
  if (!list) return res.status(404).json({ error: 'List not found' });
  const contact = list.contacts.find(c => c._id === req.params.contactId);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const { status, notes } = req.body;
  if (status) contact.status = status;
  if (notes !== undefined) contact.notes = notes;
  writeDB(db);
  res.json({ contact });
});

app.delete('/api/dial-lists/:id', adminOnly, (req, res) => {
  const db = readDB();
  db.dialLists = db.dialLists.filter(l => l.id !== Number(req.params.id));
  writeDB(db);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════
// MEETINGS
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/meetings', auth, (req, res) => {
  const db = readDB();
  let meetings = db.meetings || [];
  if (req.user.role !== 'admin') {
    if (req.user.role === 'team_leader') {
      const me     = db.users.find(u => u.id === req.user.id);
      const myTeam = db.teams.find(t => t.id === me?.teamId);
      const ids    = myTeam ? [...(myTeam.memberIds || []), myTeam.leaderId].filter(Boolean) : [req.user.id];
      meetings = meetings.filter(m => ids.includes(m.agentId));
    } else {
      meetings = meetings.filter(m => m.agentId === req.user.id);
    }
  }
  const userMap = Object.fromEntries(db.users.map(u => [u.id, u.name]));
  res.json({ meetings: [...meetings].reverse().map(m => ({ ...m, agentName: userMap[m.agentId] || 'Unknown' })) });
});

app.post('/api/meetings', auth, (req, res) => {
  const { contactName, contactPhone, contactEmail, contactInfo, date, time, notes } = req.body;
  if (!contactName || !date) return res.status(400).json({ error: 'contactName and date required' });
  const db = readDB();
  if (!db.meetings) db.meetings = [];
  const meeting = { id: genId(), agentId: req.user.id, contactName, contactPhone: contactPhone || '', contactEmail: contactEmail || '', contactInfo: contactInfo || {}, date, time: time || '', notes: notes || '', status: 'scheduled', createdAt: new Date().toISOString() };
  db.meetings.push(meeting);
  writeDB(db);
  res.status(201).json({ meeting });
});

app.patch('/api/meetings/:id', auth, (req, res) => {
  const db      = readDB();
  const meeting = (db.meetings || []).find(m => m.id === Number(req.params.id));
  if (!meeting) return res.status(404).json({ error: 'Not found' });
  const { status, notes, date, time } = req.body;
  if (status) meeting.status = status;
  if (notes  !== undefined) meeting.notes = notes;
  if (date)  meeting.date = date;
  if (time)  meeting.time = time;
  writeDB(db);
  res.json({ meeting });
});

// ═══════════════════════════════════════════════════════════════════════
// CHAT MESSAGES (REST history; WS handled in ws.on('message') above)
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/messages/dm/:userId', auth, (req, res) => {
  const db     = readDB();
  const me     = req.user.id;
  const other  = Number(req.params.userId);
  const limit  = Math.min(Number(req.query.limit) || 100, 300);
  const msgs   = (db.directMessages || [])
    .filter(m => (m.fromId === me && m.toId === other) || (m.fromId === other && m.toId === me))
    .slice(-limit);
  res.json({ messages: msgs });
});

app.post('/api/messages/dm', auth, (req, res) => {
  const { toId, text } = req.body;
  if (!text?.trim() || !toId) return res.status(400).json({ error: 'toId and text required' });
  const db = readDB();
  const user = db.users.find(u => u.id === req.user.id);
  const dmMsg = {
    id: genId(), fromId: req.user.id, toId: Number(toId),
    text: text.trim(), fromName: user?.name || req.user.name, role: user?.role || req.user.role,
    createdAt: new Date().toISOString()
  };
  if (!db.directMessages) db.directMessages = [];
  db.directMessages.push(dmMsg);
  if (db.directMessages.length > 2000) db.directMessages = db.directMessages.slice(-2000);
  writeDB(db);
  // Relay via WS to both parties
  [req.user.id, Number(toId)].forEach(id => {
    const client = wsClients.get(id);
    if (client) wsSend(client, { type: 'dm', message: dmMsg });
  });
  res.status(201).json({ message: dmMsg });
});

app.get('/api/messages', auth, (req, res) => {
  const db    = readDB();
  const limit = Math.min(Number(req.query.limit) || 80, 200);
  const scope = req.query.scope || 'all';
  const userMap = Object.fromEntries(db.users.map(u => [u.id, u]));
  let rawMsgs = (db.messages || []);
  if (scope === 'team') {
    const myTeam = getUserTeam(req.user.id, db);
    rawMsgs = myTeam
      ? rawMsgs.filter(m => m.scope === 'team' && getUserTeam(m.userId, db)?.id === myTeam.id)
      : [];
  } else {
    rawMsgs = rawMsgs.filter(m => !m.scope || m.scope === 'all');
  }
  const msgs = rawMsgs.slice(-limit).map(m => {
    const u    = userMap[m.userId];
    const team = u ? getUserTeam(u.id, db) : null;
    return { ...m, userName: u?.name || m.userName || 'Unknown', role: u?.role || m.role || 'agent', teamName: team?.name || m.teamName || null };
  });
  res.json({ messages: msgs });
});

app.post('/api/messages', auth, (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  const db   = readDB();
  const user = db.users.find(u => u.id === req.user.id);
  const team = getUserTeam(req.user.id, db);
  const chatMsg = { id: genId(), userId: req.user.id, text: text.trim(), userName: user?.name || req.user.name, role: user?.role || req.user.role, teamName: team?.name || null, createdAt: new Date().toISOString() };
  if (!db.messages) db.messages = [];
  db.messages.push(chatMsg);
  if (db.messages.length > 500) db.messages = db.messages.slice(-500);
  writeDB(db);
  wsClients.forEach(client => { if (client.role !== 'guest') wsSend(client, { type: 'chat', message: chatMsg }); });
  res.status(201).json({ message: chatMsg });
});

// ═══════════════════════════════════════════════════════════════════════
// CONTACTS
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/contacts', auth, (req, res) => {
  const db = readDB();
  res.json({ contacts: db.contacts.filter(c => c.userId === req.user.id) });
});

app.post('/api/contacts', auth, (req, res) => {
  const { name, phone, company, email, notes } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const db = readDB();
  const c  = { id: genId(), userId: req.user.id, name: name || 'Unknown', phone, company: company || '', email: email || '', notes: notes || '', createdAt: new Date().toISOString() };
  db.contacts.push(c);
  writeDB(db);
  res.status(201).json({ contact: c });
});

app.post('/api/contacts/bulk', auth, (req, res) => {
  const { contacts } = req.body;
  if (!Array.isArray(contacts)) return res.status(400).json({ error: 'contacts[] required' });
  const db = readDB();
  const created = contacts.filter(c => c.phone).map(c => ({ id: genId(), userId: req.user.id, name: c.name || 'Unknown', phone: c.phone, company: c.company || '', email: c.email || '', notes: c.notes || '', createdAt: new Date().toISOString() }));
  db.contacts.push(...created);
  writeDB(db);
  res.json({ created: created.length, contacts: created });
});

app.delete('/api/contacts/:id', auth, (req, res) => {
  const db = readDB();
  db.contacts = db.contacts.filter(c => !(c.id === Number(req.params.id) && c.userId === req.user.id));
  writeDB(db);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════
// CALL LOGS (role-filtered)
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/calls/history', auth, (req, res) => {
  const db = readDB();
  const userMap = Object.fromEntries(db.users.map(u => [u.id, u.name]));
  let calls = db.callLogs;

  if (req.user.role === 'admin') {
    return res.json({ calls: calls.slice(-200).reverse().map(c => ({ ...c, userName: userMap[c.userId] || 'Unknown' })) });
  }
  if (req.user.role === 'team_leader') {
    const me     = db.users.find(u => u.id === req.user.id);
    const myTeam = db.teams.find(t => t.id === me?.teamId);
    const ids    = myTeam ? [...(myTeam.memberIds || []), myTeam.leaderId].filter(Boolean) : [req.user.id];
    calls = calls.filter(c => ids.includes(c.userId));
    return res.json({ calls: calls.slice(-200).reverse().map(c => ({ ...c, userName: userMap[c.userId] || 'Unknown' })) });
  }
  calls = calls.filter(c => c.userId === req.user.id);
  return res.json({ calls: calls.slice(-100).reverse() });
});

app.post('/api/calls/log', auth, (req, res) => {
  const { callSid, to, from, contactName, contactInfo, direction, status, duration, recordingFile } = req.body;
  const db = readDB();
  const existing = db.callLogs.find(l => l.callSid === callSid);
  if (existing) {
    Object.assign(existing, { userId: req.user.id, contactName, contactInfo, status, duration, recordingFile });
  } else {
    db.callLogs.push({ id: genId(), userId: req.user.id, callSid: callSid || `local-${Date.now()}`, from: from || '', to, contactName: contactName || 'Unknown', contactInfo: contactInfo || {}, direction: direction || 'outbound', status: status || 'completed', duration: duration || 0, recordingFile: recordingFile || null, createdAt: new Date().toISOString() });
  }
  writeDB(db);
  res.status(201).json({ success: true });
});

app.post('/api/calls/recording', auth, (req, res) => {
  const dir = path.join(__dirname, 'recordings');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = `rec-${Date.now()}-${req.user.id}.webm`;
  const chunks   = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => { fs.writeFileSync(path.join(dir, filename), Buffer.concat(chunks)); res.json({ file: filename }); });
  req.on('error', () => res.status(500).json({ error: 'Upload failed' }));
});

// ═══════════════════════════════════════════════════════════════════════
// ONLINE AGENTS (with team info)
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/agents/online', auth, (req, res) => {
  const db     = readDB();
  const online = [...wsClients.keys()];
  const agents = db.users
    .filter(u => online.includes(u.id) && u.id !== req.user.id && wsClients.get(u.id)?.role !== 'guest')
    .map(u => { const team = getUserTeam(u.id, db); const { password, ...safe } = u; return { ...safe, teamName: team?.name || null, online: true }; });
  res.json({ agents });
});

// ═══════════════════════════════════════════════════════════════════════
// CLICK-TO-CALL WIDGET
// ═══════════════════════════════════════════════════════════════════════
app.get('/widget', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'widget.html')); });

app.get('/api/widget/token', (req, res) => {
  const visitorId = `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const token = jwt.sign({ id: visitorId, role: 'guest', name: 'Website Visitor' }, JWT_SECRET, { expiresIn: '2h' });
  res.json({ token, visitorId });
});

// ═══════════════════════════════════════════════════════════════════════
// GLOBAL SETTINGS (Telnyx API key, etc.)
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/settings/global', adminOnly, (req, res) => {
  const db = readDB();
  const g  = (db.settings || {}).global || {};
  res.json({ settings: { telnyxApiKey: g.telnyxApiKey ? '••••' + g.telnyxApiKey.slice(-4) : '', telnyxConnectionId: g.telnyxConnectionId || '', telnyxSipServer: g.telnyxSipServer || 'wss://sip.telnyx.com' } });
});

app.put('/api/settings/global', adminOnly, (req, res) => {
  const db = readDB();
  if (!db.settings) db.settings = {};
  const ex = db.settings.global || {};
  const { telnyxApiKey, telnyxConnectionId, telnyxSipServer } = req.body;
  db.settings.global = {
    telnyxApiKey:       telnyxApiKey && telnyxApiKey !== '••••' + (ex.telnyxApiKey||'').slice(-4) ? telnyxApiKey : (ex.telnyxApiKey || ''),
    telnyxConnectionId: telnyxConnectionId ?? ex.telnyxConnectionId ?? '',
    telnyxSipServer:    telnyxSipServer    || ex.telnyxSipServer    || 'wss://sip.telnyx.com',
  };
  writeDB(db);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════
// TELNYX — Auto-create SIP credentials for a user
// ═══════════════════════════════════════════════════════════════════════
app.post('/api/admin/telnyx/create-sip', adminOnly, async (req, res) => {
  const { userId, name } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const db  = readDB();
  const g   = (db.settings || {}).global || {};
  const key = g.telnyxApiKey;
  const cid = g.telnyxConnectionId;
  const srv = g.telnyxSipServer || 'wss://sip.telnyx.com';

  if (!key) return res.status(400).json({ error: 'Telnyx API key not set. Configure it in Global Settings.' });
  if (!cid) return res.status(400).json({ error: 'Telnyx Connection ID not set. Configure it in Global Settings.' });

  try {
    const r = await httpsRequest(
      'https://api.telnyx.com/v2/telephony_credentials',
      { method: 'POST', headers: { Authorization: `Bearer ${key}` } },
      { connection_id: cid, name: name || `user-${userId}` }
    );
    if (!r.ok) {
      const msg = r.data?.errors?.[0]?.detail || r.data?.error || 'Telnyx API error';
      return res.status(400).json({ error: msg });
    }
    const cred = r.data?.data || r.data;
    const sipUsername = cred.sip_username || cred.username;
    const sipPassword = cred.sip_password || cred.token || cred.password;
    if (!sipUsername) return res.status(400).json({ error: 'Telnyx did not return a SIP username. Check connection_id.' });

    if (!db.settings) db.settings = {};
    db.settings[Number(userId)] = {
      ...(db.settings[Number(userId)] || {}),
      mode: 'sip', sipServer: srv,
      sipUsername, sipPassword: sipPassword || '',
      sipDisplayName: name || '', builtinSip: false,
      telnyxCredentialId: cred.id || null,
    };
    writeDB(db);
    res.json({ success: true, sipUsername, sipServer: srv });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reach Telnyx: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ALL USERS (for Community page — shows everyone, not just online)
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/users/all', auth, (req, res) => {
  const db     = readDB();
  const online = new Set([...wsClients.keys()]);
  const users  = db.users
    .filter(u => wsClients.get(u.id)?.role !== 'guest')
    .map(u => {
      const team = getUserTeam(u.id, db);
      const { password, ...safe } = u;
      return { ...safe, teamName: team?.name || null, online: online.has(u.id) };
    });
  res.json({ users });
});

// ═══════════════════════════════════════════════════════════════════════
// POSTS (Community Feed)
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/posts', auth, (req, res) => {
  const db    = readDB();
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const posts = (db.posts || []).slice(-limit).reverse().map(p => ({
    ...p,
    likeCount:    (p.likes || []).length,
    likedByMe:    (p.likes || []).includes(req.user.id),
    commentCount: (p.comments || []).length,
  }));
  res.json({ posts });
});

app.post('/api/posts', auth, upload.single('image'), async (req, res) => {
  const text = req.body.text;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  let imageUrl = null;
  if (req.file) {
    try {
      const ext      = path.extname(req.file.originalname) || '.bin';
      const filename = `post-${req.user.id}-${Date.now()}${ext}`;
      const localPath = req.file.path ? `/uploads/posts/${path.basename(req.file.path)}` : null;
      imageUrl = await uploadToStorage('post-images', filename, req.file.buffer || fs.readFileSync(req.file.path), req.file.mimetype, localPath);
    } catch (e) { console.error('Image upload error:', e.message); }
  }
  const db   = readDB();
  const user = db.users.find(u => u.id === req.user.id);
  const team = getUserTeam(req.user.id, db);
  if (!db.posts) db.posts = [];
  const post = {
    id: genId(), userId: req.user.id, userName: user?.name || req.user.name,
    role: user?.role || req.user.role, teamName: team?.name || null,
    text: text.trim(), imageUrl, likes: [], comments: [],
    createdAt: new Date().toISOString()
  };
  db.posts.push(post);
  if (db.posts.length > 1000) db.posts = db.posts.slice(-1000);
  writeDB(db);
  const out = { ...post, likeCount: 0, likedByMe: false, commentCount: 0 };
  wsClients.forEach(c => { if (c.role !== 'guest') wsSend(c, { type: 'post-new', post: out }); });
  res.status(201).json({ post: out });
});

app.delete('/api/posts/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const db = readDB();
  const post = (db.posts || []).find(p => p.id === id);
  if (!post) return res.status(404).json({ error: 'Not found' });
  if (post.userId !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden' });
  db.posts = db.posts.filter(p => p.id !== id);
  writeDB(db);
  wsClients.forEach(c => { if (c.role !== 'guest') wsSend(c, { type: 'post-delete', postId: id }); });
  res.json({ success: true });
});

app.post('/api/posts/:id/like', auth, (req, res) => {
  const id   = Number(req.params.id);
  const db   = readDB();
  const post = (db.posts || []).find(p => p.id === id);
  if (!post) return res.status(404).json({ error: 'Not found' });
  if (!post.likes) post.likes = [];
  const idx = post.likes.indexOf(req.user.id);
  if (idx === -1) post.likes.push(req.user.id);
  else            post.likes.splice(idx, 1);
  writeDB(db);
  wsClients.forEach(c => { if (c.role !== 'guest') wsSend(c, { type: 'post-like', postId: id, likes: post.likes }); });
  res.json({ likes: post.likes, likeCount: post.likes.length, likedByMe: post.likes.includes(req.user.id) });
});

app.post('/api/posts/:id/comments', auth, (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  const id   = Number(req.params.id);
  const db   = readDB();
  const post = (db.posts || []).find(p => p.id === id);
  if (!post) return res.status(404).json({ error: 'Not found' });
  if (!post.comments) post.comments = [];
  const user    = db.users.find(u => u.id === req.user.id);
  const comment = { id: genId(), userId: req.user.id, userName: user?.name || req.user.name, role: user?.role || req.user.role, text: text.trim(), createdAt: new Date().toISOString() };
  post.comments.push(comment);
  writeDB(db);
  wsClients.forEach(c => { if (c.role !== 'guest') wsSend(c, { type: 'post-comment', postId: id, comment, commentCount: post.comments.length }); });
  res.status(201).json({ comment, commentCount: post.comments.length });
});

app.delete('/api/posts/:id/comments/:cid', auth, (req, res) => {
  const db      = readDB();
  const post    = (db.posts || []).find(p => p.id === Number(req.params.id));
  if (!post) return res.status(404).json({ error: 'Not found' });
  const comment = (post.comments || []).find(c => c.id === Number(req.params.cid));
  if (!comment) return res.status(404).json({ error: 'Not found' });
  if (comment.userId !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden' });
  post.comments = post.comments.filter(c => c.id !== Number(req.params.cid));
  writeDB(db);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════
// PROFILE (self-service)
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/profile', auth, (req, res) => {
  const db   = readDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const team = getUserTeam(req.user.id, db);
  const { password, ...safe } = user;
  res.json({ user: { ...safe, teamName: team?.name || null } });
});

app.patch('/api/profile', auth, async (req, res) => {
  const { name, bio, newPassword } = req.body;
  const db   = readDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (name) user.name = name;
  if (bio !== undefined) user.bio = bio;
  if (newPassword) user.password = await bcrypt.hash(newPassword, 10);
  writeDB(db);
  const { password, ...safe } = user;
  res.json({ user: safe });
});

app.post('/api/profile/photo', auth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const db   = readDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    const ext      = path.extname(req.file.originalname) || '.jpg';
    const filename = `avatar-${req.user.id}-${Date.now()}${ext}`;
    const localPath = req.file.path ? `/uploads/avatars/${path.basename(req.file.path)}` : null;
    const photoUrl  = await uploadToStorage('avatars', filename, req.file.buffer || fs.readFileSync(req.file.path), req.file.mimetype, localPath);
    user.photoUrl = photoUrl;
    writeDB(db);
    res.json({ photoUrl });
  } catch (e) {
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/tasks', auth, (req, res) => {
  const db      = readDB();
  let tasks     = db.tasks || [];
  const userMap = Object.fromEntries(db.users.map(u => [u.id, u.name]));
  const teamMap = Object.fromEntries(db.teams.map(t => [t.id, t.name]));

  if (req.user.role === 'admin') {
    if (req.query.teamId) tasks = tasks.filter(t => t.teamId === Number(req.query.teamId));
  } else if (req.user.role === 'team_leader') {
    const myTeam = getUserTeam(req.user.id, db);
    tasks = myTeam
      ? tasks.filter(t => t.teamId === myTeam.id)
      : tasks.filter(t => t.createdBy === req.user.id);
  } else {
    // Agent: only tasks assigned to them or created by them
    tasks = tasks.filter(t => t.assignedTo === req.user.id || t.createdBy === req.user.id);
  }

  res.json({ tasks: [...tasks].reverse().map(t => ({
    ...t,
    createdByName:  userMap[t.createdBy]  || 'Unknown',
    assignedToName: userMap[t.assignedTo] || 'Unassigned',
    teamName:       teamMap[t.teamId]     || 'No Team',
  })) });
});

app.post('/api/tasks', auth, (req, res) => {
  if (req.user.role === 'agent') return res.status(403).json({ error: 'Only admin or team leaders can create tasks' });
  const { title, description, teamId, assignedTo, dueDate } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const db = readDB();
  if (!db.tasks) db.tasks = [];
  let effectiveTeamId = teamId ? Number(teamId) : null;
  if (req.user.role !== 'admin') {
    const myTeam = getUserTeam(req.user.id, db);
    effectiveTeamId = myTeam?.id || null;
  }
  const task = {
    id: genId(), title, description: description || '',
    teamId: effectiveTeamId, createdBy: req.user.id,
    assignedTo: assignedTo ? Number(assignedTo) : null,
    status: 'pending', dueDate: dueDate || null,
    createdAt: new Date().toISOString()
  };
  db.tasks.push(task);
  writeDB(db);
  res.status(201).json({ task });
});

app.patch('/api/tasks/:id', auth, (req, res) => {
  const db   = readDB();
  const task = (db.tasks || []).find(t => t.id === Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Not found' });
  const { status, title, description, dueDate, assignedTo } = req.body;
  if (status)                task.status      = status;
  if (title)                 task.title       = title;
  if (description !== undefined) task.description = description;
  if (dueDate      !== undefined) task.dueDate    = dueDate;
  if (assignedTo   !== undefined) task.assignedTo = assignedTo ? Number(assignedTo) : null;
  writeDB(db);
  res.json({ task });
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  const db   = readDB();
  const task = (db.tasks || []).find(t => t.id === Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (task.createdBy !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden' });
  db.tasks = db.tasks.filter(t => t.id !== Number(req.params.id));
  writeDB(db);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════
// PERSONAL TODOS
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/todos', auth, (req, res) => {
  const db = readDB();
  const todos = (db.todos || []).filter(t => t.userId === req.user.id);
  res.json({ todos: todos.reverse() });
});

app.post('/api/todos', auth, (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  const db = readDB();
  if (!db.todos) db.todos = [];
  const todo = { id: genId(), userId: req.user.id, text: text.trim(), done: false, createdAt: new Date().toISOString() };
  db.todos.push(todo);
  writeDB(db);
  res.status(201).json({ todo });
});

app.patch('/api/todos/:id', auth, (req, res) => {
  const db   = readDB();
  const todo = (db.todos || []).find(t => t.id === Number(req.params.id) && t.userId === req.user.id);
  if (!todo) return res.status(404).json({ error: 'Not found' });
  if (req.body.done !== undefined) todo.done = req.body.done;
  if (req.body.text) todo.text = req.body.text;
  writeDB(db);
  res.json({ todo });
});

app.delete('/api/todos/:id', auth, (req, res) => {
  const db = readDB();
  db.todos = (db.todos || []).filter(t => !(t.id === Number(req.params.id) && t.userId === req.user.id));
  writeDB(db);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════
// SIP + HEALTH
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/sip/registrations', auth, (req, res) => res.json({ registrations: getSipRegistrations() }));

app.get('/api/health', (req, res) => res.json({ status: 'ok', clients: wsClients.size, activeCalls: wsCalls.size }));

// ═══════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════
ensureAdmin().then(() => {
  const sipReady = initSip(JWT_SECRET);
  server.listen(PORT, () => {
    console.log(`\n✅ Server  → http://localhost:${PORT}`);
    console.log(`✅ Signals → ws://localhost:${PORT}/ws`);
    if (sipReady) console.log(`✅ Built-in SIP → ws://localhost:${PORT}/sip-ws`);
    console.log(`✅ Widget  → http://localhost:${PORT}/widget\n`);
  });
});
