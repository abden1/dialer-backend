/**
 * sip-server.js — Built-in SIP over WebSocket registrar + call proxy
 *
 * Agents connect via JsSIP and call each other by username/extension.
 * No external service needed. For PSTN (real numbers) configure an
 * outbound SIP trunk in the Settings page.
 *
 * Protocol: SIP/2.0 over WebSocket (RFC 7118)
 * Auth:     JWT token in WS query string (?token=...)
 *
 * NOTE: Uses noServer:true — the parent server.js dispatches upgrades
 * for /sip-ws here via handleSipUpgrade().
 */

const WebSocket = require('ws');
const jwt       = require('jsonwebtoken');
let   sipPkg;
try { sipPkg = require('sip'); } catch { /* installed separately */ }

const sipClients = new Map(); // extension → { ws, contact }
const sipCalls   = new Map(); // callId → { callerWs, calleeWs, invite }

// noServer:true — we handle the HTTP upgrade manually so we can share
// one HTTP server with the /ws signaling endpoint without conflicts.
const sipWss = sipPkg
  ? new WebSocket.Server({
      noServer: true,
      // Echo back "sip" subprotocol as required by RFC 7118 / JsSIP
      handleProtocols: (protocols) => protocols.has('sip') ? 'sip' : false,
    })
  : null;

let _jwtSecret = 'dialer-secret-dev-key';
let _wsClients = null; // shared presence map from server.js

function sipSend(ws, msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(typeof msg === 'string' ? msg : sipPkg.stringify(msg));
  }
}

function parseExt(uriOrObj) {
  if (!uriOrObj) return null;
  if (typeof uriOrObj === 'string') {
    try { return sipPkg.parseUri(uriOrObj)?.user || null; } catch { return null; }
  }
  return uriOrObj.user || null;
}

