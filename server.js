'use strict';

/**
 * CIDADE.io MVP - authoritative multiplayer server.
 *
 * The server owns ALL game state and runs a fixed 20Hz tick. Clients send only
 * their intent (lobby actions, movement direction, action press, vote, decree
 * choice, upgrade pick). The server validates everything and broadcasts state
 * snapshots. Client-sent positions/scores/XP are never trusted.
 *
 * Multiple rooms are supported, keyed by a short code. Each room has its own
 * lobby + game lifecycle. A single tick loop advances every room.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Keep CORS closed to same-origin; the client is served from this same server.
  cors: { origin: false },
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Lightweight health check for platform probes (Render/Railway/Fly/etc.).
// Registered before the static middleware so it can never be shadowed.
app.get(['/health', '/healthz'], (req, res) => {
  res.status(200).json({ status: 'ok', rooms: rooms.size, uptime: process.uptime() });
});

app.use(express.static(path.join(__dirname, 'public')));

// --------------------------------------------------------------------------
// Game constants
// --------------------------------------------------------------------------
const WORLD_W = 2000;
const WORLD_H = 1500;

const TICK_RATE = 20; // Hz
const TICK_MS = 1000 / TICK_RATE;
const DT = 1 / TICK_RATE;

const PLAYER_RADIUS = 18;
const PLAYER_SPEED = 270; // px/s

const TARGET_ENTITIES = 8; // top up with bots until this many entities exist
const MAX_PLAYERS = 12; // hard room capacity (humans + bots)

const RESOURCE_COUNT = 32;
const RESOURCE_RADIUS = 11;
const RESOURCE_POINTS = 5;
const RESOURCE_RESPAWN_MS = 6000;

const TILE_COLS = 8;
const TILE_ROWS = 6;
const TILE_W = WORLD_W / TILE_COLS;
const TILE_H = WORLD_H / TILE_ROWS;
const TILE_DRAW = 130; // visual square size (centered in cell)
const ACTION_RANGE = 130;
const ACTION_COOLDOWN_MS = 4000;

const POINTS_DOMINATE = 15;
const POINTS_SABOTAGE = 20;
const POINTS_REPAIR = 12;
const TRICKLE_PER_TILE = 2; // points/sec per owned tile

const SABOTAGE_DISABLE_MS = 8000; // a sabotaged tile is disabled this long
const REPAIR_SHIELD_MS = 12000; // "repaired area is immune" upgrade duration

const CRISIS_MIN_GAP_MS = 30000;
const CRISIS_MAX_GAP_MS = 55000;
const CRISIS_DURATION_MS = 18000;

const ROUND_PLAY_MS = parseInt(process.env.ROUND_PLAY_MS, 10) || 70000; // playing time between elections (env-overridable for testing)
const VOTE_MS = 12000; // voting window
const DECREE_PICK_MS = 10000; // mayor picks a decree
const DECREE_ACTIVE_MS = 70000; // how long a decree's effect lasts
const MATCH_MS = parseInt(process.env.MATCH_MS, 10) || 360000; // ~6 minutes (env-overridable for testing)
const END_SCREEN_MS = 20000; // pause before returning to lobby / restarting
const MAX_CANDIDATES = 5; // election ballot size (humans always included)

const INPUT_MIN_INTERVAL_MS = 12; // basic input rate limit (~83/s)
const LOBBY_MIN_INTERVAL_MS = 400; // basic rate limit on lobby actions
const MAX_NAME_LEN = 18;
const CODE_LEN = 5;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I

// XP / leveling
const XP_COLLECT = 3;
const XP_DOMINATE = 8;
const XP_SABOTAGE = 10;
const XP_REPAIR = 7;
const XP_BASE = parseInt(process.env.XP_BASE, 10) || 30; // xp needed for level 2 (env-overridable for testing)
const XP_STEP = 25; // extra xp per subsequent level

const BOT_NAMES = [
  'Zé', 'Bea', 'Tonho', 'Lia', 'Caju', 'Nina', 'Bruno', 'Duda',
  'Rato', 'Vera', 'Pingo', 'Sol', 'Fá', 'Gigi', 'Tom', 'Mara',
];

const DECREES = [
  { id: 'renda', name: 'Distribuição de Renda', desc: 'Todos os recursos valem 2x para todo mundo.' },
  { id: 'apagao_estrategico', name: 'Apagão Estratégico', desc: 'Desabilita os quarteirões do 2º colocado.' },
  { id: 'imunidade', name: 'Imunidade Municipal', desc: 'Os quarteirões do Prefeito não podem ser sabotados.' },
  { id: 'mutirao', name: 'Mutirão de Reparo', desc: 'Limpa a crise ativa e reabilita tudo.' },
];

// Upgrade pool: changes HOW you play (not a rigid class). At most ONE option is
// pure cooldown reduction. All effects are applied server-side.
const UPGRADES = [
  { id: 'range', name: 'Raio de Ação', desc: '+45 de alcance da ação.', max: 3 },
  { id: 'multidom', name: 'Dominação em Massa', desc: 'Dominar também toma um quarteirão vizinho livre.', max: 1 },
  { id: 'steal', name: 'Sabotador Profissional', desc: 'Sabotar rouba 25% dos pontos do dono.', max: 2 },
  { id: 'repairshield', name: 'Engenharia Resiliente', desc: 'O que você repara fica imune por um tempo.', max: 1 },
  { id: 'speed', name: 'Pé-de-Vento', desc: '+12% de velocidade de movimento.', max: 3 },
  { id: 'cooldown', name: 'Reflexos Rápidos', desc: '-15% no tempo de recarga da ação.', max: 1 },
];

// --------------------------------------------------------------------------
// Rooms registry
// --------------------------------------------------------------------------
/** code -> room */
const rooms = new Map();

