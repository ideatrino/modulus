# MODULUS — Online

Trustless two-player MODULUS. Every move is sealed with a commitment before either is
revealed, so no player — and no server — can peek at or change a move, or bias where
shards appear. Matches are deterministic and **independently auditable**, and results are
**cryptographically co-signed** by both players so a leaderboard can trust them without
trusting anyone who reports them.

There is **no trusted server**: the relay only sequences messages, enforces a reveal
deadline, lets a dropped player reconnect, and forwards the two end-of-match signatures.
Both clients verify every commitment and compute the result themselves — a compromised
relay can refuse service but cannot forge an outcome or a rating.

## What's here

| File | Role |
|---|---|
| `core.js` | Shared pure game logic, the commit-reveal `ProtocolClient`, and signature/audit helpers. Runs in Node and the browser. Single source of truth. |
| `prod-server.js` | **Production server.** Serves the client, the relay, and the ladder API on one port. Reconnect grace, quick-match, room list, spectators. |
| `server.js` | Minimal relay (WebSocket only), if you'd rather host the client separately. |
| `rating.js` | Trustless Elo: rate a match only if both players signed it **and** it passes an audit. |
| `store.js` | **Persistent ladder + match archive.** Durable, replay-proof storage keyed on player public keys; keeps recent matches as full replayable proofs. |
| `verify.js` | **Standalone verifier.** `node verify.js proof.json` re-audits a match and checks both signatures with no server and no dependencies. |
| `modulus-online.html` | The browser client: identity, join/quick-match/spectate, room browser, live ladder, **proof export**, and a **replay-and-verify** viewer. Over the internet or across two tabs with no server. |
| `test-*.js` | End-to-end tests over real sockets (see below). |
| `Dockerfile`, `docker-compose.yml` | One-command deploy, with a volume for the ladder and an opt-in HTTPS profile. |

## Fastest way to play

**Over the internet (recommended):** one person runs the server, everyone opens the URL.

```bash
docker compose up --build          # serves on http://<host>:8080, ladder persisted in a volume
# or without Docker:
npm install && npm start
```

Then both players open `http://<host>:8080`, choose **Online relay** (the relay address
is pre-filled to that server), and either **Join** the same room code, **Browse** open
rooms, or hit **Quick match** to be auto-paired.

**HTTPS / WSS in one command.** Point a domain at the host, then:

```bash
MODULUS_DOMAIN=play.example.com docker compose --profile tls up -d --build
```

Caddy provisions and renews a real certificate automatically and proxies both `https://`
and `wss://` to the app. The client auto-selects `wss` when loaded over `https`, so there's
nothing else to configure.

**On one machine, no server:** serve the folder and open two tabs.

```bash
npx serve .          # or: python3 -m http.server 8000
```

Open `modulus-online.html` in two tabs, choose **Same machine**, same room code. (Needs a
real http origin — `BroadcastChannel` doesn't bridge `file://` tabs. The ladder needs the
relay, so same-machine mode is unrated.)

## Features

- **Identity.** You are a keypair generated in your browser and kept in local storage; the
  private key never leaves the device. Only your public key and a per-match signature are
  ever shared. Your rating follows the key, not a name.
- **Join / Quick-match / Spectate / Browse.** Quick-match auto-pairs two strangers; the room
  browser lists open rooms to tap into; spectators get the live commit->reveal feed read-only
  and can audit what they watched.
- **Reconnect & resume.** Drop between rounds and rejoin within the grace window to pick up
  exactly where you left off. Drop *after* seeing both commitments and you forfeit — no
  peek-and-run.
- **Audit button.** Re-hashes every commitment and replays the match from the revealed moves.
- **Trustless, persistent ladder.** When a match ends, both clients co-sign the exact
  transcript (signatures exchanged through the relay) and submit it. The server verifies both
  ECDSA signatures, re-audits the match, updates Elo, and persists it. A forged signature, a
  single altered move, a self-played match, or a resubmitted match is rejected — ratings can't
  be gamed by lying about results or replaying wins.
- **Verifiable, replayable proofs.** Export any finished match as a small self-contained proof
  file, or fetch one from the archive. Replay it move-by-move in the browser, or verify it from
  the command line with `node verify.js proof.json` — no server, no network, no trust. Flip a
  single byte and every cryptographic check fails.

## Verify a match yourself, offline

Every rated match is archived as a self-contained proof (`GET /api/match/:digest`, or the
client's **Export** button). Check one with zero trust and zero dependencies:

```bash
node verify.js proof.json
```

It recomputes the transcript digest, checks **both** players' ECDSA signatures over it,
re-hashes every commitment, and replays the whole match to confirm the recorded final state
reproduces exactly. Exit code 0 = verified, 1 = failed. A single altered move, nonce, score,
or signature fails verification.

## HTTP API (the ladder)

| Method & path | Purpose |
|---|---|
| `GET /api/leaderboard` | Current standings (rank, name, rating, W–L–D). |
| `GET /api/stats` | Player count, matches recorded, archived proofs, open rooms. |
| `GET /api/matches` | Index of recent archived matches (players, ring, winner, rounds). |
| `GET /api/match/:digest` | The full self-verifying proof for one match. |
| `POST /api/submit` | Submit `{ N, transcript, pubA, pubB, sigA, sigB, nameA?, nameB? }`. Returns the rated result, `409` on replay/rejection, `400` if malformed, `429` if rate-limited. |

The ladder file is `LADDER_FILE` (default `./leaderboard.json`; `/data/leaderboard.json` in
Docker). Delete it to reset the ladder.

## Verify it actually works

```bash
npm install
npm test
```

61 checks across seven suites, all over real sockets / real crypto:

- `test-online` — full relay match: byte-identical transcripts, independent audits, altered-move detection, reveal-timeout forfeit.
- `test-local` — same-machine BroadcastChannel path.
- `test-full` — static hosting, quick-match pairing, mid-match reconnect/resume, spectator auditing, signed-rating accept/reject.
- `test-leaderboard` — persistent store: Elo moves, zero-sum, replay rejected, self-play rejected, forgery rejected, survives reload.
- `test-ladder-api` — the live `/api/*` endpoints over HTTP.
- `test-cosign` — the end-to-end co-signature flow: two clients play, exchange signatures through the relay, and submit to the ladder (counted exactly once).
- `test-archive` — match archive endpoints, and the standalone `verify.js` accepting a real proof while rejecting a tampered move, a tampered signature, and a lied-about winner (run as a separate process).

Run a subset with `npm run test:full`, `npm run test:ladder`, etc.

## Security model (short version)

- **Commit-reveal.** A move is published first as `H(move + nonce)`; you can't see the
  opponent's move before committing yours, and can't change yours after — the hash binds it.
- **Fair shared randomness.** Shard respawns are seeded by *both* players' per-round nonces,
  each committed blind, so neither side can steer them.
- **Anti-griefing.** Miss the reveal deadline and you forfeit; refusing is strictly worse
  than any honest reveal.
- **Trustless rating.** A match counts only if it carries both players' signatures over the
  exact transcript *and* re-audits cleanly. The relay forwards signatures but holds no keys,
  so it can't forge one; the digest binds the whole match, so it can't alter one; and each
  transcript is recorded once, so a win can't be replayed.

See `../MODULUS-spec.md` for the full protocol and the mathematics of why the game is
balanced (a circulant/Paley tournament: every move beats exactly half the field). The
solo and same-device game is `../modulus.html`.

## Requirements

Node.js 18+ (uses built-in Web Crypto — SHA-256 and ECDSA P-256). Only dependency: `ws`.
