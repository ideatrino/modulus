/* ============================================================
   test-leaderboard.js — the persistent trustless ladder.
   Simulates real matches through core.resolveRound (same rows the
   live client signs), then checks: Elo moves, standings sort,
   replay is rejected, self-play is rejected, forgery is rejected,
   and ratings survive a reload from disk.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const os = require('os');
const M = require('./core.js');
const { Leaderboard, idOf, BASE_RATING } = require('./store.js');

let pass = 0, fail = 0;
const log = (ok, name, extra) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

/* Play a full, honest match. pickA/pickB choose a residue each round.
   Produces exactly the transcript rows the ProtocolClient would sign. */
async function simulate(N, pickA, pickB) {
  const st = M.newMatch(N);
  const transcript = [];
  let round = 1, guard = 0;
  while (!st.over && guard++ < 500) {
    const mA = pickA(round, st) % N, mB = pickB(round, st) % N;
    const nonceA = M.randNonce(), nonceB = M.randNonce();
    const cA = await M.sha256hex(mA + ':' + nonceA);
    const cB = await M.sha256hex(mB + ':' + nonceB);
    const rec = M.resolveRound(st, mA, mB, nonceA, nonceB, round);
    rec.cA = cA; rec.cB = cB;
    transcript.push(rec);
    round++;
  }
  return transcript;
}

async function signed(N, transcript, kp) {
  const s = await M.signMatch(kp.privateKey, N, transcript);
  return s.sig;
}

(async () => {
  const N = 11;
  const tmp = path.join(os.tmpdir(), 'modulus-ldr-' + process.pid + '.json');
  try { fs.unlinkSync(tmp); } catch {}
  const lb = new Leaderboard(tmp);

  const kpA = await M.genKeyPair(), kpB = await M.genKeyPair();
  const pubA = await M.exportPub(kpA.publicKey), pubB = await M.exportPub(kpB.publicKey);

  // Match 1: A leans on a strong deterministic pattern vs B's fixed move.
  const t1 = await simulate(N, (r) => (r * 3 + 1), () => 0);
  const a1 = await M.audit(N, t1);
  log(a1.ok && a1.final, 'simulated match 1 is a valid, completed transcript', `winner=${a1.final && a1.final.winner}, ${t1.length} rounds`);

  const sub1 = await lb.submit({ N, transcript: t1, pubA, pubB,
    sigA: await signed(N, t1, kpA), sigB: await signed(N, t1, kpB), nameA: 'Ada', nameB: 'Boole' });
  log(sub1.ok, 'match 1 accepted and rated', sub1.ok ? `Δ ${sub1.a.delta}/${sub1.b.delta}` : sub1.reason);

  const movedFromBase = sub1.ok && sub1.a.rating !== BASE_RATING && sub1.b.rating !== BASE_RATING;
  log(movedFromBase, 'both ratings moved off the 1200 base', sub1.ok ? `${sub1.a.rating}/${sub1.b.rating}` : '');

  const zeroSum = sub1.ok && (sub1.a.delta + sub1.b.delta === 0);
  log(zeroSum, 'Elo deltas are zero-sum', sub1.ok ? `${sub1.a.delta} + ${sub1.b.delta}` : '');

  // Replay guard: the identical signed transcript must not count twice.
  const replay = await lb.submit({ N, transcript: t1, pubA, pubB,
    sigA: await signed(N, t1, kpA), sigB: await signed(N, t1, kpB) });
  log(!replay.ok && /replay|already/.test(replay.reason), 'resubmitting the same match is rejected', replay.reason);

  const afterReplay = lb.standings();
  const ratingsUnchanged = afterReplay.find(p => p.name === 'Ada').rating === sub1.a.rating;
  log(ratingsUnchanged, 'replay did not change any rating');

  // Self-play: same identity on both sides is meaningless and rejected.
  const selfT = await simulate(N, (r) => r * 2, (r) => r);
  const selfSubmit = await lb.submit({ N, transcript: selfT, pubA, pubB: pubA,
    sigA: await signed(N, selfT, kpA), sigB: await signed(N, selfT, kpA) });
  log(!selfSubmit.ok && /themsel|cannot/.test(selfSubmit.reason), 'a player cannot rate a match against themselves', selfSubmit.reason);

  // Forgery: a third party's signature cannot stand in for B.
  const kpX = await M.genKeyPair();
  const t2 = await simulate(N, (r) => r + 2, (r) => r * 4);
  const forged = await lb.submit({ N, transcript: t2, pubA, pubB,
    sigA: await signed(N, t2, kpA), sigB: await signed(N, t2, kpX) });
  log(!forged.ok && /signature/.test(forged.reason), 'a forged signature is rejected', forged.reason);

  // A genuinely different second match between the same two players DOES count.
  const good2 = await lb.submit({ N, transcript: t2, pubA, pubB,
    sigA: await signed(N, t2, kpA), sigB: await signed(N, t2, kpB) });
  log(good2.ok, 'a distinct second match between the same players counts', good2.ok ? `Δ ${good2.a.delta}/${good2.b.delta}` : good2.reason);

  const gamesCounted = lb.standings().find(p => p.name === 'Ada').games === 2;
  log(gamesCounted, 'game counts accumulate across matches', `Ada games=${lb.standings().find(p=>p.name==='Ada').games}`);

  // Persistence: a brand-new store reading the same file sees the same ladder.
  const reloaded = new Leaderboard(tmp);
  const before = lb.standings(), after = reloaded.standings();
  const identical = JSON.stringify(before) === JSON.stringify(after);
  log(identical, 'ratings persist across a reload from disk', `${after.length} players, top=${after[0].name} ${after[0].rating}`);

  // Replay guard also survives reload (seen-set persisted).
  const replayAfterReload = await reloaded.submit({ N, transcript: t1, pubA, pubB,
    sigA: await signed(N, t1, kpA), sigB: await signed(N, t1, kpB) });
  log(!replayAfterReload.ok, 'replay guard persists across reload', replayAfterReload.reason);

  // Identity is stable and derived from the key, not the name.
  log(idOf(pubA) === idOf(pubA) && idOf(pubA) !== idOf(pubB), 'identity is a stable per-key fingerprint');

  try { fs.unlinkSync(tmp); } catch {}
  console.log(`\n${fail === 0 ? '=== ALL LEADERBOARD TESTS PASSED ===' : '*** ' + fail + ' FAILED ***'}  (${pass}/${pass + fail})`);
  process.exit(fail === 0 ? 0 : 1);
})();
