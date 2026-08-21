#!/usr/bin/env node
/* ============================================================
   MODULUS verifier — trust nothing.

   Independently verifies a match proof with NO server and NO
   network. Give it a proof file (the JSON you exported from the
   game, or fetched from /api/match/:digest) and it will:

     1. recompute the transcript digest,
     2. check BOTH players' ECDSA signatures over that digest,
     3. re-hash every commitment (H(move+nonce) == commitment),
     4. replay the whole match from the revealed moves and confirm
        the recorded final state reproduces exactly.

   If all four pass, the match provably happened as recorded and
   both players provably agreed to it. A single altered byte — a
   move, a nonce, a score, a signature — fails verification.

   Usage:
     node verify.js path/to/proof.json
     cat proof.json | node verify.js -
   Exit code 0 = verified, 1 = failed/invalid.
   ============================================================ */
const fs = require('fs');
const M = require('./core.js');

function readInput() {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: node verify.js <proof.json>   (or "-" for stdin)'); process.exit(2); }
  const raw = arg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8');
  return JSON.parse(raw);
}

async function verify(proof) {
  const need = ['N', 'transcript', 'pubA', 'pubB', 'sigA', 'sigB'];
  for (const k of need) if (proof[k] === undefined) return { ok: false, reason: `proof is missing "${k}"` };
  if (!Array.isArray(proof.transcript) || proof.transcript.length === 0) return { ok: false, reason: 'transcript is empty' };

  // 1 + 2: digest and both signatures.
  const digest = await M.hashTranscript(proof.N, proof.transcript);
  const okA = await M.verifyStr(proof.pubA, digest, proof.sigA).catch(() => false);
  const okB = await M.verifyStr(proof.pubB, digest, proof.sigB).catch(() => false);

  // 3 + 4: commitments and deterministic replay.
  const a = await M.audit(proof.N, proof.transcript);

  const ok = okA && okB && a.ok && !!a.final;
  return { ok, digest, sigA: okA, sigB: okB,
    commitments: { valid: a.hashOK, tampered: a.hashBad },
    replay: a.stateOK, rounds: a.rounds, final: a.final,
    idA: await fp(proof.pubA), idB: await fp(proof.pubB),
    claimedWinner: proof.winner };
}

async function fp(jwk) {
  const material = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function line(ok, label, detail) { return `  ${ok ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`; }

(async () => {
  let proof; try { proof = readInput(); } catch (e) { console.error('could not read proof:', e.message); process.exit(2); }
  let r; try { r = await verify(proof); } catch (e) { console.error('verification error:', e.message); process.exit(1); }

  if (r.reason) { console.error('INVALID PROOF —', r.reason); process.exit(1); }
  console.log('MODULUS match verification');
  console.log('  ring N        ', proof.N);
  console.log('  players       ', `${r.idA}${proof.a ? ' ('+proof.a.name+')' : ''}  vs  ${r.idB}${proof.b ? ' ('+proof.b.name+')' : ''}`);
  console.log('  digest        ', r.digest);
  console.log('');
  console.log(line(r.sigA, "player A's signature over the transcript"));
  console.log(line(r.sigB, "player B's signature over the transcript"));
  console.log(line(r.commitments.tampered === 0, 'commitments', `${r.commitments.valid} valid, ${r.commitments.tampered} tampered`));
  console.log(line(r.replay, 'deterministic replay', `${r.rounds} rounds reproduce the recorded state`));
  console.log(line(!!r.final, 'reached a result', r.final ? `winner ${r.final.winner} — ${r.final.reason}` : ''));
  console.log('');
  if (r.ok) {
    const mismatch = r.claimedWinner && r.final && r.claimedWinner !== r.final.winner;
    if (mismatch) { console.log(`✗ VERIFIED MATCH, but the proof's claimed winner (${r.claimedWinner}) disagrees with the replay (${r.final.winner}).`); process.exit(1); }
    console.log('✓ VERIFIED — this match provably happened as recorded; both players signed it. No server was trusted.');
    process.exit(0);
  } else {
    console.log('✗ NOT VERIFIED — the proof failed at least one check above and cannot be trusted.');
    process.exit(1);
  }
})();
