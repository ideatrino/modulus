# MODULUS

[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/ideatrino/modulus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> A provably-fair mathematical duel. Two players pick secret residues on a ring of
> integers; the same number decides both the clash and the movement. No hidden RNG in
> outcomes, no dominant move, and — online — **nothing any player or server can cheat**.

*(Replace `OWNER/REPO` in the badge above with your GitHub path after you push.)*

## Why it's different

MODULUS is built on three ideas working together:

- **Balance from mathematics.** Moves live on `ℤ/Nℤ` for an odd prime `N`. The win/lose
  relation is a *circulant tournament* (a Paley tournament for `N ∈ {7, 11, 23}`): every
  residue beats *exactly half* the others and loses to the other half. There is no
  dominant move and no solved meta — the equilibrium is to mix uniformly, so all the
  variance is opponent psychology, not luck.
- **Fairness from cryptography.** Online, each move is published first as a commitment
  `H(move ‖ nonce)` and only revealed once both are sealed. You cannot see the opponent's
  move before committing yours, cannot change yours after, and neither side can bias where
  shards appear (respawns are seeded by *both* players' blind nonces).
- **Trust from auditability.** Matches are deterministic; the transcript is a proof.
  Anyone can re-hash every commitment and replay the game to verify the result — and
  players co-sign the transcript so a leaderboard trusts the outcome without trusting
  whoever reported it. Every match exports as a self-contained proof you can replay in the
  browser or verify from the command line with `verify.js` — flip one byte and it fails.

## Repository layout

| Path | What it is |
|---|---|
| [`modulus.html`](modulus.html) | The **solo + same-device game** — playable by just opening the file. Fair AI (uniform Nash) or Adaptive AI, plus pass-and-play. Live commitment display and an Audit button. |
| [`online/`](online/) | The **trustless online multiplayer**: shared game core, relay + production server, browser client, and a signature-verified rating system. See [`online/README.md`](online/README.md). |
| [`MODULUS-spec.md`](MODULUS-spec.md) | The full developer **specification**: exact rules, the three math proofs, the protocol, and the verified invariants. |

## Quickstart

**Play solo, right now:** open `modulus.html` in any browser.

**Play online (two people):**

```bash
cd online
docker compose up --build          # serves client + relay on http://<host>:8080
# or:  npm install && npm start
```

Both players open the URL, choose **Online relay**, then **Join** the same room code or
hit **Quick match**. Spectating and mid-match reconnect are built in. For public HTTPS/
`wss://`, point a domain at the host and run
`MODULUS_DOMAIN=play.example.com docker compose --profile tls up -d --build` — Caddy
provisions a real certificate automatically.

**Run the tests:**

```bash
cd online
npm install
npm test              # 61 checks across 7 suites, over real sockets and real crypto
```

The suites verify, end to end: byte-identical transcripts and independent audits, a single
altered move detected, reveal-timeout forfeits, quick-match pairing, mid-match reconnect/
resume, a spectator auditing a live match, the persistent trustless ladder (Elo, replay-
proof, forgery-proof, survives restart), the co-signature flow between two real clients,
and the match archive plus the standalone `verify.js` accepting genuine proofs while
rejecting tampered ones.

**Verify a match yourself, offline** — no server, no dependencies:

```bash
node online/verify.js proof.json   # exit 0 = verified, 1 = failed
```

## Security model

No trusted server. The relay only sequences messages, enforces a reveal deadline, and
allows reconnection — it never computes a result and cannot forge one, because every
client verifies each commitment and resolves the game itself. A compromised relay can
refuse service but cannot change an outcome. Full details in [`online/README.md`](online/README.md)
and [`MODULUS-spec.md`](MODULUS-spec.md).

## "Original"?

MODULUS is a novel *synthesis* — a circulant/Paley tournament for balance, cryptographic
commit-reveal for fairness, and deterministic verifiable replay for auditability, combined
into one game. The individual primitives are well known; putting them together this way
is the new part, and it's disclosed honestly here rather than overclaimed.

## License

MIT — see [LICENSE](LICENSE).
