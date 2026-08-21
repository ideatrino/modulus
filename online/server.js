/* ============================================================
   MODULUS relay server
   ------------------------------------------------------------
   A trustless notary. It ONLY: pairs two players into a room,
   holds each round's reveals until BOTH commitments are in (so
   nobody reveals early), then releases both reveals together, and
   forfeits a player who fails to reveal before the deadline.

   It never sees a move before it is committed, never computes a
   result, and cannot forge one — every client verifies and
   resolves the game itself from the transcript. A malicious server
   can at worst refuse service, not cheat the outcome.

   Run:  node server.js            (defaults to port 8080)
         PORT=9000 node server.js
   ============================================================ */
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8080', 10);
const REVEAL_TIMEOUT_MS = parseInt(process.env.REVEAL_TIMEOUT_MS || '30000', 10);
const VALID_N = new Set([7, 11, 13, 17, 23]);

const rooms = new Map(); // code -> room

function makeRoom(code, N) {
  return { code, N, seats: { A: null, B: null }, round: 1, commits: {}, reveals: {}, timer: null };
}
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function both(room, obj) { send(room.seats.A, obj); send(room.seats.B, obj); }
function roleOf(room, ws) { return room.seats.A === ws ? 'A' : room.seats.B === ws ? 'B' : null; }

function resetRound(room) {
  room.commits = {}; room.reveals = {};
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

function tryReleaseCommits(room) {
  if (room.commits.A && room.commits.B && !room._commitsSent) {
    room._commitsSent = true;
    both(room, { t: 'commits', round: room.round, cA: room.commits.A, cB: room.commits.B });
    // anti-griefing: start the reveal deadline the moment both are sealed
    room.timer = setTimeout(() => {
      const missA = !room.reveals.A, missB = !room.reveals.B;
      let loser = missA && missB ? 'A' : missA ? 'A' : 'B'; // if both, arbitrate to A; rarely happens
      both(room, { t: 'forfeit', loser });
      closeRoom(room);
    }, REVEAL_TIMEOUT_MS);
  }
}
function tryReleaseReveals(room) {
  if (room.reveals.A && room.reveals.B) {
    const rA = room.reveals.A, rB = room.reveals.B;
    both(room, { t: 'reveals', round: room.round, mA: rA.m, nonceA: rA.nonce, mB: rB.m, nonceB: rB.nonce });
    // advance to next round
    room.round++; room._commitsSent = false; resetRound(room);
  }
}
function closeRoom(room) {
  resetRound(room);
  rooms.delete(room.code);
}

const wss = new WebSocketServer({ port: PORT });
console.log(`MODULUS relay listening on ws://0.0.0.0:${PORT}  (reveal timeout ${REVEAL_TIMEOUT_MS}ms)`);

wss.on('connection', (ws) => {
  ws._room = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'join') {
      const code = String(msg.room || '').slice(0, 24) || 'lobby';
      let room = rooms.get(code);
      if (!room) {
        const N = VALID_N.has(msg.N) ? msg.N : 11;
        room = makeRoom(code, N); rooms.set(code, room);
      }
      const seat = !room.seats.A ? 'A' : !room.seats.B ? 'B' : null;
      if (!seat) { send(ws, { t: 'err', msg: 'room full' }); return; }
      room.seats[seat] = ws; ws._room = room; ws._seat = seat;
      send(ws, { t: 'seated', seat, N: room.N });
      if (room.seats.A && room.seats.B) {
        // both present → start the match
        send(room.seats.A, { t: 'role', role: 'A', N: room.N });
        send(room.seats.B, { t: 'role', role: 'B', N: room.N });
      } else {
        send(ws, { t: 'wait' });
      }
      return;
    }

    const room = ws._room; if (!room) return;
    const role = roleOf(room, ws); if (!role) return;

    if (msg.t === 'commit' && msg.round === room.round) {
      room.commits[role] = String(msg.c).slice(0, 64);
      tryReleaseCommits(room);
    } else if (msg.t === 'reveal' && msg.round === room.round) {
      // only accept a reveal once both commits are out
      if (!room._commitsSent) return;
      room.reveals[role] = { m: msg.m | 0, nonce: String(msg.nonce).slice(0, 64) };
      tryReleaseReveals(room);
    }
  });

  ws.on('close', () => {
    const room = ws._room; if (!room) return;
    const other = room.seats.A === ws ? room.seats.B : room.seats.A;
    send(other, { t: 'peerLeft' });
    closeRoom(room);
  });
});

module.exports = { wss, PORT };
