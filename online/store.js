/* ============================================================
   MODULUS leaderboard store — persistent, trustless, replay-proof.

   Wraps rating.js with durable storage and the two guarantees a
   real ladder needs beyond "the math checks out":

     1. IDENTITY is the public key, not a name. A player is the hash
        of their exported JWK. Names are cosmetic and can collide;
        the key is what earns rating. You cannot rate under someone
        else's identity without their private key.

     2. NO REPLAY. Every accepted match is recorded by its transcript
        digest. Re-submitting the same signed match (or either player
        re-sending it to farm Elo) is rejected as a duplicate. A match
        also only counts once for the exact pair+result it encodes.

   Persistence is a plain JSON file written atomically (tmp + rename)
   so a crash mid-write can't corrupt the ladder. Everything is
   synchronous and dependency-free on purpose: the ladder is small,
   and a single file is trivial to back up, inspect, or reset.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('./core.js');
const { rateMatch } = require('./rating.js');

const BASE_RATING = 1200;
const ARCHIVE_MAX = 300; // keep the most recent N rated matches as full replayable proofs

function idOf(jwk) {
  // Stable identity from the public key material only (x/y for P-256).
  const material = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

class Leaderboard {
  constructor(file) {
    this.file = file || path.join(__dirname, 'leaderboard.json');
    this.data = { players: {}, seen: {}, archive: [], version: 2 };
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.players && parsed.seen) { this.data = parsed; if (!Array.isArray(this.data.archive)) this.data.archive = []; }
    } catch { /* fresh ladder */ }
  }

  _save() {
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file); // atomic on POSIX
  }

  _player(id, name) {
    if (!this.data.players[id]) {
      this.data.players[id] = { id, name: name || id.slice(0, 6), rating: BASE_RATING, wins: 0, losses: 0, draws: 0, games: 0 };
    } else if (name) {
      this.data.players[id].name = name; // latest self-reported name wins (cosmetic only)
    }
    return this.data.players[id];
  }

  /* Submit a signed, completed match. Returns a result object; only
     ok:true mutates and persists the ladder. Rejections never write. */
  async submit(m) {
    const idA = idOf(m.pubA), idB = idOf(m.pubB);
    if (idA === idB) return { ok: false, reason: 'a player cannot rate a match against themselves' };

    const pA = this._player(idA, m.nameA);
    const pB = this._player(idB, m.nameB);

    // Verify signatures + audit + compute Elo against CURRENT ratings.
    const r = await rateMatch({ N: m.N, transcript: m.transcript, pubA: m.pubA, pubB: m.pubB,
      sigA: m.sigA, sigB: m.sigB, ratingA: pA.rating, ratingB: pB.rating, K: m.K });
    if (!r.ok) return { ok: false, reason: r.reason, digest: r.digest };

    // Replay guard: this exact signed transcript may count at most once.
    if (this.data.seen[r.digest]) return { ok: false, reason: 'match already recorded (replay rejected)', digest: r.digest };

    // Commit.
    pA.rating = r.ratingA; pB.rating = r.ratingB;
    if (r.winner === 'A') { pA.wins++; pB.losses++; }
    else if (r.winner === 'B') { pB.wins++; pA.losses++; }
    else { pA.draws++; pB.draws++; }
    pA.games++; pB.games++;
    this.data.seen[r.digest] = { at: Date.now(), a: idA, b: idB, winner: r.winner };
    // Archive the full, self-verifying proof so the match can be re-checked and
    // replayed later by anyone — no trust in this server required.
    this.data.archive.push({ digest: r.digest, at: Date.now(), N: m.N, transcript: m.transcript,
      pubA: m.pubA, pubB: m.pubB, sigA: m.sigA, sigB: m.sigB, winner: r.winner, reason: r.reason,
      a: { id: idA, name: pA.name }, b: { id: idB, name: pB.name } });
    if (this.data.archive.length > ARCHIVE_MAX) this.data.archive = this.data.archive.slice(-ARCHIVE_MAX);
    this._save();

    return { ok: true, digest: r.digest, winner: r.winner, reason: r.reason, rounds: r.rounds,
      a: { id: idA, name: pA.name, rating: pA.rating, delta: r.deltaA },
      b: { id: idB, name: pB.name, rating: pB.rating, delta: r.deltaB } };
  }

  standings(limit = 100) {
    return Object.values(this.data.players)
      .sort((x, y) => y.rating - x.rating || y.wins - x.wins)
      .slice(0, limit)
      .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, rating: p.rating,
        wins: p.wins, losses: p.losses, draws: p.draws, games: p.games }));
  }

  stats() { return { players: Object.keys(this.data.players).length, matches: Object.keys(this.data.seen).length, archived: this.data.archive.length }; }

  // Full self-verifying proof for one match (everything a verifier needs).
  getMatch(digest) { return this.data.archive.find(m => m.digest === digest) || null; }

  // Recent matches, newest first — lightweight index (no transcripts).
  recentMatches(limit = 30) {
    return this.data.archive.slice(-limit).reverse().map(m => ({
      digest: m.digest, at: m.at, N: m.N, winner: m.winner, rounds: m.transcript.length,
      a: m.a, b: m.b }));
  }
}

module.exports = { Leaderboard, idOf, BASE_RATING };
