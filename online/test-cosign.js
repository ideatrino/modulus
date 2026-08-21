/* ============================================================
   test-cosign.js — the post-match co-signature flow, end to end.
   Two real WebSocket clients play a full match, then each signs the
   byte-identical transcript and sends its signature through the relay.
   The relay only FORWARDS signatures (it holds no keys, can forge
   nothing). Each client assembles both signatures and submits the
   match to the live /api/submit ladder. Mirrors exactly what the
   browser client does at game over.
   Run:  node test-cosign.js
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PORT = process.env.PORT || '8096';
process.env.LADDER_FILE = path.join(os.tmpdir(), 'modulus-cosign-' + process.pid + '.json');
try { fs.unlinkSync(process.env.LADDER_FILE); } catch {}

const http = require('http');
const { WebSocket } = require('ws');
const M = require('./core.js');
require('./prod-server.js');

const HOST = '127.0.0.1', PORT = process.env.PORT, URL = `ws://${HOST}:${PORT}`;
let pass = 0, fail = 0;
const log = (ok, name, extra) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

function post(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: HOST, port: PORT, path: urlPath, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b || '{}') })); });
    r.on('error', reject); r.write(data); r.end();
  });
}
const get = (p) => new Promise((res, rej) => { http.get(`http://${HOST}:${PORT}${p}`, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); });

// A client that plays, then co-signs and submits — like the browser.
function Player(seed, kp, name) {
  const ws = new WebSocket(URL);
  const self = { role: null, transcript: null, pub: null, sig: null, peerPub: null, peerSig: null, submitted: null, done: false };
  const tp = {
    onEvent: () => {}, token: null,
    sendCommit(r, c) { ws.readyState === 1 && ws.send(JSON.stringify({ t: 'commit', round: r, c })); },
    sendReveal(r, m, nonce) { ws.readyState === 1 && ws.send(JSON.stringify({ t: 'reveal', round: r, m, nonce })); },
    close() { try { ws.close(); } catch {} }
  };
  let scriptedState = seed >>> 0;
  const pick = (round, state) => { scriptedState = (Math.imul(scriptedState, 1103515245) + 12345) & 0x7fffffff; return scriptedState % state.cfg.N; };

  ws.on('open', () => ws.send(JSON.stringify({ t: 'quickmatch', N: 11 })));
  ws.on('message', async (raw) => {
    const ev = JSON.parse(raw);
    if (ev.token) tp.token = ev.token;
    if (['role', 'commits', 'reveals', 'forfeit', 'peerLeft', 'resume'].includes(ev.t)) tp.onEvent(ev);
    if (ev.t === 'peerSig') { self.peerPub = ev.pub; self.peerSig = ev.sig; await maybeSubmit(); }
  });

  const client = new M.ProtocolClient(tp, {
    getMove: pick,
    onEnd: async (result, transcript, role) => {
      self.role = role; self.transcript = transcript;
      self.pub = await M.exportPub(kp.publicKey);
      self.sig = (await M.signMatch(kp.privateKey, 11, transcript)).sig;
      ws.send(JSON.stringify({ t: 'sig', pub: self.pub, sig: self.sig })); // hand my signature to the peer via the relay
      await maybeSubmit();
    }
  });

  async function maybeSubmit() {
    if (self.done || !self.sig || !self.peerSig || !self.transcript) return;
    self.done = true;
    const mine = { pub: self.pub, sig: self.sig }, peer = { pub: self.peerPub, sig: self.peerSig };
    const A = self.role === 'A' ? mine : peer, B = self.role === 'A' ? peer : mine;
    self.submitted = await post('/api/submit', { N: 11, transcript: self.transcript,
      pubA: A.pub, pubB: B.pub, sigA: A.sig, sigB: B.sig, nameA: self.role === 'A' ? name : 'peer', nameB: self.role === 'B' ? name : 'peer' });
    tp.close();
  }
  return self;
}

(async () => {
  await new Promise(r => setTimeout(r, 150));
  const kpA = await M.genKeyPair(), kpB = await M.genKeyPair();
  const pA = Player(11, kpA, 'North');
  const pB = Player(999, kpB, 'South');

  // wait for both to finish submitting
  await new Promise(res => { const iv = setInterval(() => { if (pA.submitted && pB.submitted) { clearInterval(iv); res(); } }, 30); });

  log(pA.transcript && pB.transcript, 'both clients completed a match');
  const identical = JSON.stringify(pA.transcript) === JSON.stringify(pB.transcript);
  log(identical, 'both hold the byte-identical transcript (lockstep)', `${pA.transcript.length} rounds`);

  // Both raced to submit: exactly one 200 and one 409 (replay) — the ladder counts it once.
  const statuses = [pA.submitted.status, pB.submitted.status].sort();
  const oneEach = statuses[0] === 200 && statuses[1] === 409;
  const bothOk = statuses[0] === 200 && statuses[1] === 200; // race lost to a hair — still fine if server counted once
  log(oneEach || bothOk, 'the co-signed match was submitted', `statuses=${statuses.join('/')}`);

  const accepted = [pA.submitted, pB.submitted].find(s => s.status === 200);
  log(accepted && accepted.json.ok && accepted.json.a && accepted.json.b, 'ladder accepted the co-signed match',
    accepted && accepted.json.ok ? `winner=${accepted.json.winner}, Δ ${accepted.json.a.delta}/${accepted.json.b.delta}` : '');

  const lb = await get('/api/leaderboard');
  log(lb.standings.length === 2, 'ladder now holds exactly two players (counted once)', `${lb.standings.length} players`);
  log(lb.stats.matches === 1, 'exactly one match recorded despite two submitters', `matches=${lb.stats.matches}`);

  try { fs.unlinkSync(process.env.LADDER_FILE); } catch {}
  console.log(`\n${fail === 0 ? '=== ALL CO-SIGN TESTS PASSED ===' : '*** ' + fail + ' FAILED ***'}  (${pass}/${pass + fail})`);
  process.exit(fail === 0 ? 0 : 1);
})();
