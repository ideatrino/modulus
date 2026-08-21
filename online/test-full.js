/* ============================================================
   MODULUS production — full integration test
   Exercises the real prod-server over real sockets:
     1. static hosting        (HTTP serves the client + core.js)
     2. quick-match           (auto-pairs two strangers)
     3. reconnect / resume    (a player drops mid-match and rejoins)
     4. spectator             (read-only live feed, then audits)
     5. trustless rating      (signed + audited; forgery/tamper rejected)
   Run:  node test-full.js
   ============================================================ */
process.env.PORT = process.env.PORT || '8091';
process.env.REVEAL_TIMEOUT_MS = '4000';
process.env.GRACE_MS = '5000';
const PORT = process.env.PORT;
const URL = `ws://127.0.0.1:${PORT}`;

const http = require('http');
const { WebSocket } = require('ws');
const M = require('./core.js');
const R = require('./rating.js');
require('./prod-server.js');

let pass = true;
const log = (ok, label, extra) => { pass = pass && ok; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`); };

function Transport(opts) {
  const ws = new WebSocket(URL);
  const tp = {
    onEvent: () => {}, onServer: opts.onServer || (() => {}), token: null,
    sendCommit(r, c) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'commit', round: r, c })); },
    sendReveal(r, m, nonce) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'reveal', round: r, m, nonce })); },
    close() { try { ws.close(); } catch (e) {} }, raw: ws
  };
  ws.on('open', () => {
    if (opts.quickmatch) ws.send(JSON.stringify({ t: 'quickmatch', N: opts.N }));
    else ws.send(JSON.stringify({ t: 'join', room: opts.room, N: opts.N, spectate: !!opts.spectate, resumeToken: opts.resumeToken }));
  });
  ws.on('message', (raw) => {
    const ev = JSON.parse(raw);
    if (ev.token) tp.token = ev.token;
    tp.onServer(ev);
    if (['role', 'commits', 'reveals', 'forfeit', 'peerLeft', 'resume', 'spectate'].includes(ev.t)) tp.onEvent(ev);
  });
  return tp;
}
const scripted = (seed) => { let s = seed >>> 0; return (round, state) => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s % state.cfg.N; }; };
const httpGet = (p) => new Promise((res, rej) => { http.get(URL.replace('ws', 'http') + p, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d })); }).on('error', rej); });

/* 1. static hosting */
async function testStatic() {
  const client = await httpGet('/');            // → modulus-online.html
  const core = await httpGet('/core.js');
  log(client.status === 200 && /MODULUS/.test(client.body), 'HTTP serves the browser client at /');
  log(core.status === 200 && /ProtocolClient/.test(core.body), 'HTTP serves core.js');
}

/* 2. quick-match */
function testQuickmatch() {
  return new Promise((resolve) => {
    const out = {}; let done = 0;
    const mk = (seed, tag) => new M.ProtocolClient(Transport({ quickmatch: true, N: 11 }), {
      getMove: scripted(seed),
      onEnd: async (result, transcript, role) => { out[tag] = { role, result, transcript, audit: await M.audit(11, transcript) }; if (++done === 2) finish(); }
    });
    function finish() {
      const a = out.x, b = out.y;
      log(a.role !== b.role, 'quick-match paired two strangers into A and B', `${a.role}/${b.role}`);
      log(a.result.winner === b.result.winner, 'both agree on the winner', a.result.winner);
      log(a.audit.ok && b.audit.ok, 'both independently audit the quick-match');
      resolve(out);
    }
    mk(0x1111, 'x'); setTimeout(() => mk(0x2222, 'y'), 40);
  });
}

/* 3. reconnect / resume */
function testReconnect() {
  return new Promise((resolve) => {
    let aTok = null, dropped = false, results = {}, done = 0;
    const finish = () => { if (++done === 2) {
      log(results.A && results.B, 'match completed after a mid-match reconnect');
      log(results.A.result.winner === results.B.result.winner, 'winner consistent across the reconnect', results.A.result.winner);
      log(results.A.audit.ok && results.B.audit.ok, 'both final transcripts audit clean');
      resolve();
    } };
    // Player B stays connected the whole time
    new M.ProtocolClient(Transport({ room: 'RC', N: 11 }), {
      getMove: scripted(0xBBBB),
      onEnd: async (result, transcript) => { results.B = { result, audit: await M.audit(11, transcript) }; finish(); }
    });
    // Player A drops right after round 2 resolves, then rejoins with its token
    const tpA = Transport({ room: 'RC', N: 11 });
    new M.ProtocolClient(tpA, {
      getMove: scripted(0xAAAA),
      onResolve: (state, rec) => {
        if (rec.round === 2 && !dropped) {
          dropped = true; aTok = tpA.token;
          tpA.close();                              // network drop between rounds
          setTimeout(() => {                        // reconnect within the grace window
            const tpA2 = Transport({ room: 'RC', N: 11, resumeToken: aTok });
            new M.ProtocolClient(tpA2, {
              getMove: scripted(0xCCCC),
              onEnd: async (result, transcript) => { results.A = { result, audit: await M.audit(11, transcript) }; finish(); }
            });
          }, 300);
        }
      },
      onEnd: () => {}                                // original A client is abandoned on drop
    });
  });
}

/* 4. spectator */
function testSpectator() {
  return new Promise((resolve) => {
    let specStarted = false, playersDone = 0, specResult = null;
    const maybe = () => { if (playersDone === 2 && specResult) {
      log(specResult.audit.rounds >= 1, 'spectator received the full live feed', `${specResult.audit.rounds} rounds`);
      log(specResult.audit.ok, 'spectator can independently audit what it watched');
      resolve();
    } };
    const startSpectator = () => {
      if (specStarted) return; specStarted = true;
      new M.ProtocolClient(Transport({ room: 'SPEC', N: 11, spectate: true }), {
        spectator: true, getMove: () => 0,
        onEnd: async (result, transcript) => { specResult = { result, audit: await M.audit(11, transcript) }; maybe(); }
      });
    };
    const mkPlayer = (seed) => new M.ProtocolClient(Transport({ room: 'SPEC', N: 11 }), {
      getMove: scripted(seed),
      onResolve: (s, rec) => { if (rec.round === 1) startSpectator(); },   // spectator joins after round 1
      onEnd: () => { playersDone++; maybe(); }
    });
    mkPlayer(0xD1); setTimeout(() => mkPlayer(0xD2), 40);
  });
}

/* 5. trustless rating (uses the quick-match transcript) */
async function testRating(qm) {
  const tr = qm.x.transcript, N = 11;
  const kpA = await M.genKeyPair(), kpB = await M.genKeyPair();
  const pubA = await M.exportPub(kpA.publicKey), pubB = await M.exportPub(kpB.publicKey);
  const sA = await M.signMatch(kpA.privateKey, N, tr), sB = await M.signMatch(kpB.privateKey, N, tr);
  const good = await R.rateMatch({ N, transcript: tr, ratingA: 1500, ratingB: 1500, pubA, pubB, sigA: sA.sig, sigB: sB.sig });
  log(good.ok && (good.deltaA + good.deltaB === 0), 'valid signed match updates Elo', `Δ ${good.deltaA}/${good.deltaB}`);

  // forged signature
  const kpX = await M.genKeyPair(); const sX = await M.signMatch(kpX.privateKey, N, tr);
  const forged = await R.rateMatch({ N, transcript: tr, ratingA: 1500, ratingB: 1500, pubA, pubB, sigA: sX.sig, sigB: sB.sig });
  log(!forged.ok, 'forged signature rejected', forged.reason);

  // tamper the transcript but re-sign the tampered version → audit must catch it
  const bad = tr.map(r => ({ ...r })); bad[Math.min(1, bad.length - 1)].mA = (bad[Math.min(1, bad.length - 1)].mA + 1) % N;
  const sA2 = await M.signMatch(kpA.privateKey, N, bad), sB2 = await M.signMatch(kpB.privateKey, N, bad);
  const tampered = await R.rateMatch({ N, transcript: bad, ratingA: 1500, ratingB: 1500, pubA, pubB, sigA: sA2.sig, sigB: sB2.sig });
  log(!tampered.ok, 'tampered-then-resigned match rejected by audit', tampered.reason);
}

(async () => {
  console.log('\n=== MODULUS production integration test ===\n');
  await testStatic();
  const qm = await testQuickmatch();
  await testReconnect();
  await testSpectator();
  await testRating(qm);
  console.log(`\n=== ${pass ? 'ALL PRODUCTION TESTS PASSED' : 'SOME TESTS FAILED'} ===\n`);
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
