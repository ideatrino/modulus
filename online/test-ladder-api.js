/* ============================================================
   test-ladder-api.js — the live leaderboard HTTP API.
   Boots the real prod-server, submits a signed+audited match over
   HTTP, and checks the ladder reflects it, replay is rejected with
   409, and malformed submissions are rejected with 400.
   Run:  node test-ladder-api.js
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PORT = process.env.PORT || '8095';
process.env.LADDER_FILE = path.join(os.tmpdir(), 'modulus-api-ladder-' + process.pid + '.json');
try { fs.unlinkSync(process.env.LADDER_FILE); } catch {}

const http = require('http');
const M = require('./core.js');
require('./prod-server.js');

const HOST = '127.0.0.1', PORT = process.env.PORT;
let pass = 0, fail = 0;
const log = (ok, name, extra) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: HOST, port: PORT, path: urlPath, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { let j; try { j = JSON.parse(b); } catch { j = null; } resolve({ status: res.statusCode, json: j }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

async function simulate(N, pickA, pickB) {
  const st = M.newMatch(N); const transcript = []; let round = 1, guard = 0;
  while (!st.over && guard++ < 500) {
    const mA = pickA(round) % N, mB = pickB(round) % N;
    const nonceA = M.randNonce(), nonceB = M.randNonce();
    const cA = await M.sha256hex(mA + ':' + nonceA), cB = await M.sha256hex(mB + ':' + nonceB);
    const rec = M.resolveRound(st, mA, mB, nonceA, nonceB, round); rec.cA = cA; rec.cB = cB;
    transcript.push(rec); round++;
  }
  return transcript;
}

(async () => {
  await new Promise(r => setTimeout(r, 150)); // let listen() settle

  // empty ladder
  let lb = await req('GET', '/api/leaderboard');
  log(lb.status === 200 && lb.json.ok && lb.json.standings.length === 0, 'GET /api/leaderboard starts empty', `${lb.json.standings.length} players`);

  // build a signed match
  const N = 11;
  const kpA = await M.genKeyPair(), kpB = await M.genKeyPair();
  const pubA = await M.exportPub(kpA.publicKey), pubB = await M.exportPub(kpB.publicKey);
  const tr = await simulate(N, (r) => r * 3 + 1, () => 0);
  const sigA = (await M.signMatch(kpA.privateKey, N, tr)).sig;
  const sigB = (await M.signMatch(kpB.privateKey, N, tr)).sig;

  const sub = await req('POST', '/api/submit', { N, transcript: tr, pubA, pubB, sigA, sigB, nameA: 'Ada', nameB: 'Boole' });
  log(sub.status === 200 && sub.json.ok, 'POST /api/submit accepts a signed, audited match', sub.json && (sub.json.reason || `Δ ${sub.json.a.delta}/${sub.json.b.delta}`));

  lb = await req('GET', '/api/leaderboard');
  const two = lb.json.standings.length === 2;
  const ranked = two && lb.json.standings[0].rank === 1 && lb.json.standings[0].rating >= lb.json.standings[1].rating;
  log(two && ranked, 'ladder now lists both players, correctly ranked', two ? `top=${lb.json.standings[0].name} ${lb.json.standings[0].rating}` : '');

  const replay = await req('POST', '/api/submit', { N, transcript: tr, pubA, pubB, sigA, sigB });
  log(replay.status === 409 && !replay.json.ok, 'resubmitting the same match returns 409', replay.json && replay.json.reason);

  const forgedTr = await simulate(N, (r) => r + 1, (r) => r * 2);
  const kpX = await M.genKeyPair();
  const forgedSigB = (await M.signMatch(kpX.privateKey, N, forgedTr)).sig;
  const forgedSigA = (await M.signMatch(kpA.privateKey, N, forgedTr)).sig;
  const forged = await req('POST', '/api/submit', { N, transcript: forgedTr, pubA, pubB, sigA: forgedSigA, sigB: forgedSigB });
  log(forged.status === 409 && /signature/.test(forged.json.reason || ''), 'a forged submission is rejected over HTTP', forged.json && forged.json.reason);

  const bad = await req('POST', '/api/submit', { N, transcript: tr });
  log(bad.status === 400, 'a malformed submission returns 400', bad.json && bad.json.reason);

  const stats = await req('GET', '/api/stats');
  log(stats.status === 200 && stats.json.stats.players === 2 && stats.json.stats.matches === 1, 'GET /api/stats reports ladder size', stats.json && `players=${stats.json.stats.players} matches=${stats.json.stats.matches}`);

  const missing = await req('GET', '/api/nope');
  log(missing.status === 404, 'unknown /api endpoint returns 404');

  try { fs.unlinkSync(process.env.LADDER_FILE); } catch {}
  console.log(`\n${fail === 0 ? '=== ALL LADDER API TESTS PASSED ===' : '*** ' + fail + ' FAILED ***'}  (${pass}/${pass + fail})`);
  process.exit(fail === 0 ? 0 : 1);
})();
