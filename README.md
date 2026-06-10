# CIDADE.io — MVP multiplayer

A minimal, **real-multiplayer** top-down `.io`-style browser game. It exists to
test ONE hypothesis cheaply:

> "Do real strangers, in the same room, generate a shareable story together?"

The dramatic engine is a **recurring ELECTION**: every cycle players vote, the
winner becomes **Prefeito (Mayor)** and issues a **decree** that affects everyone
— creating betrayal and drama. At the end of a ~6 minute match, the server
generates a text **story** of what happened, and a **Compartilhar** button copies
it to the clipboard (the instrument for the "você contou pra alguém?" metric).

> This is the new MVP. The old single-player demo lives at `../cidade.html` and is
> left untouched.

## Stack

- **Node.js** (18+)
- **express** — serves the static client
- **socket.io** — realtime WebSocket transport
- **Client** — plain HTML5 + Canvas 2D + vanilla JS (no framework, no build step)

The server is **authoritative**: it owns all game state (positions, scores, XP,
levels, upgrades, ownership, votes, cooldowns), runs a fixed **20 Hz** tick,
validates every input, and broadcasts state snapshots. Clients send only intent
(lobby actions, movement direction, action press, vote, decree choice, upgrade
pick). Client-sent positions/scores/XP are never trusted. The server supports
**multiple rooms** (lobby + match lifecycle each), advanced by one tick loop.

## How to run

```bash
cd cidade-mvp
npm install
npm start
# open http://localhost:3000
```

### Start-screen options

Type a name, then choose:

- **Partida rápida** — joins any open public room (or creates one) and drops you
  into its waiting room.
- **Criar sala** — creates a room with a short shareable **code** (5 uppercase
  chars) and makes you the **host** in a **waiting room**.
- **Entrar em sala** — type a room **code** to join that room's waiting room.
- **Jogar com bots (solo)** — creates a private room, fills it with bots and
  **starts immediately** (practice mode — always a lively, full match).

### Test multiplayer with codes (across tabs)

1. Open `http://localhost:3000`, type a name, click **Criar sala** → note the
   **code** shown in the waiting room (use **Copiar**).
2. Open a second tab/window, type a name, click **Entrar em sala**, paste the
   **code**, click **Entrar**. Both players now appear in the waiting room list,
   live-updating.
3. In the host tab, click **Começar**. Both tabs transition into the same match.
   Empty slots are filled with server-side **bots** (topped up to ~8 entities,
   bots removed as humans join, hard cap 12).

To test from other devices on your LAN, browse to `http://<your-ip>:3000`.

## Environment variables

| Var             | Default  | Description                                      |
| --------------- | -------- | ------------------------------------------------ |
| `PORT`          | `3000`   | HTTP/WebSocket port                              |
| `ROUND_PLAY_MS` | `70000`  | Play time between elections (lower = test fast)  |
| `MATCH_MS`      | `360000` | Total match length (~6 min; lower = test fast)   |

No secrets or credentials are required or stored.

## Gameplay

- **Move**: `WASD` / arrow keys (desktop) or the virtual joystick (bottom-left on
  touch devices).
- **Resources**: walk over the yellow dots for points (server-authoritative;
  they respawn after a delay).
- **One contextual action** (`E` / click / mobile button) — the server decides
  what happens based on the **nearest quarteirão (tile)**:
  - near an **unowned** tile → **DOMINAR** (claim it, `built++`)
  - near a tile owned by **another** player → **SABOTAR** (`hacked++`) — the
    conflict driver
  - near a **disabled tile / crisis** → **REPARAR** (`repaired++`)
  - ~4s server-enforced cooldown.
- Owned tiles give the owner **passive trickle points** over time.
- **Crisis (one type)** — `APAGÃO`: occasionally disables unowned tiles, giving
  REPARAR meaning.
- **Election every ~70s of play**:
  - Top candidates (by score) are shown; **every** player and bot casts a **real
    vote**; the server **tallies** all votes (real apuração — not first-click).
    Ties broken deterministically (higher score, then lower id).
  - The elected Mayor picks **one decree** (human gets a timed UI + default; bots
    pick randomly). Decrees last ~70s and affect others:
    - **Distribuição de Renda** — all resources worth 2x for everyone.
    - **Apagão Estratégico** — disables the current 2nd-place player's tiles.
    - **Imunidade Municipal** — Mayor's tiles can't be sabotaged.
    - **Mutirão de Reparo** — clears the active crisis and re-enables everything.
