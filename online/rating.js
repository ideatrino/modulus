/* ============================================================
   MODULUS rating — a trustless leaderboard.
   A match counts only if BOTH players signed the exact transcript
   AND the transcript passes an independent audit. No reporter is
   trusted: a forged signature or a single altered move is rejected,
   so ratings cannot be gamed by lying about results.
   ============================================================ */
const M = require('./core.js');

// Standard Elo.
function expected(ra, rb) { return 1 / (1 + Math.pow(10, (rb - ra) / 400)); }
function updateElo(ra, rb, scoreA, K = 32) {
  const ea = expected(ra, rb);
  return [Math.round(ra + K * (scoreA - ea)), Math.round(rb + K * ((1 - scoreA) - (1 - ea)))];
}

/* m = { N, transcript, ratingA, ratingB, pubA, pubB, sigA, sigB, K? }
   pubA/pubB are exported JWK public keys; sigA/sigB are base64 signatures
   over the transcript digest produced by core.signMatch. */
async function rateMatch(m) {
  const digest = await M.hashTranscript(m.N, m.transcript);
  const okA = await M.verifyStr(m.pubA, digest, m.sigA).catch(() => false);
  const okB = await M.verifyStr(m.pubB, digest, m.sigB).catch(() => false);
  if (!okA || !okB) return { ok: false, reason: 'signature verification failed', digest };

  const a = await M.audit(m.N, m.transcript);
  if (!a.ok) return { ok: false, reason: 'match failed audit (' + (a.hashBad ? 'bad commitments' : 'state mismatch') + ')', digest };
  if (!a.final) return { ok: false, reason: 'match did not reach a result', digest };

  const scoreA = a.final.winner === 'A' ? 1 : a.final.winner === 'B' ? 0 : 0.5;
  const [na, nb] = updateElo(m.ratingA, m.ratingB, scoreA, m.K || 32);
  return {
    ok: true, winner: a.final.winner, reason: a.final.reason, digest,
    ratingA: na, ratingB: nb, deltaA: na - m.ratingA, deltaB: nb - m.ratingB, rounds: a.rounds
  };
}

module.exports = { expected, updateElo, rateMatch };
