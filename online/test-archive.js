/* ============================================================
   test-archive.js — match archive + the standalone verifier.
   Submits a real signed match, fetches its proof from the archive
   API, then runs the dependency-free verify.js on that proof as a
   separate process (no shared state) and confirms it prints VERIFIED
   and exits 0 — and that a tampered proof exits 1.
   Run:  node test-archive.js
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.PORT = process.env.PORT || '8101';
process.env.LADDER_FILE = path.join(os.tmpdir(), 'modulus-archive-' + process.pid + '.json');
try { fs.unlinkSync(process.env.LADDER_FILE); } catch {}

const http = require('http');
const M = require('./core.js');
require('./prod-server.js');

const HOST = '127.0.0.1', PORT = process.env.PORT;
let pass = 0, fail = 0;
const log = (ok, name, extra) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

function post(p, body) { return new Promise((resolve, reject) => { const data = JSON.stringify(body);
  const r = http.request({ host: HOST, port: PORT, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b || '{}') })); }); r.on('error', reject); r.write(data); r.end(); }); }
const get = (p) => new Promise((res, rej) => { http.get(`http://${HOST}:${PORT}${p}`, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, json: JSON.parse(d || '{}') })); }).on('error', rej); });

async function simulate(N, pa, pb) { const st = M.newMatch(N); const t = []; let round = 1, g = 0;
  while (!st.over && g++ < 500) { const mA = pa(round) % N, mB = pb(round) % N; const nA = M.randNonce(), nB = M.randNonce();
    const cA = await M.sha256hex(mA + ':' + nA), cB = await M.sha256hex(mB + ':' + nB);
    const rec = M.resolveRound(st, mA, mB, nA, nB, round); rec.cA = cA; rec.cB = cB; t.push(rec); round++; } return t; }

function runVerifier(proofObj) {
  const f = path.join(os.tmpdir(), 'proof-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(f, JSON.stringify(proofObj));
  try { const out = execFileSync('node', ['verify.js', f], { cwd: __dirname, encoding: 'utf8' }); return { code: 0, out }; }
  catch (e) { return { code: e.status || 1, out: (e.stdout || '') + (e.stderr || '') }; }
  finally { try { fs.unlinkSync(f); } catch {} }
}

(async () => {
  await new Promise(r => setTimeout(r, 150));
  const N = 11;
  const kpA = await M.genKeyPair(), kpB = await M.genKeyPair();
  const pubA = await M.exportPub(kpA.publicKey), pubB = await M.exportPub(kpB.publicKey);
  const tr = await simulate(N, (r) => r * 3 + 1, () => 0);
  const sigA = (await M.signMatch(kpA.privateKey, N, tr)).sig, sigB = (await M.signMatch(kpB.privateKey, N, tr)).sig;

  const sub = await post('/api/submit', { N, transcript: tr, pubA, pubB, sigA, sigB, nameA: 'Ada', nameB: 'Boole' });
  log(sub.status === 200 && sub.json.ok, 'match submitted and archived', sub.json && sub.json.digest && sub.json.digest.slice(0, 12));
  const digest = sub.json.digest;

  const idx = await get('/api/matches');
  log(idx.json.matches.length === 1 && idx.json.matches[0].digest === digest, 'GET /api/matches lists the archived match', `${idx.json.matches.length} match(es)`);

  const got = await get('/api/match/' + digest);
  log(got.status === 200 && got.json.proof && got.json.proof.transcript.length === tr.length, 'GET /api/match/:digest returns the full proof', `${got.json.proof.transcript.length} rounds`);

  const missing = await get('/api/match/deadbeef');
  log(missing.status === 404, 'unknown match digest returns 404');

  // Run the STANDALONE verifier on the fetched proof (separate process, no shared state).
  const proof = got.json.proof;
  const v = runVerifier(proof);
  log(v.code === 0 && /VERIFIED/.test(v.out) && !/NOT VERIFIED/.test(v.out), 'standalone verify.js confirms the fetched proof', 'exit ' + v.code);

  // Tamper a single move → verifier must fail.
  const badMove = JSON.parse(JSON.stringify(proof)); badMove.transcript[0].mA = (badMove.transcript[0].mA + 1) % N;
  const vm = runVerifier(badMove);
  log(vm.code === 1 && /NOT VERIFIED/.test(vm.out), 'verify.js rejects a tampered move', 'exit ' + vm.code);

  // Tamper a signature → verifier must fail.
  const badSig = JSON.parse(JSON.stringify(proof)); badSig.sigA = badSig.sigA.slice(0, -4) + (badSig.sigA.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  const vs = runVerifier(badSig);
  log(vs.code === 1 && /NOT VERIFIED/.test(vs.out), 'verify.js rejects a tampered signature', 'exit ' + vs.code);

  // A proof whose claimed winner disagrees with the replay → fail.
  const badWinner = JSON.parse(JSON.stringify(proof)); badWinner.winner = proof.winner === 'A' ? 'B' : 'A';
  const vw = runVerifier(badWinner);
  log(vw.code === 1, 'verify.js rejects a proof with a lied-about winner', 'exit ' + vw.code);

  try { fs.unlinkSync(process.env.LADDER_FILE); } catch {}
  console.log(`\n${fail === 0 ? '=== ALL ARCHIVE + VERIFIER TESTS PASSED ===' : '*** ' + fail + ' FAILED ***'}  (${pass}/${pass + fail})`);
  process.exit(fail === 0 ? 0 : 1);
})();
