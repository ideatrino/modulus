/* ============================================================
   MODULUS online — end-to-end integration test
   Starts the REAL relay and runs REAL WebSocket clients through a
   full match, then has BOTH clients independently audit the
   transcript. Also exercises the reveal-timeout forfeit path.
   Run:  node test-online.js
   ============================================================ */
process.env.PORT = process.env.PORT || '8090';
process.env.REVEAL_TIMEOUT_MS = '1500';          // short, for the forfeit test
const PORT = process.env.PORT;

const { WebSocket } = require('ws');
const M = require('./core.js');
require('./server.js');                            // starts the relay on PORT

const URL = `ws://127.0.0.1:${PORT}`;

/* A transport that maps the relay's messages onto ProtocolClient events. */
function NodeWSTransport(room, N) {
  const ws = new WebSocket(URL);
  const tp = {
    onEvent: () => {},
    sendCommit(round, c) { ws.send(JSON.stringify({ t: 'commit', round, c })); },
    sendReveal(round, m, nonce) { ws.send(JSON.stringify({ t: 'reveal', round, m, nonce })); },
    close() { ws.close(); }
  };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room, N })));
  ws.on('message', (raw) => {
    const ev = JSON.parse(raw);
    if (['role', 'commits', 'reveals', 'forfeit', 'peerLeft'].includes(ev.t)) tp.onEvent(ev);
  });
  return tp;
}

/* Deterministic scripted player so the match is reproducible and terminates. */
function scriptedMover(seed) {
  let s = seed >>> 0;
  return (round, state) => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s % state.cfg.N;
  };
}

function playFullMatch() {
  return new Promise((resolve, reject) => {
    const results = {};
    let ended = 0;
    const mk = (room, seed, tag) => new M.ProtocolClient(NodeWSTransport(room, 11), {
      getMove: scriptedMover(seed),
      onEnd: async (result, transcript, role) => {
        const a = await M.audit(11, transcript);
        results[tag] = { role, result, transcript, audit: a };
        if (++ended === 2) resolve(results);
      },
      onError: reject
    });
    mk('game1', 0xA11CE, 'A');
    mk('game1', 0xB0B, 'B');
    setTimeout(() => reject(new Error('match timed out')), 15000);
  });
}

/* Griefer: commits, then never reveals. Server must forfeit it. */
function playForfeit() {
  return new Promise((resolve, reject) => {
    // honest player A via ProtocolClient
    const honest = new M.ProtocolClient(NodeWSTransport('game2', 11), {
      getMove: scriptedMover(0x1234),
      onEnd: (result) => resolve(result)
    });
    // raw silent player B
    const ws = new WebSocket(URL);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room: 'game2', N: 11 })));
    ws.on('message', async (raw) => {
      const ev = JSON.parse(raw);
      if (ev.t === 'role') {
        const nonce = M.randNonce();
        const c = await M.sha256hex('4:' + nonce);
        ws.send(JSON.stringify({ t: 'commit', round: 1, c })); // commit, then stay silent forever
      }
    });
    setTimeout(() => reject(new Error('forfeit timed out')), 8000);
  });
}

(async () => {
  let pass = true;
  const log = (ok, label, extra) => { pass = pass && ok; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`); };

  console.log('\n=== MODULUS online integration test ===\n');

  // Scenario 1: full match, both clients audit independently
  const r = await playFullMatch();
  const A = r.A, B = r.B;
  log(A.transcript.length === B.transcript.length, 'both clients recorded the same number of rounds', `${A.transcript.length} rounds`);
  log(A.result.winner === B.result.winner, 'both clients agree on the winner', `winner = ${A.result.winner}`);
  const identical = JSON.stringify(A.transcript.map(x => [x.mA, x.mB, x.Ahp, x.Bhp, x.Ascore, x.Bscore]))
                  === JSON.stringify(B.transcript.map(x => [x.mA, x.mB, x.Ahp, x.Bhp, x.Ascore, x.Bscore]));
  log(identical, 'both transcripts are byte-identical (deterministic lockstep)');
  log(A.audit.ok, "A's independent audit verifies the match", `${A.audit.hashOK} commitments OK, state ${A.audit.stateOK ? 'reproduces' : 'MISMATCH'}`);
  log(B.audit.ok, "B's independent audit verifies the match", `${B.audit.hashOK} commitments OK`);
  log(A.audit.hashBad === 0 && B.audit.hashBad === 0, 'zero tampered commitments across both audits');

  // Tamper check: alter one move in a copied transcript, audit must fail
  const tampered = A.transcript.map(x => ({ ...x }));
  tampered[Math.floor(tampered.length / 2)].mA = (tampered[Math.floor(tampered.length / 2)].mA + 1) % 11;
  const ta = await M.audit(11, tampered);
  log(!ta.ok, 'a single altered move is detected by audit', `hashBad=${ta.hashBad}, stateOK=${ta.stateOK}`);

  // Scenario 2: griefer forfeits
  const f = await playForfeit();
  log(f.forfeit === true && f.winner === 'A', 'reveal-timeout forfeits the non-revealing player', `winner=${f.winner} reason="${f.reason}"`);

  console.log(`\n=== ${pass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'} ===\n`);
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
