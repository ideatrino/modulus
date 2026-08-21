/* ============================================================
   MODULUS core — shared by the relay server, the browser client,
   and the integration test. Pure, deterministic, transport-agnostic.
   Runs in Node (module.exports) and the browser (window.MODULUS).
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MODULUS = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- config ---------- */
  const SHIP_SIZES = [7, 11, 13, 17, 23]; // odd primes
  function deriveConfig(N) {
    const HALF = (N - 1) / 2;
    return { N, HALF, START_HP: 2 * HALF + 2, WIN_SCORE: 5, NS: N <= 11 ? 2 : 3 };
  }

  /* ---------- pure combat / movement ---------- */
  function combat(mA, mB, N, HALF) {
    const d = ((mA - mB) % N + N) % N;
    if (d === 0) return { d, winner: 'none', dmg: 0 };
    if (d <= HALF) return { d, winner: 'A', dmg: d };
    return { d, winner: 'B', dmg: N - d };
  }
  function arc(from, steps, N) {
    const o = [];
    for (let k = 1; k <= steps; k++) o.push((from + k) % N);
    return o;
  }

  /* ---------- deterministic, provably-fair shard placement ----------
     Fairness comes from commit-reveal: respawn positions are a pure function
     of BOTH players' nonces for that round, each committed blind, so neither
     side can steer them. Fully replayable from the transcript. */
  function fnv1a(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function freeCells(occ, N) { const f = []; for (let i = 0; i < N; i++) if (occ.indexOf(i) < 0) f.push(i); return f; }

  // Opening layout: deterministic, symmetric, no randomness needed (same for everyone).
  function initialShards(N, NS, occupied) {
    const out = []; const occ = occupied.slice();
    for (let k = 1; k <= NS; k++) {
      let target = Math.round((k * N) / (NS + 1)) % N;
      // walk to nearest free cell
      for (let step = 0; step < N; step++) {
        const c = (target + step) % N;
        if (occ.indexOf(c) < 0) { out.push(c); occ.push(c); break; }
      }
    }
    return out;
  }
  // Respawns: seeded by the round's two nonces.
  function respawnShards(count, occupied, N, nonceA, nonceB, round) {
    const out = []; const occ = occupied.slice();
    for (let i = 0; i < count; i++) {
      const free = freeCells(occ, N);
      if (!free.length) break;
      const h = fnv1a(nonceA + '|' + nonceB + '|' + round + '|' + i);
      const cell = free[h % free.length];
      out.push(cell); occ.push(cell);
    }
    return out;
  }

  /* ---------- match state ---------- */
  function newMatch(N) {
    const cfg = deriveConfig(N);
    const A = { pos: 0, hp: cfg.START_HP, score: 0 };
    const B = { pos: N >> 1, hp: cfg.START_HP, score: 0 };
    const shards = initialShards(N, cfg.NS, [A.pos, B.pos]);
    return { cfg, A, B, shards, round: 0, over: null };
  }

  // Resolve one round. A's move is always the first argument by convention,
  // so both peers compute the identical result regardless of their own role.
  function resolveRound(st, mA, mB, nonceA, nonceB, round) {
    const { N, HALF, NS } = st.cfg;
    const res = combat(mA, mB, N, HALF);
    const aArc = arc(st.A.pos, mA, N), bArc = arc(st.B.pos, mB, N);
    let ag = 0, bg = 0; const rem = [];
    for (const s of st.shards) {
      const iA = aArc.indexOf(s) >= 0, iB = bArc.indexOf(s) >= 0;
      if (iA && iB) { if (res.winner === 'A') ag++; else if (res.winner === 'B') bg++; else rem.push(s); }
      else if (iA) ag++; else if (iB) bg++; else rem.push(s);
    }
    if (res.winner === 'A') st.B.hp = Math.max(0, st.B.hp - res.dmg);
    if (res.winner === 'B') st.A.hp = Math.max(0, st.A.hp - res.dmg);
    st.A.pos = (st.A.pos + mA) % N; st.B.pos = (st.B.pos + mB) % N;
    st.A.score += ag; st.B.score += bg;
    const refill = respawnShards(NS - rem.length, [st.A.pos, st.B.pos].concat(rem), N, nonceA, nonceB, round);
    st.shards = rem.concat(refill);
    st.round = round;
    st.over = checkWin(st);
    return {
      round, mA, mB, nonceA, nonceB, d: res.d, winner: res.winner, dmg: res.dmg, ag, bg,
      Ahp: st.A.hp, Bhp: st.B.hp, Ascore: st.A.score, Bscore: st.B.score,
      Apos: st.A.pos, Bpos: st.B.pos, shards: st.shards.slice()
    };
  }

  function checkWin(st) {
    const { WIN_SCORE } = st.cfg;
    const aDead = st.A.hp <= 0, bDead = st.B.hp <= 0;
    if (aDead || bDead) {
      if (aDead && bDead) return { winner: 'draw', reason: 'both HP reached zero' };
      return bDead ? { winner: 'A', reason: 'opponent HP reached zero' }
                   : { winner: 'B', reason: 'opponent HP reached zero' };
    }
    if (st.A.score >= WIN_SCORE || st.B.score >= WIN_SCORE) {
      if (st.A.score > st.B.score) return { winner: 'A', reason: 'reached 5 shards first' };
      if (st.B.score > st.A.score) return { winner: 'B', reason: 'reached 5 shards first' };
      return { winner: 'draw', reason: 'both reached 5 shards' };
    }
    return null;
  }

  /* ---------- crypto helpers (Web Crypto: Node 18+ and browsers) ---------- */
  async function sha256hex(str) {
    const data = new TextEncoder().encode(str);
    const buf = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function randNonce() {
    const a = new Uint32Array(4); globalThis.crypto.getRandomValues(a);
    return Array.from(a).map(x => x.toString(16).padStart(8, '0')).join('');
  }

  /* ---------- audit: independent verification of a finished transcript ---------- */
  async function audit(N, transcript) {
    let hashOK = 0, hashBad = 0;
    for (const r of transcript) {
      if ((await sha256hex(r.mA + ':' + r.nonceA)) === r.cA) hashOK++; else hashBad++;
      if ((await sha256hex(r.mB + ':' + r.nonceB)) === r.cB) hashOK++; else hashBad++;
    }
    const st = newMatch(N);
    let stateOK = true, mism = 0;
    for (const r of transcript) {
      const rec = resolveRound(st, r.mA, r.mB, r.nonceA, r.nonceB, r.round);
      if (rec.Ahp !== r.Ahp || rec.Bhp !== r.Bhp || rec.Ascore !== r.Ascore || rec.Bscore !== r.Bscore) { stateOK = false; mism++; }
    }
    return { rounds: transcript.length, hashOK, hashBad, stateOK, mism, ok: hashBad === 0 && stateOK, final: st.over };
  }

  /* ---------- canonical transcript + signatures (trustless ranking) ----------
     The canonical form contains exactly the data that determines the whole match
     (both players' moves and nonces per round). Two honest clients produce the
     same string; signing its digest makes the result non-repudiable, and a rating
     service can verify + audit it without trusting either player or any server. */
  function canonical(N, transcript) {
    return 'MODULUS/1|N=' + N + '|' + transcript.map(function (r) {
      return r.round + ',' + r.mA + ',' + r.nonceA + ',' + r.mB + ',' + r.nonceB;
    }).join(';');
  }
  function hashTranscript(N, transcript) { return sha256hex(canonical(N, transcript)); }

  function _b64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s);
  }
  function _unb64(str) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
    var bin = atob(str), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u;
  }
  var ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
  async function genKeyPair() { return globalThis.crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']); }
  async function exportPub(pub) { return globalThis.crypto.subtle.exportKey('jwk', pub); }
  async function importPub(jwk) { return globalThis.crypto.subtle.importKey('jwk', jwk, ECDSA, true, ['verify']); }
  async function signStr(priv, str) {
    const sig = await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, new TextEncoder().encode(str));
    return _b64(new Uint8Array(sig));
  }
  async function verifyStr(pubJwk, str, sigB64) {
    const pub = await importPub(pubJwk);
    return globalThis.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, _unb64(sigB64), new TextEncoder().encode(str));
  }
  // A player signs the digest of the agreed transcript.
  async function signMatch(priv, N, transcript) {
    const digest = await hashTranscript(N, transcript);
    return { digest: digest, sig: await signStr(priv, digest) };
  }

  /* ============================================================
     ProtocolClient — the two-party commit-reveal loop.
     Transport-agnostic: you pass an object exposing
       transport.sendCommit(round, c)
       transport.sendReveal(round, m, nonce)
       transport.onEvent = (ev) => {...}   // driven by relay/peer
     Events consumed: {t:'role',role,N} | {t:'commits',round,cA,cB}
                      {t:'reveals',round,mA,nonceA,mB,nonceB}
                      {t:'forfeit',loser} | {t:'peerLeft'}
     ============================================================ */
  class ProtocolClient {
    constructor(transport, opts) {
      this.tp = transport;
      this.opts = opts || {};
      this.role = null; this.N = null;
      this.state = null;
      this.transcript = [];
      this.pending = null;      // {m, nonce, c}
      this.commits = null;      // {cA, cB} for current round
      this.round = 0;
      this.done = false;
      this.spectator = !!(opts && opts.spectator);
      transport.onEvent = (ev) => this._onEvent(ev).catch(e => this.opts.onError && this.opts.onError(e));
    }

    async _onEvent(ev) {
      if (this.done) return;
      if (ev.t === 'role') {
        this.role = ev.role; this.N = ev.N; this.state = newMatch(ev.N);
        this.opts.onRole && this.opts.onRole(this.role, this.state);
        await this._commitNextRound(1);
      } else if (ev.t === 'commits') {
        this.commits = { cA: ev.cA, cB: ev.cB };
        this.opts.onCommits && this.opts.onCommits(ev.round, this.commits);
        // reveal my move now that both are sealed (spectators have nothing to reveal)
        if (!this.spectator && this.pending) this.tp.sendReveal(ev.round, this.pending.m, this.pending.nonce);
      } else if (ev.t === 'reveals') {
        await this._resolve(ev);
      } else if (ev.t === 'forfeit') {
        this._end({ winner: ev.loser === 'A' ? 'B' : 'A', reason: 'opponent forfeited (no reveal in time)', forfeit: true });
      } else if (ev.t === 'peerLeft') {
        this._end({ winner: this.role, reason: 'opponent disconnected', disconnect: true });
      } else if (ev.t === 'resume' || ev.t === 'spectate') {
        // rebuild state from completed rounds, then continue (player) or watch (spectator)
        this.spectator = (ev.t === 'spectate');
        this.role = ev.role || 'S'; this.N = ev.N; this.state = newMatch(ev.N); this.transcript = [];
        for (const r of (ev.rounds || [])) {
          const rec = resolveRound(this.state, r.mA, r.mB, r.nonceA, r.nonceB, r.round);
          rec.cA = r.cA; rec.cB = r.cB; this.transcript.push(rec);
        }
        const lastRound = (ev.rounds && ev.rounds.length) ? ev.rounds[ev.rounds.length - 1].round : 0;
        this.opts.onRole && this.opts.onRole(this.role, this.state, true);
        if (this.state.over) this._end(this.state.over);
        else if (!this.spectator) await this._commitNextRound(lastRound + 1);
        else this.round = lastRound + 1; // spectator waits for live events
      }
    }

    async _commitNextRound(round) {
      if (this.spectator) { this.round = round; return; }
      this.round = round;
      const m = await this.opts.getMove(round, this.state, this.role);
      const nonce = randNonce();
      const c = await sha256hex(m + ':' + nonce);
      this.pending = { m, nonce, c };
      this.tp.sendCommit(round, c);
      this.opts.onCommitted && this.opts.onCommitted(round, c);
    }

    async _resolve(ev) {
      // verify BOTH commitments bind to the revealed moves (this is the security check)
      const okA = (await sha256hex(ev.mA + ':' + ev.nonceA)) === this.commits.cA;
      const okB = (await sha256hex(ev.mB + ':' + ev.nonceB)) === this.commits.cB;
      if (!okA || !okB) { this.opts.onError && this.opts.onError(new Error('commitment mismatch — cheating detected')); return; }
      const rec = resolveRound(this.state, ev.mA, ev.mB, ev.nonceA, ev.nonceB, ev.round);
      rec.cA = this.commits.cA; rec.cB = this.commits.cB;
      this.transcript.push(rec);
      this.opts.onResolve && this.opts.onResolve(this.state, rec, this.role);
      if (this.state.over) this._end(this.state.over);
      else await this._commitNextRound(ev.round + 1);
    }

    _end(result) {
      if (this.done) return;
      this.done = true;
      this.opts.onEnd && this.opts.onEnd(result, this.transcript, this.role);
    }
  }

  return {
    SHIP_SIZES, deriveConfig, combat, arc, fnv1a, freeCells,
    initialShards, respawnShards, newMatch, resolveRound, checkWin,
    sha256hex, randNonce, audit, ProtocolClient,
    canonical, hashTranscript, genKeyPair, exportPub, importPub,
    signStr, verifyStr, signMatch
  };
});