if (sipWss) {
  sipWss.on('connection', (ws, req) => {
    const url   = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    let sipUser;
    try {
      sipUser = jwt.verify(token, _jwtSecret);
      ws._sipUser = sipUser;
    } catch {
      ws.close(4001, 'Unauthorized');
      return;
    }

    console.log(`[SIP] 📲 ${sipUser.username} connected`);

    ws.on('message', (data) => {
      const raw = data.toString();
      let msg;
      try { msg = sipPkg.parse(raw); } catch { return; }

      const method = msg.method?.toUpperCase();

      // ── REGISTER ────────────────────────────────────────────────────
      if (method === 'REGISTER') {
        const ext     = parseExt(msg.headers.from?.uri) || sipUser.username;
        const expires = parseInt(
          msg.headers.expires ??
          msg.headers.contact?.[0]?.params?.expires ??
          300
        );

        if (expires === 0) {
          sipClients.delete(ext);
          console.log(`[SIP] ↩ ${ext} unregistered`);
        } else {
          ws._sipExtension = ext;
          sipClients.set(ext, { ws, contact: msg.headers.contact?.[0]?.uri });
          // Do NOT overwrite wsClients here — the WebRTC presence phone already
          // registered this agent with the correct JSON-signaling WebSocket.
          // Overwriting with the SIP socket would break agent-to-agent call routing.
          console.log(`[SIP] ✅ ${ext} registered (expires=${expires}s)`);
        }

        const ok = sipPkg.makeResponse(msg, 200, 'OK');
        ok.headers.contact = msg.headers.contact;
        ok.headers.expires = String(expires);
        sipSend(ws, ok);

      // ── OPTIONS (keepalive) ──────────────────────────────────────────
      } else if (method === 'OPTIONS') {
        const ok = sipPkg.makeResponse(msg, 200, 'OK');
        ok.headers.allow = 'INVITE, ACK, CANCEL, BYE, OPTIONS, REGISTER';
        ok.headers['content-length'] = 0;
        sipSend(ws, ok);

      // ── INVITE (new call) ────────────────────────────────────────────
      } else if (method === 'INVITE') {
        const callId    = msg.headers['call-id'];
        const calleeExt = parseExt(msg.headers.to?.uri);

        sipSend(ws, sipPkg.makeResponse(msg, 100, 'Trying'));

        const calleeReg = sipClients.get(calleeExt);
        if (!calleeReg || calleeReg.ws.readyState !== WebSocket.OPEN) {
          console.log(`[SIP] 📵 ${calleeExt} not found`);
          sipSend(ws, sipPkg.makeResponse(msg, 404, 'Not Found'));
          return;
        }

        sipCalls.set(callId, { callerWs: ws, calleeWs: calleeReg.ws, invite: msg });
        console.log(`[SIP] 📞 ${ws._sipExtension} → ${calleeExt}`);
        calleeReg.ws.send(raw);

      // ── ACK ──────────────────────────────────────────────────────────
      } else if (method === 'ACK') {
        const call = sipCalls.get(msg.headers['call-id']);
        if (!call) return;
        const target = ws === call.callerWs ? call.calleeWs : call.callerWs;
        if (target?.readyState === WebSocket.OPEN) target.send(raw);

      // ── BYE ──────────────────────────────────────────────────────────
      } else if (method === 'BYE') {
        const callId = msg.headers['call-id'];
        sipSend(ws, sipPkg.makeResponse(msg, 200, 'OK'));
        const call = sipCalls.get(callId);
        if (call) {
          const target = ws === call.callerWs ? call.calleeWs : call.callerWs;
          if (target?.readyState === WebSocket.OPEN) target.send(raw);
          sipCalls.delete(callId);
        }

      // ── CANCEL ───────────────────────────────────────────────────────
      } else if (method === 'CANCEL') {
        const callId = msg.headers['call-id'];
        sipSend(ws, sipPkg.makeResponse(msg, 200, 'OK'));
        const call = sipCalls.get(callId);
        if (call) {
          if (call.invite) sipSend(ws, sipPkg.makeResponse(call.invite, 487, 'Request Terminated'));
          if (call.calleeWs?.readyState === WebSocket.OPEN) call.calleeWs.send(raw);
          sipCalls.delete(callId);
        }

      // ── Response (relay) ──────────────────────────────────────────────
      } else if (!method && msg.status) {
        const callId = msg.headers['call-id'];
        const call   = sipCalls.get(callId);
        if (!call) return;
        const target = ws === call.calleeWs ? call.callerWs : call.calleeWs;
        if (target?.readyState === WebSocket.OPEN) target.send(raw);
        if (msg.status >= 300) sipCalls.delete(callId);
      }
    });

    ws.on('close', () => {
      if (ws._sipExtension) {
        sipClients.delete(ws._sipExtension);
        console.log(`[SIP] 📴 ${ws._sipExtension} disconnected`);
      }
      for (const [callId, call] of sipCalls) {
        if (call.callerWs === ws || call.calleeWs === ws) sipCalls.delete(callId);
      }
    });

    ws.on('error', () => {});
  });
}

/**
 * Called from server.js's upgrade handler for /sip-ws requests.
 * Returns true if handled, false if SIP package not available.
 */
function handleSipUpgrade(req, socket, head) {
  if (!sipWss) {
    socket.write('HTTP/1.1 503 SIP package not installed\r\n\r\n');
    socket.destroy();
    return false;
  }
  sipWss.handleUpgrade(req, socket, head, (ws) => sipWss.emit('connection', ws, req));
  return true;
}

function init(jwtSecret, wsClients) {
  _jwtSecret = jwtSecret;
  _wsClients = wsClients || null;
  if (!sipPkg) {
    console.warn('[SIP] ⚠ sip package not installed — run: npm install sip in backend/');
    return false;
  }
  return true;
}

function getSipRegistrations() {
  const result = [];
  for (const [ext, reg] of sipClients) {
    if (reg.ws.readyState === WebSocket.OPEN) result.push({ extension: ext });
  }
  return result;
}

module.exports = { init, handleSipUpgrade, getSipRegistrations };
