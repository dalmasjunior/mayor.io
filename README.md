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
  - **All players are frozen server-side during the election** (both the voting
    window and the mayor's decree-selection): movement and the action key are
    rejected for everyone — humans and bots alike — until the decree resolves and
    normal play resumes. This closes an exploit where a human could pre-position
    on a target tile while the bots idled. Non-mayor players see a
    `👑 <Prefeito> está escolhendo o decreto...` waiting overlay; the voting
    overlay covers the voting window. The mayor's pick has a timer + default so
    nothing hangs.
  - Top candidates (by score) are shown; **every** player and bot casts a **real
    vote**; the server **tallies** all votes (real apuração — not first-click).
    Ties broken deterministically (higher score, then lower id). Bots weight
    their vote toward higher-reputation candidates.
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

## Scoring economy

All points are awarded **server-side** (`server.js`). The HUD shows your total,
**passive income rate** (`+N/s`), and a **?** breakdown panel. Floating numbers
and toasts label the source explicitly; **passive trickle never spawns floaters**
(so moving doesn't leave a "+pts" trail).

| Source | Constant | Points |
|--------|----------|--------|
| Walk over resource | `RESOURCE_POINTS` | **+5** (+10 while **Distribuição de Renda** decree is active) |
| Dominar quarteirão | `POINTS_DOMINATE` | **+15** (adjacent free tile from **Dominação em Massa** upgrade also +15) |
| Sabotar quarteirão | `POINTS_SABOTAGE` | **+20** base |
| Sabotar + steal upgrade | `STEAL_FRAC_PER_STACK` × stacks, `STEAL_CAP` | up to **15%/stack** of victim score, **max +60** per hit |
| Reparar (disabled tile) | `POINTS_REPAIR` | **+12** |
| Reparar (own tile, crisis) | `POINTS_REPAIR / 2` | **+6** |
| Passive income | `TRICKLE_PER_TILE` | **+2/s per owned, non-disabled tile** (applied every tick at 20 Hz: `count × 2 × DT`) |

**Does each house generate more points?** Yes — each quarteirão you **dominate**
adds **+2 points per second** of passive income (`TRICKLE_PER_TILE`), as long as
it is not disabled. Dominating also gives a one-time **+15** (`POINTS_DOMINATE`).
More owned tiles = higher passive rate (linear, not compounding per tile beyond
the sum).

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

Action feedback spawns at the **target tile** (dominar / sabotar / reparar),
resource pickups at the player, and **passive income is silent** (no floaters).
Labels are explicit (`+15 DOMINAR`, `+20 SABOTAR`, `+5 COLETA`, etc.) with
short HUD toasts. Action particles, a tile-claim flash, and a short
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
fresh). The game keeps running for everyone else; bots pick upgrades coherently
with their persona (see Bots below) so they stay competitive. There is **no
casting time** and the system is **not** just
"reduce cooldown" — upgrades change *how* you play while preserving the
contextual build/sabotage/repair design (you're never locked into one verb).

Upgrade pool (all applied server-side, with stack caps to avoid snowball):

| Upgrade                    | Effect                                                  | Max |
| -------------------------- | ------------------------------------------------------- | --- |
| **Raio de Ação**           | +45 action range each                                   | 3   |
| **Dominação em Massa**     | Dominar also claims one free adjacent tile              | 1   |
| **Sabotador Profissional** | Sabotar also steals 15% of the owner's points (cap +60) | 2   |
| **Engenharia Resiliente**  | Tiles you repair become immune to sabotage for a while  | 1   |
| **Pé-de-Vento**            | +12% movement speed each                                | 3   |
| **Reflexos Rápidos**       | −15% action cooldown each (the *only* cooldown option)  | 1   |

Current **level** and an **XP bar** are shown in the HUD; level also appears in
the leaderboard, election cards, and the end-screen story.

## Bots (AI & difficulty)

Bots are designed to feel like players, not machines:

- **Personas.** Each bot gets a tendency — `builder` (dominar), `saboteur`
  (sabotar enemy tiles), `tech` (repair, especially during a crisis), or
  `collector` (resources). It drives both **target selection** (pick the nearest
  *relevant* tile/resource instead of random) and **upgrade picks** (a saboteur
  favors `steal`, a tech favors `repairshield`/`cooldown`, etc.).
- **Sensible targeting.** Bots head to the nearest actionable target for their
  persona, avoid uselessly re-claiming their own tiles, skip immune/shielded
  tiles, grab a resource if it's clearly on the way, and **react to the active
  crisis** (repair-leaning bots go fix disabled blocks).
- **Less punishing.** A difficulty dial (`botAggro`, **0.7 in solo/bots mode**,
  0.85 otherwise) scales a **slower, jittered action cadence** and adds
  **imperfect targeting** (they sometimes wander/collect), so a lone human can
  compete and have fun without the bots feeling relentless. They are still
  active — not a walkover.

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
- **Bot AI is persona-driven but still lightweight** (greedy nearest-target
  selection, crisis reaction, persona-weighted upgrades/votes, difficulty dial).
  No pathfinding or long-term planning — good enough to feel like players.
- **No anti-cheat beyond authority + basic rate limiting.** Fine for a demo.
- **Balance is first-pass (light review only).** After playtest feedback that
  "sabotage may out-scale", a quick math review found the `Sabotador
  Profissional` **steal** upgrade was the clear outlier: it transferred **25% of
  the victim's *entire* score per hit, uncapped**, so sabotaging a leader created
  a huge two-way swing every ~4s — out-scaling dominar (+15 +trickle) and reparar
  (+12). Conservative change: steal reduced to **15%/stack and capped at +60
  points per sabotage** (base action points 15/20/12 left untouched — they looked
  roughly balanced and there's no telemetry yet). Revisit with real data.
- **Share = clipboard copy only.** Next step: deep links / prefilled social share
  and server-side instrumentation of the share event (currently only match-end is
  logged).
- Reconnection relies on socket.io defaults; a dropped player loses their
  in-match progress and, if host, triggers host reassignment.