- **Match ~6 minutes** (~4 election cycles), then an **END screen**: final
  ranking, each player's emergent **reputation** (most built = *Construtor*, most
  hacked = *Sabotador*, most repaired = *Técnico*), and a generated **story**.
  The server also logs `[match-end] ...` to stdout so the founder can instrument
  the "match ended" metric.

Reputation phrases float above each player and appear in the leaderboard and the
election candidate cards.

> **Design note**: the old `cidade.html` had an "emergent identity" deadlock
> because the only starting action was *build*. Here the action is **contextual**
> (decided by proximity), so anyone can naturally build / sabotage / repair from
> the start, and identity emerges from what they actually did.

## Interface & feel (neon-noir UI)

The client wears a **neon-noir** skin: dark-asphalt background, neon
yellow/cyan/pink accents, Space Grotesk + Space Mono type, glow, vignette and
motion. It is purely a client-side facelift — **the server protocol is
unchanged**; everything below is derived from the existing state snapshot.

### Contextual action display (know before you press)

The single action key resolves to **dominar / sabotar / reparar** depending on
the nearest tile. The client **replicates the server's "nearest target" logic
from the snapshot for DISPLAY ONLY** (the server stays authoritative on resolve):
it scans tiles within the player's `range`, applies the same priority
(disabled → REPARAR, unowned → DOMINAR, other's → SABOTAR, with immunity/shield
checks), and surfaces it three ways, color-coded (dominar = **yellow**, sabotar =
**pink**, reparar = **green**):

- a **contextual pill** near the controls, e.g. `🔴 SABOTAR quarteirão de Fá`;
- the **action affordance** (desktop slot / mobile button) recolors + relabels
  with the verb;
- on the canvas, the **action-range ring** is tinted by the action and the
  **target tile** (and the targeted player, for sabotage) pulses in that color.

### Cooldown feedback

The action affordance shows the remaining cooldown both as **numeric seconds**
and a **radial fill** — on the desktop action slot and the mobile action button.
The server stays authoritative: it sends each player's remaining `cooldown` and
`cooldownTotal` in the snapshot; the client only displays it.

### Election as an event

Voting darkens the scene with a vignette, gives the title a dramatic entrance,
and shows a **big countdown** that pulses and turns red in the last 5 seconds.
Candidate cards lead with reputation/level, and the overlay lists the **decree
powers in play**. When a decree is applied, a **full-screen announcement**
(`⚡ Fá decretou Apagão Estratégico`) takes over briefly.

### Juice & sound

Floating score numbers, action particles, a tile-claim flash, and a short
**screen shake** when you sabotage or get sabotaged. A tiny **WebAudio** synth
(no audio files shipped) plays collect / dominar / sabotar / reparar / election /
decree / victory cues, with a **mute toggle** (top-left, persisted in
`localStorage`). All event detection is computed client-side from snapshot deltas.

### Mobile

Large joystick + action button placed clear of the HUD, compact leaderboard,
readable contextual pill and cooldown, safe-area insets, and a hidden minimap to
keep small screens uncluttered.

### Shareable end screen

The end-of-match story is a screenshot-worthy card: `CIDADE.io` wordmark +
watermark, gold-highlighted champion, clean typography, and a prominent
**Compartilhar** button that copies the story (plus a `— jogue CIDADE.io` tag).

### Progression (Diep.io-style levels — NOT casting time)

