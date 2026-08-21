/* ============================================================
   MODULUS production server — one port does everything.
   - Serves the browser client (static files) over HTTP.
   - Runs the trustless relay over WebSocket on the SAME port.
   - Reconnect grace: a dropped player can rejoin mid-match and resume.
   - Quick-match + lobby list.
   - Spectators: read-only, get the live provably-honest feed.

   The relay never computes a result and cannot forge one. It only
   sequences messages, holds reveals until both commitments are in,
   and forfeits a player who has seen both commitments then vanishes.

   Run:  node prod-server.js            (http://localhost:8080)
         PORT=80 node prod-server.js
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Leaderboard } = require('./store.js');

const PORT = parseInt(process.env.PORT || '8080', 10);
const REVEAL_TIMEOUT_MS = parseInt(process.env.REVEAL_TIMEOUT_MS || '30000', 10);
const GRACE_MS = parseInt(process.env.GRACE_MS || '20000', 10);
const LADDER_FILE = process.env.LADDER_FILE || path.join(__dirname, 'leaderboard.json');
const MAX_BODY = 256 * 1024; // signed transcripts are small; cap to avoid abuse
const VALID_N = new Set([7, 11, 13, 17, 23]);
const ROOT = __dirname;
const ladder = new Leaderboard(LADDER_FILE);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown', '.svg': 'image/svg+xml' };

const rooms = new Map();
const tok = () => crypto.randomBytes(12).toString('hex');
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const players = (r) => (r.seats.A ? 1 : 0) + (r.seats.B ? 1 : 0);
function bcastPlayers(r, o) { ['A', 'B'].forEach(s => r.seats[s] && send(r.seats[s].ws, o)); }
function bcastAll(r, o) { bcastPlayers(r, o); r.spectators.forEach(ws => send(ws, o)); }

function makeRoom(code, N) {
  return { code, N, seats: { A: null, B: null }, spectators: new Set(), round: 1,
    commits: {}, reveals: {}, commitsSent: false, history: [], revealTimer: null, grace: { A: null, B: null }, over: false };
}
function resetRound(r) { r.commits = {}; r.reveals = {}; r.commitsSent = false; if (r.revealTimer) { clearTimeout(r.revealTimer); r.revealTimer = null; } }
function closeRoom(r) { resetRound(r); ['A', 'B'].forEach(s => r.grace[s] && clearTimeout(r.grace[s])); r.over = true; rooms.delete(r.code); }

function startMatch(r) {
  send(r.seats.A.ws, { t: 'role', role: 'A', N: r.N, token: r.seats.A.token });
  send(r.seats.B.ws, { t: 'role', role: 'B', N: r.N, token: r.seats.B.token });
}
function tryCommits(r) {
  if (r.commits.A && r.commits.B && !r.commitsSent) {
    r.commitsSent = true;
    bcastAll(r, { t: 'commits', round: r.round, cA: r.commits.A, cB: r.commits.B });
    r.revealTimer = setTimeout(() => {
      const loser = !r.reveals.A ? 'A' : 'B';
      bcastAll(r, { t: 'forfeit', loser });
      closeRoom(r);
    }, REVEAL_TIMEOUT_MS);
  }
}
function tryReveals(r) {
  if (r.reveals.A && r.reveals.B) {
    const a = r.reveals.A, b = r.reveals.B;
    r.history.push({ round: r.round, mA: a.m, nonceA: a.nonce, mB: b.m, nonceB: b.nonce, cA: r.commits.A, cB: r.commits.B });
    bcastAll(r, { t: 'reveals', round: r.round, mA: a.m, nonceA: a.nonce, mB: b.m, nonceB: b.nonce });
    r.round++; resetRound(r);
  }
}
function joinAsPlayer(ws, room) {
  const seat = !room.seats.A ? 'A' : !room.seats.B ? 'B' : null;
  if (!seat) { send(ws, { t: 'err', msg: 'room full' }); return; }
  room.seats[seat] = { ws, token: tok() };
  ws._room = room; ws._seat = seat;
  send(ws, { t: 'seated', seat, N: room.N, room: room.code, token: room.seats[seat].token });
  if (room.seats.A && room.seats.B) startMatch(room);
  else send(ws, { t: 'wait' });
}

/* -------- HTTP: JSON API + static -------- */
const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };
// Simple per-IP token bucket for /api/submit: 20 submissions/minute. Submissions are
// already replay- and forgery-proof; this just bounds noise from a broken/abusive client.
const RL = new Map();
function rateLimited(req) {
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now(), win = 60000, max = 20;
  const e = RL.get(ip) || { n: 0, t: now };
  if (now - e.t > win) { e.n = 0; e.t = now; }
  e.n++; RL.set(ip, e);
  if (RL.size > 5000) for (const [k, v] of RL) if (now - v.t > win) RL.delete(k); // occasional GC
  return e.n > max;
}
function readBody(req, cb) {
  let buf = '', tooBig = false;
  req.on('data', c => { if (tooBig) return; buf += c; if (buf.length > MAX_BODY) { tooBig = true; } });
  req.on('end', () => { if (tooBig) return cb(new Error('body too large')); try { cb(null, buf ? JSON.parse(buf) : {}); } catch (e) { cb(e); } });
  req.on('error', e => cb(e));
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // ---- trustless leaderboard API ----
  if (urlPath === '/api/leaderboard' && req.method === 'GET') {
    return json(res, 200, { ok: true, standings: ladder.standings(100), stats: ladder.stats() });
  }
  if (urlPath === '/api/stats' && req.method === 'GET') {
    return json(res, 200, { ok: true, stats: ladder.stats(), rooms: [...rooms.values()].filter(r => !r.over).length });
  }
  if (urlPath === '/api/matches' && req.method === 'GET') {
    return json(res, 200, { ok: true, matches: ladder.recentMatches(40) });
  }
  if (urlPath.startsWith('/api/match/') && req.method === 'GET') {
    const digest = urlPath.slice('/api/match/'.length);
    const m = ladder.getMatch(digest);
    return m ? json(res, 200, { ok: true, proof: m }) : json(res, 404, { ok: false, reason: 'no such match' });
  }
  if (urlPath === '/api/submit' && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { ok: false, reason: 'too many submissions, slow down' });
    return readBody(req, async (err, body) => {
      if (err) return json(res, 400, { ok: false, reason: 'bad request: ' + err.message });
      if (!body || !body.transcript || !body.pubA || !body.pubB || !body.sigA || !body.sigB || !VALID_N.has(body.N)) {
        return json(res, 400, { ok: false, reason: 'missing or invalid fields' });
      }
      try {
        const r = await ladder.submit(body);
        return json(res, r.ok ? 200 : 409, r);
      } catch (e) { return json(res, 500, { ok: false, reason: 'server error' }); }
    });
  }
  if (urlPath.startsWith('/api/')) return json(res, 404, { ok: false, reason: 'no such endpoint' });

  // ---- static client ----
  let p = urlPath; if (p === '/') p = '/modulus-online.html';
  const filePath = path.join(ROOT, path.normalize(p));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* -------- WebSocket on the same port -------- */
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req)));

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'list') {
      const open = [...rooms.values()].filter(r => players(r) < 2 && !r.over)
        .map(r => ({ code: r.code, players: players(r), N: r.N, spectators: r.spectators.size }));
      return send(ws, { t: 'rooms', rooms: open });
    }
    if (msg.t === 'quickmatch') {
      let room = [...rooms.values()].find(r => players(r) === 1 && !r.over);
      if (!room) { const code = 'QM-' + tok().slice(0, 4).toUpperCase(); room = makeRoom(code, VALID_N.has(msg.N) ? msg.N : 11); rooms.set(code, room); }
      return joinAsPlayer(ws, room);
    }
    if (msg.t === 'join') {
      const code = String(msg.room || 'lobby').slice(0, 24);
      let room = rooms.get(code);
      if (msg.spectate) {
        if (!room) return send(ws, { t: 'err', msg: 'no such room' });
        room.spectators.add(ws); ws._room = room; ws._spectator = true;
        send(ws, { t: 'spectate', N: room.N, rounds: room.history });
        if (room.commitsSent) send(ws, { t: 'commits', round: room.round, cA: room.commits.A, cB: room.commits.B });
        return;
      }
      if (!room) { room = makeRoom(code, VALID_N.has(msg.N) ? msg.N : 11); rooms.set(code, room); }
      if (msg.resumeToken) {
        const seat = ['A', 'B'].find(s => room.seats[s] && room.seats[s].token === msg.resumeToken);
        if (seat) {
          if (room.grace[seat]) { clearTimeout(room.grace[seat]); room.grace[seat] = null; }
          room.seats[seat].ws = ws; ws._room = room; ws._seat = seat;
          return send(ws, { t: 'resume', role: seat, N: room.N, rounds: room.history, token: room.seats[seat].token });
        }
      }
      return joinAsPlayer(ws, room);
    }

    const room = ws._room; if (!room || ws._spectator) return;
    const seat = ws._seat; if (!seat) return;
    if (msg.t === 'commit' && msg.round === room.round) { room.commits[seat] = String(msg.c).slice(0, 64); tryCommits(room); }
    else if (msg.t === 'reveal' && msg.round === room.round && room.commitsSent) { room.reveals[seat] = { m: msg.m | 0, nonce: String(msg.nonce).slice(0, 64) }; tryReveals(room); }
    // Post-match co-signature: the relay only FORWARDS each player's signature to
    // the other. It cannot forge one (no private keys) and cannot alter the match
    // (the signature binds the exact transcript). Either player then submits the
    // fully co-signed match to /api/submit; the ladder verifies both sigs + audits.
    else if (msg.t === 'sig') {
      const other = seat === 'A' ? 'B' : 'A';
      if (room.seats[other]) send(room.seats[other].ws, { t: 'peerSig', role: seat, pub: msg.pub, sig: msg.sig });
    }
  });

  ws.on('close', () => {
    const room = ws._room; if (!room) return;
    if (ws._spectator) { room.spectators.delete(ws); return; }
    const seat = ws._seat;
    if (!seat || !room.seats[seat] || room.seats[seat].ws !== ws || room.over) return;
    // Seen both commitments then vanished → forfeit (no peek-and-run).
    if (room.commitsSent) { bcastAll(room, { t: 'forfeit', loser: seat }); return closeRoom(room); }
    // Otherwise allow a grace window to reconnect and resume.
    room.grace[seat] = setTimeout(() => {
      const other = seat === 'A' ? 'B' : 'A';
      if (room.seats[other]) send(room.seats[other].ws, { t: 'peerLeft' });
      room.spectators.forEach(s => send(s, { t: 'peerLeft' }));
      closeRoom(room);
    }, GRACE_MS);
  });
});

server.listen(PORT, () => console.log(`MODULUS server on http://0.0.0.0:${PORT}  (ws same port · reveal ${REVEAL_TIMEOUT_MS}ms · grace ${GRACE_MS}ms)`));
module.exports = { server, wss };
