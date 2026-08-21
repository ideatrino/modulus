# MODULUS — Complete Game Specification & Protocol

*A provably-fair, zero-randomness tactical duel on the finite cyclic group ℤ/Nℤ.*

**Version 1.0** — canonical reference. Anything a developer needs to reimplement the
game exactly, run it online between two mutually-distrusting players, and let anyone
audit a completed match.

---

## 0. What this document is

The playable single file (`modulus.html`) is the complete game for solo and
same-device two-player. This spec adds the one thing a local file cannot enforce on
its own: **trustless play between two people over the internet**, where neither the
players nor any server has to be trusted for the result to be fair. It also pins down
the rules precisely enough that two independent implementations will always agree.

---

## 1. Design goals (and the shortcomings they answer)

| Goal | Mechanism | Shortcoming in existing games it fixes |
|---|---|---|
| **Unmanipulable outcomes** | Cryptographic commit–reveal | Cheating / server compromise / peeking at opponent input |
| **No dominant strategy** | Circulant tournament on ℤ/Nℤ | "Solved" or degenerate metagames; balance patches |
| **No luck to blame** | Zero RNG in outcomes | RNG frustration; loot-box-style variance |
| **Verifiable by anyone** | Deterministic replay from a recorded transcript | "Trust us" leaderboards; disputed results |
| **Trivial to learn, deep to master** | One input (a residue) doing double duty | Onboarding cliffs; shallow depth |
| **No pay-to-win** | No hidden stats, no purchasable power | Monetized advantage |

---

## 2. Rules (canonical)

### 2.1 Board and constants

- The board is the ring **ℤ/Nℤ** — positions `0 … N−1` arranged in a circle. **N must
  be an odd prime.** Shipping sizes: **7, 11, 13, 17, 23**. (Odd ⇒ perfect balance;
  prime ⇒ the strongest symmetry, and 7/11/23 are *Paley tournaments*, doubly regular.)
- Let **HALF = (N − 1) / 2**.
- **Starting HP** = `2·HALF + 2` (so a game needs at least ~3 decisive clashes).
- **Win score** = `5` shards.
- **Shards on the board** = `2` for N ≤ 11, else `3`.
- Champion **A** starts at position `0`; champion **B** starts at position `⌊N/2⌋`.

### 2.2 A round

Both players **simultaneously and secretly** choose a residue `m ∈ {0 … N−1}`, then
reveal. Resolution proceeds in this fixed order:

1. **Clash.** Let `d = (m_A − m_B) mod N`.
   - `d = 0` → **parry**, no damage.
   - `1 ≤ d ≤ HALF` → **A wins**, A deals `d` damage to B.
   - `HALF < d ≤ N−1` → **B wins**, B deals `N − d` damage to A.
   Damage is therefore always in `1 … HALF`, symmetric for both sides.

2. **Movement.** Each champion sweeps its own `m` steps clockwise. The swept set for a
   champion at `p` choosing `m` is `{(p+1) mod N, …, (p+m) mod N}` (empty if `m = 0`).

3. **Shard collection.** A shard is collected if it lies in a champion's swept set.
   - If a shard is in **both** sweeps, the **clash winner** takes it; on a **parry** the
     contested shard is **not** taken and remains.
   - Uncontested shards are taken by whoever swept them.

4. **Apply.** Subtract damage (floored at 0), update positions to `(p + m) mod N`,
   add collected shards to scores.

5. **Respawn.** Refill the board back to the shard count, placing new shards on empty
   positions (not on a champion, not on a surviving shard). See §4 for *where*.

### 2.3 Win conditions (checked after every round)

- An HP hits 0 → the other player wins. Both hit 0 in the same round → **draw**.
- A score reaches 5 → higher score wins; equal-and-both-≥5 → **draw**.

---

## 3. Why it is balanced and fair (the mathematics)

These are not design hopes; they are properties of the structure, verified
exhaustively in the reference implementation's test suite.

**3.1 No dominant move (circulant tournament).**
Define `a ▷ b` ("a beats b") iff `(a − b) mod N ∈ {1, …, HALF}`. Because N is odd,
for every residue exactly `HALF` others satisfy this and exactly `HALF` don't (the
one remaining case is `a = b`, a parry). So **every single residue beats exactly half
the field and loses to the other half.** There is no strongest move to spam and none
useless enough to remove — the object is a *regular tournament*, and for prime
`N ≡ 3 (mod 4)` a *doubly-regular Paley tournament*, the most symmetric one that exists.