Players earn **XP** from their actions (collect / dominar / sabotar / reparar)
and **level up** server-side. On level-up the client shows a brief, non-blocking
**choice of 1 of 3** upgrades (a random subset from the pool, so picks feel
fresh). The game keeps running for everyone else; bots auto-pick randomly so they
stay competitive. There is **no casting time** and the system is **not** just
"reduce cooldown" — upgrades change *how* you play while preserving the
contextual build/sabotage/repair design (you're never locked into one verb).

Upgrade pool (all applied server-side, with stack caps to avoid snowball):

| Upgrade                    | Effect                                                  | Max |
| -------------------------- | ------------------------------------------------------- | --- |
| **Raio de Ação**           | +45 action range each                                   | 3   |
| **Dominação em Massa**     | Dominar also claims one free adjacent tile              | 1   |
| **Sabotador Profissional** | Sabotar also steals 25% of the owner's points each      | 2   |
| **Engenharia Resiliente**  | Tiles you repair become immune to sabotage for a while  | 1   |
| **Pé-de-Vento**            | +12% movement speed each                                | 3   |
| **Reflexos Rápidos**       | −15% action cooldown each (the *only* cooldown option)  | 1   |

Current **level** and an **XP bar** are shown in the HUD; level also appears in
the leaderboard, election cards, and the end-screen story.

## Salas / lobby

- The server manages **multiple rooms** keyed by a short uppercase **code**
  (ambiguous chars like `0/O/1/I` excluded). Each room has its own lobby + game
  lifecycle and its own bots.
- **Host** concept: the creator is host and can **Começar** the match (allowed
  before the room is full — bots fill the rest). If the host leaves, host is
  **reassigned** to another human; if the last human leaves, the room is **torn
  down** (and its bots/timers cleaned up).
- When a match **ends**: multiplayer rooms return to the **waiting room**
  (`lobby:return`) so the host can start a rematch; **solo** rooms auto-restart a
  fresh match to stay lively.
- Invalid / private / already-started / full joins are rejected with a clear
  `room:error` message. Room codes and names are sanitized server-side; lobby
  actions are rate-limited.

## Socket message protocol

**Client → Server**

| Event            | Payload             | Notes                                              |
| ---------------- | ------------------- | ------------------------------------------------- |
| `room:create`    | `{ name }`          | create a public room, become host                 |
| `room:join`      | `{ name, code }`    | join a room by code (validated/sanitized)         |
| `room:quickplay` | `{ name }`          | join any open public room, else create one        |
| `room:solo`      | `{ name }`          | create a private room + start immediately w/ bots |
| `room:start`     | _(none)_            | host only; start the match from the lobby         |
| `room:leave`     | _(none)_            | leave current room                                |
| `input`          | `{ x, y }`          | movement direction in `[-1,1]`; rate-limited      |
| `action`         | _(none)_            | contextual action; server resolves + cooldown     |
| `vote`           | `{ candidateId }`   | only during voting; must be a valid candidate     |
| `decree`         | `{ decreeId }`      | only accepted from the current Mayor              |
| `upgrade:pick`   | `{ upgradeId }`     | only valid against the player's pending offer     |

**Server → Client**

| Event             | Payload                                            | Notes                                   |
| ----------------- | ------------------------------------------------- | --------------------------------------- |
| `room:joined`     | `{ code, selfId, isHost, solo }`                  | after create/join/quickplay/solo        |
| `lobby:update`    | `{ code, solo, hostId, players, count, cap, canStart }` | live waiting-room state           |
| `room:error`      | `{ reason }`                                       | invalid/full/private/started join       |
| `match:start`     | `{ world, cooldownMs }`                            | go to game screen                       |
| `state`           | full snapshot (20 Hz)                              | players (incl. level/xp/cooldown), etc. |
| `election:start`  | `{ electionNumber, candidates, duration }`        | voting opens                            |
| `election:result` | `{ mayorId, mayorName, tally }`                   | tallied results                         |
| `decree:choose`   | `{ options, duration }`                            | **only** to the human Mayor             |
| `decree:active`   | `{ id, name, desc, mayorId, mayorName, until }`   | decree applied                          |
| `level:up`        | `{ level, choices }`                              | **only** to the leveling player         |
| `game:end`        | `{ podium, story, history }`                       | match over                              |
| `lobby:return`    | _(none)_                                           | match ended → back to waiting room      |

Each `state` player entry includes `level`, `xp`, `xpToNext`, `range`,
`cooldown` (ms remaining) and `cooldownTotal` (ms) so the client can render the
level/XP HUD and the cooldown countdown without ever owning that state.

## Security notes

- Player names are validated server-side (trim, cap 18 chars, strip control
  chars). The client renders all user text (names, reputation, story) with
  `textContent` / DOM nodes — **never** via `innerHTML` string interpolation, to
  avoid XSS from other players' names.
- All client inputs are validated server-side; malformed messages are ignored;
  movement input is rate-limited.
- The server keeps running if a client disconnects: the player is cleaned up and
  bots are topped up.

## Known limitations / next steps

- **In-memory state only.** Rooms live in a `Map`; no persistence — a server
  restart drops all rooms/matches.
- **No accounts / auth.** Identity is just a typed name per session; codes are
  the only access control on a room.
- **No mid-match join.** Joining is only allowed while a room is in its lobby;
  joining an in-progress match is rejected with a message (you can join the next
  rematch). Adding live mid-match join is a possible next step.
- **Bot AI is intentionally simple** (seek nearest resource, occasional action,
  weighted-random voting, random upgrade picks). Good enough to feel alive.
- **No anti-cheat beyond authority + basic rate limiting.** Fine for a demo.
- **Upgrade balance is first-pass.** Stacks are capped to avoid runaway snowball,
  but values likely need tuning with real playtests.
- **Share = clipboard copy only.** Next step: deep links / prefilled social share
  and server-side instrumentation of the share event (currently only match-end is
  logged).
- Reconnection relies on socket.io defaults; a dropped player loses their
  in-match progress and, if host, triggers host reassignment.