function makeRoom(code, opts = {}) {
  return {
    code,
    solo: !!opts.solo,
    hostId: null,
    players: new Map(), // id -> player
    resources: [],
    tiles: [],
    crisis: { active: false, until: 0, nextAt: 0 },
    decree: null,
    phase: 'lobby', // lobby | playing | voting | decree | ended
    phaseEndsAt: 0,
    nextElectionAt: 0,
    matchEndsAt: 0,
    electionNumber: 0,
    candidates: [],
    votes: new Map(),
    mayorId: null,
    pendingDecreeMayorId: null,
    pendingChoice: null,
    history: [],
    endResult: null,
    botSeq: 0,
    endTimer: null,
  };
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LEN);
}

function sanitizeCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function generateCode() {
  let code;
  let guard = 0;
  do {
    code = '';
    for (let i = 0; i < CODE_LEN; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    guard++;
  } while (rooms.has(code) && guard < 50);
  return code;
}

function pickColor(seed) {
  let h = 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h}, 70%, 55%)`;
}

function makePlayer(id, name, isBot) {
  return {
    id,
    name,
    isBot: !!isBot,
    x: rand(PLAYER_RADIUS, WORLD_W - PLAYER_RADIUS),
    y: rand(PLAYER_RADIUS, WORLD_H - PLAYER_RADIUS),
    dir: { x: 0, y: 0 },
    color: pickColor(id),
    score: 0,
    built: 0,
    hacked: 0,
    repaired: 0,
    lastActionAt: 0,
    lastInputAt: 0,
    // progression
    xp: 0,
    level: 1,
    upgrades: new Map(), // upgradeId -> count
    currentOffer: null, // { choices:[{id,name,desc}] } awaiting a pick
    offerQueue: [],
    // bot AI
    botTargetX: rand(0, WORLD_W),
    botTargetY: rand(0, WORLD_H),
    botRetargetAt: 0,
    botActAt: 0,
  };
}

function identityOf(p) {
  const b = p.built, h = p.hacked, r = p.repaired;
  if (b === 0 && h === 0 && r === 0) return { title: 'Novato', phrase: 'Recém-chegado' };
  if (b >= h && b >= r) return { title: 'Construtor', phrase: `Construiu ${b}` };
  if (h >= b && h >= r) return { title: 'Sabotador', phrase: `Sabotou ${h}` };
  return { title: 'Técnico', phrase: `Reparou ${r}` };
}

function upCount(p, id) {
  return p.upgrades.get(id) || 0;
}
function actionRangeOf(p) {
  return ACTION_RANGE + 45 * upCount(p, 'range');
}
function speedOf(p) {
  return PLAYER_SPEED * (1 + 0.12 * upCount(p, 'speed'));
}
function cooldownOf(p) {
  return ACTION_COOLDOWN_MS * (1 - 0.15 * upCount(p, 'cooldown'));
}

function humanCount(room) {
  let n = 0;
  for (const p of room.players.values()) if (!p.isBot) n++;
  return n;
}
function totalCount(room) {
  return room.players.size;
}

function xpToNext(level) {
  return XP_BASE + (level - 1) * XP_STEP;
}

// --------------------------------------------------------------------------
// World setup
// --------------------------------------------------------------------------
function spawnResource(i) {
  return { id: `r${i}`, x: rand(40, WORLD_W - 40), y: rand(40, WORLD_H - 40), active: true, respawnAt: 0 };
}

function buildTiles() {
  const tiles = [];
  for (let row = 0; row < TILE_ROWS; row++) {
    for (let col = 0; col < TILE_COLS; col++) {
      tiles.push({
        id: `t${col}_${row}`,
        col,
        row,
        cx: col * TILE_W + TILE_W / 2,
        cy: row * TILE_H + TILE_H / 2,
        ownerId: null,
        disabled: false,
        disabledUntil: 0,
        shieldUntil: 0,
      });
    }
  }
  return tiles;
}

function initWorld(room) {
  room.resources = [];
  for (let i = 0; i < RESOURCE_COUNT; i++) room.resources.push(spawnResource(i));
  room.tiles = buildTiles();
}

// --------------------------------------------------------------------------
// Match lifecycle
// --------------------------------------------------------------------------
function startMatch(room) {
  for (const p of room.players.values()) {
    p.score = 0;
    p.built = 0;
    p.hacked = 0;
    p.repaired = 0;
    p.lastActionAt = 0;
    p.xp = 0;
    p.level = 1;
    p.upgrades = new Map();
    p.currentOffer = null;
    p.offerQueue = [];
  }
  initWorld(room);
  const now = Date.now();
  room.crisis = { active: false, until: 0, nextAt: now + rand(CRISIS_MIN_GAP_MS, CRISIS_MAX_GAP_MS) };
  room.decree = null;
  room.candidates = [];
  room.votes = new Map();
  room.mayorId = null;
  room.pendingDecreeMayorId = null;
  room.pendingChoice = null;
  room.electionNumber = 0;
  room.history = [];
  room.endResult = null;
  room.phase = 'playing';
  room.nextElectionAt = now + ROUND_PLAY_MS;
  room.matchEndsAt = now + MATCH_MS;
  topUpBots(room);

  io.to(room.code).emit('match:start', {
    world: { w: WORLD_W, h: WORLD_H, tileDraw: TILE_DRAW },
    cooldownMs: ACTION_COOLDOWN_MS,
  });
}

// --------------------------------------------------------------------------
// Bots
// --------------------------------------------------------------------------
function addBot(room) {
  if (totalCount(room) >= MAX_PLAYERS) return;
  const id = `bot_${room.code}_${++room.botSeq}`;
  const used = new Set([...room.players.values()].map((p) => p.name));
  let name = BOT_NAMES[Math.floor(rand(0, BOT_NAMES.length))];
  let guard = 0;
  while (used.has(name) && guard++ < 40) name = BOT_NAMES[Math.floor(rand(0, BOT_NAMES.length))];
  if (used.has(name)) name = `${name}${room.botSeq}`;
  room.players.set(id, makePlayer(id, name, true));
}

function topUpBots(room) {
  while (totalCount(room) < TARGET_ENTITIES && totalCount(room) < MAX_PLAYERS) addBot(room);
  while (totalCount(room) > Math.max(TARGET_ENTITIES, humanCount(room))) {
    const botId = [...room.players.values()].find((p) => p.isBot)?.id;
    if (!botId) break;
    room.players.delete(botId);
  }
}

function botThink(room, p, now) {
  let target = null;
  let best = Infinity;
  for (const res of room.resources) {
    if (!res.active) continue;
    const d = (res.x - p.x) ** 2 + (res.y - p.y) ** 2;
    if (d < best) { best = d; target = res; }
  }
  if (!target && now > p.botRetargetAt) {
    p.botTargetX = rand(0, WORLD_W);
    p.botTargetY = rand(0, WORLD_H);
    p.botRetargetAt = now + rand(2000, 5000);
  }
  const tx = target ? target.x : p.botTargetX;
  const ty = target ? target.y : p.botTargetY;
  const dx = tx - p.x;
  const dy = ty - p.y;
  const len = Math.hypot(dx, dy) || 1;
  p.dir = { x: dx / len, y: dy / len };

  if (now > p.botActAt) {
    p.botActAt = now + rand(1500, 4000);
    tryAction(room, p, now);
  }
  // bots auto-resolve any pending upgrade offer (random pick)
  if (p.currentOffer) {
    const choice = p.currentOffer.choices[Math.floor(rand(0, p.currentOffer.choices.length))];
    applyUpgrade(p, choice.id);
    advanceOffer(p);
  }
}

function botVote(room, p) {
  if (!room.candidates.length) return;
  const r = Math.random();
  let idx;
  if (r < 0.5) idx = 0;
  else if (r < 0.8) idx = Math.min(1, room.candidates.length - 1);
  else idx = Math.floor(rand(0, room.candidates.length));
  room.votes.set(p.id, room.candidates[idx].id);
}

// --------------------------------------------------------------------------
// Progression (XP / level / upgrades)
// --------------------------------------------------------------------------
function grantXp(room, p, amount) {
  p.xp += amount;
  while (p.xp >= xpToNext(p.level)) {
    p.xp -= xpToNext(p.level);
    p.level++;
    offerUpgrade(room, p);
  }
}

function buildOffer(p) {
  // random subset of up-to-3 upgrades the player has not maxed
  const available = UPGRADES.filter((u) => upCount(p, u.id) < u.max);
  for (let i = available.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [available[i], available[j]] = [available[j], available[i]];
  }
  return available.slice(0, 3).map((u) => ({ id: u.id, name: u.name, desc: u.desc }));
}

function offerUpgrade(room, p) {
  const choices = buildOffer(p);
  if (!choices.length) return; // everything maxed
  if (p.isBot) {
    applyUpgrade(p, choices[Math.floor(rand(0, choices.length))].id);
    return;
  }
  const offer = { choices };
  if (!p.currentOffer) {
    p.currentOffer = offer;
    emitOffer(room, p);
  } else {
    p.offerQueue.push(offer);
  }
}

function emitOffer(room, p) {
  const sock = io.sockets.sockets.get(p.id);
  if (sock) sock.emit('level:up', { level: p.level, choices: p.currentOffer.choices });
}

function advanceOffer(p) {
  if (p.offerQueue.length) {
    p.currentOffer = p.offerQueue.shift();
    const sock = io.sockets.sockets.get(p.id);
    if (sock) sock.emit('level:up', { level: p.level, choices: p.currentOffer.choices });
  } else {
    p.currentOffer = null;
  }
}

function applyUpgrade(p, upgradeId) {
  const def = UPGRADES.find((u) => u.id === upgradeId);
  if (!def) return false;
  const cur = upCount(p, upgradeId);
  if (cur >= def.max) return false;
  p.upgrades.set(upgradeId, cur + 1);
  return true;
}

// --------------------------------------------------------------------------
// Movement & pickups
// --------------------------------------------------------------------------
function integrate(p) {
  const len = Math.hypot(p.dir.x, p.dir.y);
  if (len > 0.001) {
    const nx = p.dir.x / len;
    const ny = p.dir.y / len;
    const spd = speedOf(p);
    p.x = clamp(p.x + nx * spd * DT, PLAYER_RADIUS, WORLD_W - PLAYER_RADIUS);
    p.y = clamp(p.y + ny * spd * DT, PLAYER_RADIUS, WORLD_H - PLAYER_RADIUS);
  }
}

function collectResources(room, p, now) {
  const mult = room.decree && room.decree.id === 'renda' ? 2 : 1;
  for (const res of room.resources) {
    if (!res.active) continue;
    const rr = PLAYER_RADIUS + RESOURCE_RADIUS;
    if ((res.x - p.x) ** 2 + (res.y - p.y) ** 2 <= rr * rr) {
      res.active = false;
      res.respawnAt = now + RESOURCE_RESPAWN_MS;
      p.score += RESOURCE_POINTS * mult;
      grantXp(room, p, XP_COLLECT);
    }
  }
}

function updateResources(room, now) {
  for (const res of room.resources) {
    if (!res.active && now >= res.respawnAt) {
      res.x = rand(40, WORLD_W - 40);
      res.y = rand(40, WORLD_H - 40);
      res.active = true;
    }
  }
}

// --------------------------------------------------------------------------
// Contextual action: resolved server-side by nearest tile
// --------------------------------------------------------------------------
function tryAction(room, p, now) {
  if (room.phase !== 'playing') return;
  if (now - p.lastActionAt < cooldownOf(p)) return;

  const range = actionRangeOf(p);
  let tile = null;
  let best = range * range;
  for (const t of room.tiles) {
    const d = (t.cx - p.x) ** 2 + (t.cy - p.y) ** 2;
    if (d <= best) { best = d; tile = t; }
  }
  if (!tile) return;

  let acted = false;
  if (tile.disabled) {
    // REPARAR
    tile.disabled = false;
    tile.disabledUntil = 0;
    if (upCount(p, 'repairshield') > 0) tile.shieldUntil = now + REPAIR_SHIELD_MS;
    p.repaired++;
    p.score += POINTS_REPAIR;
    grantXp(room, p, XP_REPAIR);
    acted = true;
  } else if (tile.ownerId === null) {
    // DOMINAR
    tile.ownerId = p.id;
    p.built++;
    p.score += POINTS_DOMINATE;
    grantXp(room, p, XP_DOMINATE);
    acted = true;
    if (upCount(p, 'multidom') > 0) claimAdjacentFree(room, p, tile, now);
  } else if (tile.ownerId !== p.id) {
    // SABOTAR (blocked by Imunidade Municipal on Mayor tiles or repair shield)
    const immune =
      (room.decree && room.decree.id === 'imunidade' && tile.ownerId === room.decree.mayorId) ||
      (tile.shieldUntil && now < tile.shieldUntil);
    if (!immune) {
      const victim = room.players.get(tile.ownerId);
      const stealFrac = 0.25 * upCount(p, 'steal');
      if (stealFrac > 0 && victim) {
        const stolen = Math.min(victim.score, Math.round(victim.score * stealFrac));
        victim.score -= stolen;
        p.score += stolen;
      }
      tile.ownerId = null;
      tile.disabled = true;
      tile.disabledUntil = now + SABOTAGE_DISABLE_MS;
      tile.shieldUntil = 0;
      p.hacked++;
      p.score += POINTS_SABOTAGE;
      grantXp(room, p, XP_SABOTAGE);
      acted = true;
    }
  } else if (room.crisis.active) {
    // owner == self: only useful during a crisis (repair credit)
    p.repaired++;
    p.score += Math.round(POINTS_REPAIR / 2);
    grantXp(room, p, Math.round(XP_REPAIR / 2));
    acted = true;
  }

  if (acted) p.lastActionAt = now;
}

function claimAdjacentFree(room, p, tile, now) {
  // claim one free orthogonally-adjacent tile (Dominação em Massa)
  const neighbors = [
    [tile.col - 1, tile.row], [tile.col + 1, tile.row],
    [tile.col, tile.row - 1], [tile.col, tile.row + 1],
  ];
  for (const [c, r] of neighbors) {
    const t = room.tiles.find((tt) => tt.col === c && tt.row === r);
    if (t && t.ownerId === null && !t.disabled) {
      t.ownerId = p.id;
      p.built++;
      p.score += POINTS_DOMINATE;
      return;
    }
  }
}

// --------------------------------------------------------------------------
// Crisis
// --------------------------------------------------------------------------
function updateCrisis(room, now) {
  if (room.crisis.active) {
    if (now >= room.crisis.until) {
      room.crisis.active = false;
      room.crisis.nextAt = now + rand(CRISIS_MIN_GAP_MS, CRISIS_MAX_GAP_MS);
    }
  } else if (now >= room.crisis.nextAt) {
    startCrisis(room, now);
  }
}

function startCrisis(room, now) {
  room.crisis.active = true;
  room.crisis.until = now + CRISIS_DURATION_MS;
  for (const t of room.tiles) {
    if (t.ownerId === null && !t.disabled) {
      t.disabled = true;
      t.disabledUntil = now + CRISIS_DURATION_MS;
    }
  }
}

function updateTileTimers(room, now) {
  for (const t of room.tiles) {
    if (t.disabled && t.disabledUntil && now >= t.disabledUntil) {
      t.disabled = false;
      t.disabledUntil = 0;
    }
    if (t.shieldUntil && now >= t.shieldUntil) t.shieldUntil = 0;
  }
}

function applyTrickle(room) {
  const owners = new Map();
  for (const t of room.tiles) {
    if (t.ownerId && !t.disabled) owners.set(t.ownerId, (owners.get(t.ownerId) || 0) + 1);
  }
  for (const [ownerId, count] of owners) {
    const p = room.players.get(ownerId);
    if (p) p.score += count * TRICKLE_PER_TILE * DT;
  }
}

// --------------------------------------------------------------------------
// Elections
// --------------------------------------------------------------------------
function rankedPlayers(room) {
  return [...room.players.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : 1;
  });
}

function startElection(room) {
  room.electionNumber++;
  room.phase = 'voting';
  room.phaseEndsAt = Date.now() + VOTE_MS;
  room.votes = new Map();
  const ranked = rankedPlayers(room);
  // Humans ALWAYS run (even with low score); fill the rest with top bots.
  const humans = ranked.filter((p) => !p.isBot);
  const others = ranked.filter((p) => p.isBot);
  const fill = Math.max(0, MAX_CANDIDATES - humans.length);
  const chosen = [...humans, ...others.slice(0, fill)].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : 1;
  });
  room.candidates = chosen.map((p) => {
    const id = identityOf(p);
    return {
      id: p.id, name: p.name, score: Math.round(p.score), identity: id.title,
      level: p.level, built: p.built, hacked: p.hacked, repaired: p.repaired,
    };
  });
  for (const p of room.players.values()) if (p.isBot) botVote(room, p);

  io.to(room.code).emit('election:start', {
    electionNumber: room.electionNumber,
    candidates: room.candidates,
    duration: VOTE_MS,
  });
}

function tallyElection(room) {
  const counts = new Map();
  for (const cand of room.candidates) counts.set(cand.id, 0);
  for (const candidateId of room.votes.values()) {
    if (counts.has(candidateId)) counts.set(candidateId, counts.get(candidateId) + 1);
  }
  // winner: most votes; tie -> higher score; tie -> lower id (deterministic)
  let winner = null;
  let bestVotes = -1;
  const scoreById = new Map(room.candidates.map((c) => [c.id, c.score]));
  for (const cand of room.candidates) {
    const v = counts.get(cand.id) || 0;
    if (
      v > bestVotes ||
      (v === bestVotes &&
        winner &&
        (scoreById.get(cand.id) > scoreById.get(winner) ||
          (scoreById.get(cand.id) === scoreById.get(winner) && cand.id < winner)))
    ) {
      bestVotes = v;
      winner = cand.id;
    }
  }

  const tally = room.candidates.map((c) => ({ id: c.id, name: c.name, votes: counts.get(c.id) || 0 }));
  tally.sort((a, b) => b.votes - a.votes);

  room.mayorId = winner;
  const mayor = room.players.get(winner);
  io.to(room.code).emit('election:result', { mayorId: winner, mayorName: mayor ? mayor.name : '—', tally });

  room.phase = 'decree';
  room.phaseEndsAt = Date.now() + DECREE_PICK_MS;
  room.pendingDecreeMayorId = winner;
  room.pendingChoice = null;

  if (mayor && mayor.isBot) {
    queueDecree(room, winner, DECREES[Math.floor(rand(0, DECREES.length))].id);
  } else if (mayor) {
    const sock = io.sockets.sockets.get(winner);
    if (sock) sock.emit('decree:choose', { options: DECREES, duration: DECREE_PICK_MS });
  }
}

function queueDecree(room, mayorId, decreeId) {
  if (room.pendingDecreeMayorId !== mayorId) return;
  const def = DECREES.find((d) => d.id === decreeId);
  if (!def) return;
  room.pendingChoice = { mayorId, def };
}

function finishDecreePhase(room) {
  const now = Date.now();
  let def = room.pendingChoice && room.pendingChoice.def;
  if (!def) def = DECREES[Math.floor(rand(0, DECREES.length))];
  applyDecree(room, room.mayorId, def, now);
  room.pendingChoice = null;
  room.pendingDecreeMayorId = null;

  const mayor = room.players.get(room.mayorId);
  room.history.push({
    electionNumber: room.electionNumber,
    mayorName: mayor ? mayor.name : '—',
    mayorId: room.mayorId,
    decreeName: def.name,
    decreeId: def.id,
  });

  room.phase = 'playing';
  room.nextElectionAt = now + ROUND_PLAY_MS;
  io.to(room.code).emit('decree:active', {
    id: def.id, name: def.name, desc: def.desc,
    mayorId: room.mayorId, mayorName: mayor ? mayor.name : '—',
    until: room.decree ? room.decree.until : now + DECREE_ACTIVE_MS,
  });
}

function applyDecree(room, mayorId, def, now) {
  room.decree = { id: def.id, name: def.name, desc: def.desc, mayorId, until: now + DECREE_ACTIVE_MS };
  if (def.id === 'apagao_estrategico') {
    const ranked = rankedPlayers(room);
    const second = ranked[1];
    if (second) {
      for (const t of room.tiles) {
        if (t.ownerId === second.id) { t.disabled = true; t.disabledUntil = now + DECREE_ACTIVE_MS; }
      }
    }
  } else if (def.id === 'mutirao') {
    room.crisis.active = false;
    room.crisis.nextAt = now + rand(CRISIS_MIN_GAP_MS, CRISIS_MAX_GAP_MS);
    for (const t of room.tiles) { t.disabled = false; t.disabledUntil = 0; }
  }
}

function updateDecreeExpiry(room, now) {
  if (room.decree && now >= room.decree.until) room.decree = null;
}

// --------------------------------------------------------------------------
// Match end + story generation
// --------------------------------------------------------------------------
function endMatch(room) {
  room.phase = 'ended';
  room.phaseEndsAt = Date.now() + END_SCREEN_MS;

  const ranked = rankedPlayers(room);
  const podium = ranked.map((p, i) => {
    const id = identityOf(p);
    return {
      rank: i + 1, id: p.id, name: p.name, isBot: p.isBot, score: Math.round(p.score),
      identity: id.title, level: p.level, built: p.built, hacked: p.hacked, repaired: p.repaired,
    };
  });

  const story = buildStory(room, podium);
  room.endResult = { podium, story, history: room.history };

  console.log(
    `[match-end] room=${room.code} elections=${room.history.length} ` +
      `winner=${podium[0] ? podium[0].name : '-'} players=${podium.length}`
  );

  io.to(room.code).emit('game:end', room.endResult);

  if (room.endTimer) clearTimeout(room.endTimer);
  room.endTimer = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (room.solo) {
      startMatch(room); // solo practice auto-restarts to stay lively
    } else {
      returnToLobby(room);
    }
  }, END_SCREEN_MS);
}

function returnToLobby(room) {
  room.phase = 'lobby';
  // drop bots so the waiting room shows only humans; new bots fill on next start
  for (const id of [...room.players.keys()]) {
    if (room.players.get(id).isBot) room.players.delete(id);
  }
  room.mayorId = null;
  room.decree = null;
  io.to(room.code).emit('lobby:return');
  broadcastLobby(room);
}

function buildStory(room, podium) {
  const lines = [];
  const mayors = room.history;
  lines.push(`Esta cidade teve ${mayors.length} prefeito(s).`);
  for (const h of mayors) {
    lines.push(`Eleição ${h.electionNumber}: ${h.mayorName} virou Prefeito e decretou "${h.decreeName}".`);
  }
  const apagaoMayor = mayors.find((m) => m.decreeId === 'apagao_estrategico');
  if (apagaoMayor) lines.push(`${apagaoMayor.mayorName} apostou no apagão estratégico para derrubar o rival.`);
  lines.push('');
  lines.push('Pódio:');
  podium.slice(0, 3).forEach((p) => {
    const repLine = p.identity === 'Novato'
      ? 'mal começou'
      : `${p.identity} nv.${p.level} (construiu ${p.built}, sabotou ${p.hacked}, reparou ${p.repaired})`;
    lines.push(`${p.rank}º ${p.name} — ${p.score} pts — ${repLine}`);
  });
  const champ = podium[0];
  if (champ) {
    lines.push('');
    lines.push(`No fim, ${champ.name} dominou a CIDADE.io como ${champ.identity}.`);
  }
  lines.push('Jogue em CIDADE.io e conte a sua história.');
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// Lobby broadcast + snapshot
// --------------------------------------------------------------------------
function lobbyPayload(room) {
  const players = [...room.players.values()]
    .filter((p) => !p.isBot)
    .map((p) => ({ id: p.id, name: p.name, isHost: p.id === room.hostId, isBot: false }));
  return {
    code: room.code,
    solo: room.solo,
    hostId: room.hostId,
    players,
    count: players.length,
    cap: MAX_PLAYERS,
    canStart: room.phase === 'lobby' && players.length >= 1,
  };
}

function broadcastLobby(room) {
  io.to(room.code).emit('lobby:update', lobbyPayload(room));
}

function buildSnapshot(room) {
  const now = Date.now();
  const players = [];
  for (const p of room.players.values()) {
    const id = identityOf(p);
    const cdTotal = cooldownOf(p);
    players.push({
      id: p.id, name: p.name, isBot: p.isBot,
      x: Math.round(p.x), y: Math.round(p.y), color: p.color,
      score: Math.round(p.score), built: p.built, hacked: p.hacked, repaired: p.repaired,
      identity: id.title, phrase: id.phrase,
      level: p.level, xp: Math.round(p.xp), xpToNext: xpToNext(p.level),
      range: Math.round(actionRangeOf(p)),
      cooldown: Math.max(0, cdTotal - (now - p.lastActionAt)),
      cooldownTotal: Math.round(cdTotal),
    });
  }

  const resources = [];
  for (const r of room.resources) if (r.active) resources.push({ id: r.id, x: r.x, y: r.y });

  const tiles = room.tiles.map((t) => ({
    id: t.id, cx: t.cx, cy: t.cy, ownerId: t.ownerId, disabled: t.disabled,
    shielded: t.shieldUntil > now,
  }));

  return {
    now,
    phase: room.phase,
    world: { w: WORLD_W, h: WORLD_H, tileDraw: TILE_DRAW },
    players, resources, tiles,
    crisis: room.crisis.active ? { until: room.crisis.until } : null,
    decree: room.decree
      ? { id: room.decree.id, name: room.decree.name, desc: room.decree.desc, mayorId: room.decree.mayorId, until: room.decree.until }
      : null,
    mayorId: room.mayorId,
    phaseEndsAt: room.phaseEndsAt,
    nextElectionAt: room.nextElectionAt,
    matchEndsAt: room.matchEndsAt,
    electionNumber: room.electionNumber,
  };
}

// --------------------------------------------------------------------------
// Main tick loop (advances every room)
// --------------------------------------------------------------------------
function tickRoom(room) {
  const now = Date.now();
  if (room.phase === 'lobby') return; // no simulation while waiting

  if (room.phase !== 'ended') {
    for (const p of room.players.values()) if (p.isBot) botThink(room, p, now);
    for (const p of room.players.values()) integrate(p);
  }

  if (room.phase === 'playing') {
    updateResources(room, now);
    updateCrisis(room, now);
    updateTileTimers(room, now);
    updateDecreeExpiry(room, now);
    for (const p of room.players.values()) collectResources(room, p, now);
    applyTrickle(room);

    if (now >= room.matchEndsAt) endMatch(room);
    else if (now >= room.nextElectionAt) startElection(room);
  } else if (room.phase === 'voting') {
    if (now >= room.phaseEndsAt) tallyElection(room);
  } else if (room.phase === 'decree') {
    if (now >= room.phaseEndsAt) finishDecreePhase(room);
  }

  io.to(room.code).emit('state', buildSnapshot(room));
}

function tick() {
  for (const room of rooms.values()) tickRoom(room);
}

// --------------------------------------------------------------------------
// Room membership helpers
// --------------------------------------------------------------------------
function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.roomCode = null;
  socket.leave(code);
  if (!room) return;

  const wasHost = room.hostId === socket.id;
  room.players.delete(socket.id);

  if (humanCount(room) === 0) {
    // clean teardown of empty rooms
    if (room.endTimer) clearTimeout(room.endTimer);
    rooms.delete(code);
    return;
  }

  if (wasHost) {
    // reassign host to another human
    const nextHuman = [...room.players.values()].find((p) => !p.isBot);
    room.hostId = nextHuman ? nextHuman.id : null;
  }

  if (room.phase === 'lobby') broadcastLobby(room);
  else topUpBots(room);
}

// --------------------------------------------------------------------------
// Socket protocol
// --------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.lastLobbyAt = 0;

  function lobbyRateLimited() {
    const now = Date.now();
    if (now - socket.data.lastLobbyAt < LOBBY_MIN_INTERVAL_MS) return true;
    socket.data.lastLobbyAt = now;
    return false;
  }

  function joinRoom(room, name, asHost) {
    const player = makePlayer(socket.id, name, false);
    room.players.set(socket.id, player);
    socket.data.roomCode = room.code;
    socket.join(room.code);
    if (asHost) room.hostId = socket.id;
    socket.emit('room:joined', {
      code: room.code, selfId: socket.id, isHost: room.hostId === socket.id, solo: room.solo,
    });
  }

  socket.on('room:create', (payload) => {
    if (socket.data.roomCode || lobbyRateLimited()) return;
    const name = sanitizeName(payload && payload.name) || 'Jogador';
    const code = generateCode();
    const room = makeRoom(code, { solo: false });
    rooms.set(code, room);
    joinRoom(room, name, true);
    broadcastLobby(room);
  });

  socket.on('room:join', (payload) => {
    if (socket.data.roomCode || lobbyRateLimited()) return;
    const name = sanitizeName(payload && payload.name) || 'Jogador';
    const code = sanitizeCode(payload && payload.code);
    const room = rooms.get(code);
    if (!room) return socket.emit('room:error', { reason: 'Sala não encontrada.' });
    if (room.solo) return socket.emit('room:error', { reason: 'Esta sala é privada.' });
    if (room.phase !== 'lobby') return socket.emit('room:error', { reason: 'A partida já começou. Tente quando voltar ao lobby.' });
    if (humanCount(room) >= MAX_PLAYERS) return socket.emit('room:error', { reason: 'Sala cheia.' });
    joinRoom(room, name, false);
    broadcastLobby(room);
  });

  socket.on('room:quickplay', (payload) => {
    if (socket.data.roomCode || lobbyRateLimited()) return;
    const name = sanitizeName(payload && payload.name) || 'Jogador';
    let room = null;
    for (const r of rooms.values()) {
      if (!r.solo && r.phase === 'lobby' && humanCount(r) < MAX_PLAYERS) { room = r; break; }
    }
    if (!room) {
      room = makeRoom(generateCode(), { solo: false });
      rooms.set(room.code, room);
      joinRoom(room, name, true);
    } else {
      joinRoom(room, name, false);
    }
    broadcastLobby(room);
  });

  socket.on('room:solo', (payload) => {
    if (socket.data.roomCode || lobbyRateLimited()) return;
    const name = sanitizeName(payload && payload.name) || 'Jogador';
    const room = makeRoom(generateCode(), { solo: true });
    rooms.set(room.code, room);
    joinRoom(room, name, true);
    startMatch(room); // start immediately, no waiting room
  });

  socket.on('room:start', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.id !== room.hostId) return; // host only
    if (room.phase !== 'lobby') return;
    startMatch(room);
  });

  socket.on('room:leave', () => {
    leaveRoom(socket);
  });

  socket.on('input', (payload) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const now = Date.now();
    if (now - p.lastInputAt < INPUT_MIN_INTERVAL_MS) return;
    p.lastInputAt = now;
    if (!payload || typeof payload !== 'object') return;
    let dx = Number(payload.x);
    let dy = Number(payload.y);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    p.dir = { x: clamp(dx, -1, 1), y: clamp(dy, -1, 1) };
  });

  socket.on('action', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    tryAction(room, p, Date.now());
  });

  socket.on('vote', (payload) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'voting') return;
    if (!room.players.has(socket.id)) return;
    const candidateId = payload && payload.candidateId;
    if (typeof candidateId !== 'string') return;
    if (!room.candidates.some((c) => c.id === candidateId)) return;
    room.votes.set(socket.id, candidateId);
  });

  socket.on('decree', (payload) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'decree') return;
    if (socket.id !== room.pendingDecreeMayorId) return;
    const decreeId = payload && payload.decreeId;
    if (typeof decreeId !== 'string') return;
    queueDecree(room, socket.id, decreeId);
  });

  socket.on('upgrade:pick', (payload) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || !p.currentOffer) return;
    const upgradeId = payload && payload.upgradeId;
    if (typeof upgradeId !== 'string') return;
    if (!p.currentOffer.choices.some((c) => c.id === upgradeId)) return;
    applyUpgrade(p, upgradeId);
    advanceOffer(p);
  });

  socket.on('disconnect', () => {
    leaveRoom(socket);
  });
});

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
setInterval(tick, TICK_MS);

// Bind to 0.0.0.0 so the process is reachable inside container/PaaS networks
// (Render/Railway/Fly route external traffic to the container's published port).
server.listen(PORT, HOST, () => {
  console.log(`CIDADE.io MVP server running on http://${HOST}:${PORT}`);
});