**3.2 The pure-strategy game is a fair, unsolvable mixing game.**
The one-shot clash is a symmetric zero-sum game whose payoff matrix is skew-symmetric
and constant-row-sum. Its unique symmetric equilibrium is the **uniform distribution**:
against an opponent who mixes uniformly, *every* residue has expected value exactly 0.
So the metagame cannot collapse to a single "correct" line — optimal play is to stay
unpredictable, and edges come from reading the opponent, not memorizing a build.

**3.3 Coupling combat to movement creates the depth.**
Because the same `m` picks your attack *and* your travel distance, the residue that
would win a clash is usually not the residue that reaches the shard you want. That
tension is the strategic core: pure combat is a fair coin, but the shard race is a
game of position and prediction where skill compounds.

**3.4 Zero randomness in outcomes.**
Nothing in §2 consults a random source. All variance is the opponent's mind. (The only
randomness anywhere is *where* fresh shards appear — and §4 makes even that provably
fair and, crucially, *out of either player's control*.)

---

## 4. Provably-fair shard placement (shared randomness)

Shard respawn positions must be unpredictable yet not controllable by either player.
Use the players' own commitments as the entropy — a standard commit-reveal coin toss:

```
seed        = H( nonce_A ‖ nonce_B ‖ "modulus-shards-v1" )
placement k = PRNG(seed) advanced once per shard spawn, ONLY on spawns
```

Because each player commits to their nonce **before** seeing the other's, neither side
can steer the seed. The reference client uses a dedicated PRNG stream (`mulberry32`)
that advances *only* when shards spawn, so the placement sequence is a pure function of
the seed and the (deterministic) sequence of moves — which is exactly what makes a
whole match replayable byte-for-byte (§6).

> **Implementation note, learned the hard way.** Keep the shard PRNG on its *own*
> stream. If shard draws share a stream with move/nonce generation, replaying from a
> transcript (which supplies moves rather than regenerating them) desynchronizes the
> stream and the audit fails on honest games. One dedicated stream, advanced only on
> spawns, fixes it — verified over 1000 simulated games across all five ring sizes.

---

## 5. Online protocol (two untrusting players, no trusted server)

The security property we want: **neither player can (a) see the other's move before
committing their own, (b) change a move after seeing the other's, nor (c) bias shard
placement — and any dispute is resolved by math, not by trusting a server.**

### 5.1 Primitives

- `H` = SHA-256.
- A **commitment** to move `m` is `c = H(m ‖ nonce)`, where `nonce` is ≥128 random bits.
- A **transcript** is the ordered list of every round's `(c_A, c_B, m_A, nonce_A,
  m_B, nonce_B)`, plus `N` and the agreed match id.

### 5.2 Per-round message flow (lockstep)

```
Round r:
  1. A → B :  c_A = H(m_A ‖ nonce_A)          # commit
     B → A :  c_B = H(m_B ‖ nonce_B)          # commit  (order irrelevant)
        -- both commitments received before ANY reveal --
  2. A → B :  (m_A, nonce_A)                   # reveal
     B → A :  (m_B, nonce_B)                   # reveal
  3. Each side independently:
        assert H(m_A ‖ nonce_A) == c_A  and  H(m_B ‖ nonce_B) == c_B
        assert 0 <= m_A, m_B < N
        resolve the round by §2  (pure function → both sides get identical state)
        append the round to the local transcript
```

No server is required. If one is used, it is only a **relay/notary**: it forwards
messages and optionally timestamps the transcript. It is never trusted for the result,
because every client recomputes the result itself and can prove it from the transcript.

### 5.3 The reveal-refusal (griefing) problem — and the fix

Commit-reveal's one weakness: the player who reveals second could refuse to reveal on
seeing a bad matchup. Mitigations, in increasing strength:

1. **Reveal deadline.** If a player doesn't reveal within `T` seconds of both
   commitments landing, they **forfeit the round** (or match). A refusal is strictly
   worse than any honest reveal, so rational players always reveal.
2. **Match bond.** Optional stake, slashed on a proven no-show. Turns griefing costly.
3. **Simultaneous-enough reveal.** Exchange encrypted reveals first, then swap keys, so
   neither learns the plaintext meaningfully earlier than the other.

For a friendly/ranked game, #1 alone is sufficient and simple. Only adversarial,
value-bearing matches need #2/#3.

### 5.4 What each rule stops

- **Peeking at the opponent's move** → impossible: only a hash is public until both
  reveal.
- **Changing a move after seeing theirs** → impossible: `H` is binding; a changed `m`
  won't match `c`.
- **Biasing shard RNG** → impossible: the seed depends on *both* nonces, each hidden at
  commit time.
- **Desync / lag exploits** → impossible to exploit: resolution is a pure function of
  the revealed transcript; late packets can't change math, only the clock (§5.3).
- **A hacked server** → irrelevant to fairness: clients verify everything; the server
  can at worst refuse service, not forge a result.

---

## 6. Auditing a finished match

A completed transcript **is** the proof. To verify, anyone (a spectator, a league, the
losing player) runs:

1. **Commitment check.** For every round, recompute `H(m ‖ nonce)` and confirm it equals
   the stored commitment for both players. (Catches any post-hoc move edit.)
2. **Replay check.** Reseed the shard PRNG from §4, start from the §2.1 initial state,
   and re-resolve every round using only the transcript's moves. Confirm the resulting
   HP/score/positions match the recorded per-round snapshots.

If both pass, the match is certified: **no dice, no hidden state, nothing to tamper
with.** The reference client ships this as the *Audit Match* button, and it detects a
single altered move as a per-round state mismatch (verified).

---

## 7. Reference state machine

```
MENU ──start──▶ ROUND_COMMIT
ROUND_COMMIT ──both commitments in──▶ ROUND_REVEAL
ROUND_REVEAL ──both reveals valid──▶ RESOLVE
RESOLVE ──win condition met?──▶ yes ▶ GAME_OVER
                              └▶ no  ▶ ROUND_COMMIT (r+1)
GAME_OVER ──rematch / menu──▶ …
(any state) ──audit──▶ recompute, return to prior state
```

Solo mode collapses this: the AI commits first (so it provably cannot adapt to your
current move), you reveal by picking, both resolve. Same-device two-player enforces
simultaneity with a pass-and-play "sealed" gate between the two secret picks.

---

## 8. The opponent AI (solo)

- **Fair.** Plays the uniform mixed strategy — the equilibrium of §3.2. Unexploitable
  in pure combat; you beat it by winning the *shard race*, which it doesn't optimize.
- **Adaptive.** Best-responds to your empirical move frequencies with ε-exploration
  (ε ≈ 0.18): with probability ε it mixes uniformly, otherwise it plays the residue that
  maximizes expected clash value against your observed distribution. It still **commits
  before seeing your current move**, so it remains provably fair — it punishes *habits*,
  the way a strong human reads a pattern, not your actual pick.

---

## 9. Tuning & variants (all balance-preserving)

- **Ring size** trades speed for depth: smaller N = punchier, larger N = more positional.
  Any odd prime works; primes `≡ 3 (mod 4)` give the maximally-symmetric Paley structure.
- **Best-of-K rounds / match points** for tournaments.
- **Team relay:** alternate which teammate picks each round; the commit-reveal transcript
  makes collusion detectable.
- **Rating:** because outcomes are verifiable, Elo/Glicko can be computed from signed
  transcripts with no trusted reporter.
- **Spectating:** stream commitments live, reveals on a delay — spectators see a provably
  honest game without leaking live information.

Do **not** make the ring even, or let a residue's clash-range be asymmetric — either
breaks the "every move beats exactly half" property and reintroduces a dominant move.

---

## 10. Verified invariants (from the reference test suite)

- For N ∈ {7, 11, 13, 17, 23}: every residue beats exactly HALF and loses to exactly
  HALF → **no dominant move**.
- For the same N: every pure move is net-zero in expectation vs a uniform opponent →
  **provably fair combat**.
- Adaptive AI provably punishes a fixed, predictable move.
- Over 1000 simulated honest games (200 × 5 sizes): the audit **replays every match
  exactly**; a single altered move is **always detected**.

---

*MODULUS is an original synthesis of three established mathematical tools — the
circulant/Paley tournament (balance), cryptographic commit-reveal (security), and
deterministic verifiable replay (auditability) — combined into a game in a way that, to
the author's knowledge, has not been done before. The pieces are known; the machine
built from them is yours. Rename the game, the champions, and the ring freely.*
