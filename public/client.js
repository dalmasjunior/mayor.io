'use strict';

/* CIDADE.io client: lobby + game with a neon-noir facelift.
   Sends only intent (lobby actions, input, action, vote, decree, upgrade pick).
   All user-provided text (names, room codes, story) is rendered with
   textContent / DOM nodes — never via innerHTML string interpolation.

   The contextual-action HUD replicates the SERVER's "nearest target" logic from
   the snapshot for DISPLAY ONLY. The server remains authoritative on resolve. */

(function () {
  const socket = io();

  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');

  const startScreen = $('startScreen');
  const lobbyScreen = $('lobbyScreen');
  const electionScreen = $('electionScreen');
  const decreeScreen = $('decreeScreen');
  const decreeWaitScreen = $('decreeWaitScreen');
  const levelupScreen = $('levelupScreen');
  const endScreen = $('endScreen');
  const hud = $('hud');
  const banner = $('banner');
  const resultFlash = $('resultFlash');
  const vignette = $('vignette');

  const FONT = "'Space Grotesk', system-ui, sans-serif";
  const MONO = "'Space Mono', monospace";

  // ---- Action metadata (display only) ----
  const ACT = {
    dom: { cls: 'act-dom', color: '#f5e642', emoji: '🟡', verb: 'DOMINAR' },
    sab: { cls: 'act-sab', color: '#ff3d81', emoji: '🔴', verb: 'SABOTAR' },
    rep: { cls: 'act-rep', color: '#38f5a8', emoji: '🟢', verb: 'REPARAR' },
    none: { cls: 'act-none', color: '#8b93a7', emoji: '⚪', verb: 'AÇÃO' },
  };

  // ---- State ----
  let selfId = null;
  let roomCode = null;
  let isHost = false;
  let solo = false;
  let inGame = false;
  let snapshot = null;
  let world = { w: 2000, h: 1500, tileDraw: 130 };
  let camera = { x: 0, y: 0 };
  let currentAction = { type: 'none' };

  // Score constants — mirror server.js (display / UX only; server stays authoritative)
  const SCORE = {
    RESOURCE: 5,
    DOMINATE: 15,
    SABOTAGE: 20,
    REPAIR: 12,
    REPAIR_CRISIS: 6,
    TRICKLE_PER_TILE: 2,
  };

  // juice trackers
  let prevSelf = null; // { score, built, hacked, repaired }
  let prevTileState = new Map(); // tileId -> { ownerId, disabled }
  const floaters = []; // floating texts
  const particles = [];
  const flashes = []; // tile claim rings
  let shakeMag = 0;

  const keys = { up: false, down: false, left: false, right: false };
  let joyVec = { x: 0, y: 0 };
  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- Sound (tiny WebAudio synth, no binaries) ----
  const Sound = (function () {
    let ac = null;
    let muted = localStorage.getItem('cidade_muted') === '1';
    function ctxOf() {
      if (!ac) {
        try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; }
      }
      return ac;
    }
    function blip(freq, dur, type, gain, when) {
      if (muted) return;
      const c = ctxOf();
      if (!c) return;
      if (c.state === 'suspended') c.resume();
      const t = c.currentTime + (when || 0);
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      o.connect(g); g.connect(c.destination);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain || 0.12, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t); o.stop(t + dur + 0.03);
    }
    function seq(notes, type, gain) {
      notes.forEach((n, i) => blip(n, 0.18, type, gain, i * 0.07));
    }
    return {
      collect() { blip(900, 0.08, 'triangle', 0.06); },
      dominar() { blip(330, 0.12, 'sawtooth', 0.11); blip(495, 0.14, 'sawtooth', 0.07, 0.02); },
      sabotar() { blip(170, 0.22, 'square', 0.13); blip(110, 0.28, 'square', 0.1, 0.02); },
      reparar() { blip(540, 0.12, 'sine', 0.11); blip(720, 0.14, 'sine', 0.07, 0.03); },
      hit() { blip(90, 0.2, 'square', 0.12); },
      election() { seq([440, 554, 659], 'triangle', 0.11); },
      decree() { blip(150, 0.4, 'sawtooth', 0.15); blip(75, 0.5, 'sawtooth', 0.11, 0.02); },
      victory() { seq([523, 659, 784, 1046], 'triangle', 0.13); },
      toggle() { muted = !muted; localStorage.setItem('cidade_muted', muted ? '1' : '0'); return muted; },
      isMuted() { return muted; },
      resume() { const c = ctxOf(); if (c && c.state === 'suspended') c.resume(); },
    };
  })();

  function refreshMuteBtn() {
    $('muteBtn').textContent = Sound.isMuted() ? '🔇' : '🔊';
  }
  refreshMuteBtn();
  $('muteBtn').addEventListener('click', () => { Sound.toggle(); Sound.resume(); refreshMuteBtn(); });

  let scoreBreakdownOpen = false;
  $('scoreInfoBtn').addEventListener('click', () => {
    scoreBreakdownOpen = !scoreBreakdownOpen;
    $('scoreBreakdown').classList.toggle('hidden', !scoreBreakdownOpen);
    $('scoreInfoBtn').classList.toggle('active', scoreBreakdownOpen);
  });

  function getName() { return $('nameInput').value; }

  function showOnly(screen) {
    [startScreen, lobbyScreen, electionScreen, decreeScreen, decreeWaitScreen, endScreen].forEach((s) =>
      s.classList.add('hidden')
    );
    if (screen) screen.classList.remove('hidden');
  }

  // ---- Menu actions ----
  $('quickBtn').addEventListener('click', () => { Sound.resume(); socket.emit('room:quickplay', { name: getName() }); });
  $('createBtn').addEventListener('click', () => { Sound.resume(); socket.emit('room:create', { name: getName() }); });
  $('soloBtn').addEventListener('click', () => { Sound.resume(); socket.emit('room:solo', { name: getName() }); });
  $('joinToggleBtn').addEventListener('click', () => {
    $('joinRow').classList.toggle('hidden');
    $('codeInput').focus();
  });
  $('joinBtn').addEventListener('click', doJoin);
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  function doJoin() { Sound.resume(); socket.emit('room:join', { name: getName(), code: $('codeInput').value }); }

  // ---- Lobby buttons ----
  $('startBtn').addEventListener('click', () => socket.emit('room:start'));
  $('leaveBtn').addEventListener('click', () => { socket.emit('room:leave'); resetToMenu(); });
  $('codeBox').addEventListener('click', () => {
    copyText(roomCode || '', () => { $('copyStatus').textContent = 'Código copiado!'; });
  });

  function resetToMenu() {
    inGame = false;
    selfId = null; roomCode = null; isHost = false; solo = false; snapshot = null;
    hud.classList.add('hidden');
    levelupScreen.classList.add('hidden');
    vignette.classList.remove('dramatic');
    showOnly(startScreen);
  }

  // ---- Socket: lobby ----
  socket.on('room:joined', (d) => {
    selfId = d.selfId; roomCode = d.code; isHost = d.isHost; solo = d.solo;
    $('menuError').textContent = '';
    if (!solo) showOnly(lobbyScreen);
  });

  socket.on('lobby:update', (d) => {
    roomCode = d.code;
    $('roomCode').textContent = d.code;
    $('playerCount').textContent = `${d.count} / ${d.cap}`;
    isHost = d.hostId === selfId;

    const list = $('lobbyPlayers');
    list.textContent = '';
    for (const p of d.players) {
      const row = document.createElement('div');
      row.className = 'lp-row';
      const name = document.createElement('span');
      name.className = 'lp-name';
      name.textContent = p.name + (p.id === selfId ? ' (você)' : '');
      row.appendChild(name);
      if (p.isHost) {
        const tag = document.createElement('span');
        tag.className = 'lp-host';
        tag.textContent = 'host';
        row.appendChild(tag);
      }
      list.appendChild(row);
    }

    $('startBtn').classList.toggle('hidden', !isHost);
    $('startBtn').disabled = !d.canStart;
    $('lobbyHint').textContent = isHost
      ? 'Você é o host. Comece quando quiser — bots completam a sala.'
      : 'Aguardando o host iniciar a partida...';
  });

  socket.on('room:error', (d) => {
    $('menuError').textContent = (d && d.reason) || 'Erro ao entrar na sala.';
  });

  socket.on('lobby:return', () => {
    inGame = false;
    hud.classList.add('hidden');
    levelupScreen.classList.add('hidden');
    vignette.classList.remove('dramatic');
    showOnly(lobbyScreen);
  });

  // ---- Socket: match ----
  socket.on('match:start', (d) => {
    world = d.world;
    inGame = true;
    prevSelf = null;
    prevTileState = new Map();
    floaters.length = 0; particles.length = 0; flashes.length = 0;
    shakeMag = 0;
    showOnly(null);
    hud.classList.remove('hidden');
    levelupScreen.classList.add('hidden');
    if (isTouch) {
      $('joystick').classList.remove('hidden');
      $('actionBtn').classList.remove('hidden');
    }
  });

  socket.on('state', (snap) => {
    snapshot = snap;
    world = snap.world;
    if (!inGame) return;
    detectEvents(snap);
    updateHud(snap);
    const voting = snap.phase === 'voting';
    const decree = snap.phase === 'decree';
    electionScreen.classList.toggle('hidden', !voting);
    vignette.classList.toggle('dramatic', voting || decree);

    // Decree phase: the mayor sees the choice screen (via decree:choose);
    // everyone else (incl. a human when a bot is mayor) sees a waiting overlay.
    // Movement is frozen server-side throughout, so this makes the lock visible.
    const iAmMayor = snap.mayorId === selfId;
    if (decree && !iAmMayor) {
      const mayor = snap.players.find((p) => p.id === snap.mayorId);
      $('decreeWaitText').textContent =
        `👑 ${mayor ? mayor.name : 'O Prefeito'} está escolhendo o decreto...`;
      decreeWaitScreen.classList.remove('hidden');
    } else {
      decreeWaitScreen.classList.add('hidden');
    }
  });

  socket.on('election:start', (data) => {
    Sound.election();
    $('electionTitle').textContent = `Eleição #${data.electionNumber}`;
    renderCandidates(data.candidates);
    $('voteStatus').textContent = '';
    electionScreen.classList.remove('hidden');
    vignette.classList.add('dramatic');
  });

  socket.on('election:result', (data) => {
    flash(`👑 ${data.mayorName} foi eleito(a) Prefeito(a)!`);
    electionScreen.classList.add('hidden');
  });

  socket.on('decree:choose', (data) => {
    renderDecreeOptions(data.options);
    decreeScreen.classList.remove('hidden');
    let left = Math.ceil(data.duration / 1000);
    const el = $('decreeTimer');
    el.textContent = String(left);
    const iv = setInterval(() => {
      left -= 1;
      el.textContent = String(Math.max(0, left));
      el.classList.toggle('urgent', left <= 3);
      if (left <= 0 || decreeScreen.classList.contains('hidden')) clearInterval(iv);
    }, 1000);
  });

  socket.on('decree:active', (data) => {
    decreeScreen.classList.add('hidden');
    showDecreeAnnounce(data);
  });

  socket.on('level:up', (data) => {
    renderUpgrades(data.level, data.choices);
    levelupScreen.classList.remove('hidden');
  });

  socket.on('game:end', (data) => {
    Sound.victory();
    renderEndScreen(data);
  });

  // ---- Keyboard input ----
  window.addEventListener('keydown', (e) => {
    switch (e.key.toLowerCase()) {
      case 'w': case 'arrowup': keys.up = true; break;
      case 's': case 'arrowdown': keys.down = true; break;
      case 'a': case 'arrowleft': keys.left = true; break;
      case 'd': case 'arrowright': keys.right = true; break;
      case 'e': sendAction(); break;
      default: return;
    }
  });
  window.addEventListener('keyup', (e) => {
    switch (e.key.toLowerCase()) {
      case 'w': case 'arrowup': keys.up = false; break;
      case 's': case 'arrowdown': keys.down = false; break;
      case 'a': case 'arrowleft': keys.left = false; break;
      case 'd': case 'arrowright': keys.right = false; break;
    }
  });

  canvas.addEventListener('click', () => { if (inGame && !isTouch) sendAction(); });
  $('abilitySlot').addEventListener('click', sendAction);

  function sendAction() {
    if (!inGame) return;
    Sound.resume();
    socket.emit('action');
  }

  $('actionBtn').addEventListener('touchstart', (e) => { e.preventDefault(); sendAction(); }, { passive: false });
  $('actionBtn').addEventListener('click', sendAction);

  // ---- Virtual joystick ----
  const joyBase = $('joyBase');
  const joyKnob = $('joyKnob');
  let joyActive = false;
  let joyCenter = { x: 0, y: 0 };
  const JOY_MAX = 48;
  function joyStart(e) {
    joyActive = true;
    const rect = joyBase.getBoundingClientRect();
    joyCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    joyMove(e);
  }
  function joyMove(e) {
    if (!joyActive) return;
    const t = e.touches ? e.touches[0] : e;
    let dx = t.clientX - joyCenter.x;
    let dy = t.clientY - joyCenter.y;
    const len = Math.hypot(dx, dy);
    if (len > JOY_MAX) { dx = (dx / len) * JOY_MAX; dy = (dy / len) * JOY_MAX; }
    joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    joyVec = { x: dx / JOY_MAX, y: dy / JOY_MAX };
  }
  function joyEnd() {
    joyActive = false;
    joyVec = { x: 0, y: 0 };
    joyKnob.style.transform = 'translate(0,0)';
  }
  joyBase.addEventListener('touchstart', (e) => { e.preventDefault(); joyStart(e); }, { passive: false });
  joyBase.addEventListener('touchmove', (e) => { e.preventDefault(); joyMove(e); }, { passive: false });
  joyBase.addEventListener('touchend', joyEnd);
  joyBase.addEventListener('touchcancel', joyEnd);

  // ---- Send input at a steady rate ----
  setInterval(() => {
    if (!inGame) return;
    let x = 0;
    let y = 0;
    if (isTouch) { x = joyVec.x; y = joyVec.y; }
    else {
      if (keys.left) x -= 1;
      if (keys.right) x += 1;
      if (keys.up) y -= 1;
      if (keys.down) y += 1;
    }
    socket.emit('input', { x, y });
  }, 50);

  // ---- Contextual action computation (DISPLAY ONLY; server authoritative) ----
  function computeAction(me) {
    if (!snapshot || !me) return { type: 'none', text: '' };
    const range = me.range || 130;
    let tile = null;
    let best = range * range;
    for (const t of snapshot.tiles) {
      const d = (t.cx - me.x) ** 2 + (t.cy - me.y) ** 2;
      if (d <= best) { best = d; tile = t; }
    }
    if (!tile) return { type: 'none', text: 'Sem alvo por perto' };
    if (tile.disabled) return { type: 'rep', tile, text: 'REPARAR quarteirão' };
    if (tile.ownerId === null) return { type: 'dom', tile, text: 'DOMINAR quarteirão' };
    if (tile.ownerId !== selfId) {
      const dec = snapshot.decree;
      const owner = snapshot.players.find((p) => p.id === tile.ownerId);
      const oname = owner ? owner.name : 'alguém';
      const immune = (dec && dec.id === 'imunidade' && tile.ownerId === dec.mayorId) || tile.shielded;
      if (immune) return { type: 'none', tile, text: `Protegido (${oname})` };
      return { type: 'sab', tile, target: tile.ownerId, text: `SABOTAR quarteirão de ${oname}` };
    }
    if (snapshot.crisis) return { type: 'rep', tile, text: 'REPARAR sua área' };
    return { type: 'none', tile, text: 'Seu quarteirão' };
  }

  function applyActionUI(act) {
    const meta = ACT[act.type] || ACT.none;
    // pill
    const pill = $('actionHint');
    pill.classList.remove('hidden');
    pill.className = meta.cls;
    const dot = $('actionHintDot');
    dot.style.background = meta.color;
    dot.style.color = meta.color;
    $('actionHintText').textContent = act.text || meta.verb;
    // desktop slot
    const slot = $('abilitySlot');
    slot.classList.remove('act-dom', 'act-sab', 'act-rep', 'act-none');
    slot.classList.add(meta.cls);
    $('abVerb').textContent = meta.verb;
    // mobile button
    const btn = $('actionBtn');
    btn.classList.remove('act-dom', 'act-sab', 'act-rep', 'act-none');
    btn.classList.add(meta.cls);
    $('actionBtnLabel').textContent = meta.verb;
  }

  // ---- Juice: detect events from snapshot deltas ----
  function countOwnedTiles(snap, playerId) {
    let n = 0;
    for (const t of snap.tiles) {
      if (t.ownerId === playerId && !t.disabled) n++;
    }
    return n;
  }

  function showScoreToast(msg, color) {
    const stack = $('toastStack');
    const el = document.createElement('div');
    el.className = 'score-toast';
    el.style.borderColor = color || '#2ee6d6';
    el.textContent = msg;
    stack.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 280);
    }, 2200);
    while (stack.children.length > 4) stack.firstChild.remove();
  }

  function detectEvents(snap) {
    const me = snap.players.find((p) => p.id === selfId);
    const newClaims = [];
    const repairedTiles = [];
    const sabbedTiles = [];

    for (const t of snap.tiles) {
      const prev = prevTileState.get(t.id);
      if (prev !== undefined) {
        if (prev.ownerId !== t.ownerId) {
          if (t.ownerId === selfId) newClaims.push(t);
          if (prev.ownerId === selfId && t.ownerId !== selfId) {
            shake(9);
            Sound.hit();
            addFloater(t.cx, t.cy, 'SABOTADO!', ACT.sab.color);
          }
          if (t.ownerId) {
            const owner = snap.players.find((p) => p.id === t.ownerId);
            flashes.push({ cx: t.cx, cy: t.cy, ttl: 0.5, max: 0.5, color: owner ? owner.color : '#fff' });
          }
        }
        if (prev.disabled && !t.disabled) repairedTiles.push(t);
        if (prev.ownerId && !t.ownerId && t.disabled && !prev.disabled) sabbedTiles.push(t);
      }
      prevTileState.set(t.id, { ownerId: t.ownerId, disabled: t.disabled });
    }

    if (me && prevSelf) {
      const dBuilt = me.built - prevSelf.built;
      const dHack = me.hacked - prevSelf.hacked;
      const dRep = me.repaired - prevSelf.repaired;
      const dScoreR = Math.round(me.score) - Math.round(prevSelf.score);

      if (dBuilt > 0) {
        Sound.dominar();
        const targets = newClaims.length ? newClaims : (currentAction.tile ? [currentAction.tile] : []);
        for (let i = 0; i < dBuilt; i++) {
          const tile = targets[i] || targets[0];
          if (!tile) continue;
          burst(tile.cx, tile.cy, ACT.dom.color, 12);
          const label = `+${SCORE.DOMINATE} DOMINAR`;
          addFloater(tile.cx, tile.cy - 20, label, ACT.dom.color);
          showScoreToast(label, ACT.dom.color);
        }
      }

      if (dHack > 0) {
        Sound.sabotar();
        shake(7);
        const tile = sabbedTiles[0] || currentAction.tile;
        if (tile) {
          burst(tile.cx, tile.cy, ACT.sab.color, 16);
          const stolen = Math.max(0, dScoreR - SCORE.SABOTAGE);
          const sabLabel = `+${SCORE.SABOTAGE} SABOTAR`;
          addFloater(tile.cx, tile.cy - 20, sabLabel, ACT.sab.color);
          showScoreToast(sabLabel, ACT.sab.color);
          if (stolen > 0) {
            const stealLabel = `+${stolen} ROUBO`;
            addFloater(tile.cx, tile.cy - 44, stealLabel, ACT.sab.color);
            showScoreToast(stealLabel, ACT.sab.color);
          }
        }
      }

      if (dRep > 0) {
        Sound.reparar();
        const tile = repairedTiles[0] || currentAction.tile;
        const pts = dScoreR >= SCORE.REPAIR - 1 ? SCORE.REPAIR : SCORE.REPAIR_CRISIS;
        if (tile) {
          burst(tile.cx, tile.cy, ACT.rep.color, 12);
          const label = `+${pts} REPARAR`;
          addFloater(tile.cx, tile.cy - 20, label, ACT.rep.color);
          showScoreToast(label, ACT.rep.color);
        }
      }

      // Resource pickup only — passive trickle never spawns floaters (fixes player trail).
      if (dBuilt === 0 && dHack === 0 && dRep === 0 && dScoreR > 0) {
        const mult = snap.decree && snap.decree.id === 'renda' ? 2 : 1;
        const expected = SCORE.RESOURCE * mult;
        if (dScoreR === expected) {
          Sound.collect();
          const label = `+${expected} COLETA`;
          addFloater(me.x, me.y - 24, label, '#2ee6d6');
          showScoreToast(label, '#2ee6d6');
        }
      }

      prevSelf = { score: me.score, built: me.built, hacked: me.hacked, repaired: me.repaired };
    } else if (me) {
      prevSelf = { score: me.score, built: me.built, hacked: me.hacked, repaired: me.repaired };
    }
  }

  function addFloater(x, y, text, color) {
    floaters.push({ x, y, vy: -34, text, color, ttl: 1.1, max: 1.1 });
    if (floaters.length > 60) floaters.shift();
  }
  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 130;
      particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, ttl: 0.6, max: 0.6, color, size: 2 + Math.random() * 3 });
    }
    if (particles.length > 400) particles.splice(0, particles.length - 400);
  }
  function shake(mag) { shakeMag = Math.min(16, shakeMag + mag); }

  // ---- HUD ----
  function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function updateHud(snap) {
    const now = snap.now;
    $('clock').textContent = fmtClock(snap.matchEndsAt - now);

    const next = $('nextEvent');
    if (snap.phase === 'voting') next.textContent = '🗳️ Votação!';
    else if (snap.phase === 'decree') next.textContent = '👑 Prefeito decide...';
    else if (snap.phase === 'ended') next.textContent = 'Fim';
    else next.textContent = `Eleição em ${fmtClock(snap.nextElectionAt - now)}`;

    const me = snap.players.find((p) => p.id === selfId);
    if (me) {
      const owned = countOwnedTiles(snap, selfId);
      const passiveRate = owned * SCORE.TRICKLE_PER_TILE;
      $('scoreMain').textContent = `${Math.round(me.score)} pts`;
      $('passiveIncome').textContent = owned > 0
        ? `Renda passiva: +${passiveRate}/s · ${owned} quarteirão${owned === 1 ? '' : 's'}`
        : 'Renda passiva: domine quarteirões (+2/s cada)';
      $('myStats').textContent =
        `${me.identity} · 🏗️${me.built} ⚔️${me.hacked} 🔧${me.repaired}`;
      renderScoreBreakdown(snap, owned, passiveRate);
      $('levelNum').textContent = `Nv. ${me.level}`;
      const pct = me.xpToNext ? Math.min(100, (me.xp / me.xpToNext) * 100) : 0;
      $('xpFill').style.width = `${pct}%`;
      updateCooldown(me);
      currentAction = computeAction(me);
      applyActionUI(currentAction);
    }

    renderLeaderboard(snap.players);

    if (snap.crisis) {
      banner.textContent = '⚡ APAGÃO! Quarteirões livres desabilitados — REPARE para pontuar.';
      banner.classList.remove('hidden');
    } else if (snap.decree) {
      banner.textContent = `📜 Decreto ativo: ${snap.decree.name}`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  function renderScoreBreakdown(snap, owned, passiveRate) {
    const panel = $('scoreBreakdown');
    panel.textContent = '';
    const rendaMult = snap.decree && snap.decree.id === 'renda' ? 2 : 1;
    const lines = [
      `Coleta (recurso): +${SCORE.RESOURCE * rendaMult} pts`,
      `Dominar quarteirão: +${SCORE.DOMINATE} pts`,
      `Sabotar quarteirão: +${SCORE.SABOTAGE} pts (+ roubo com upgrade)`,
      `Reparar quarteirão: +${SCORE.REPAIR} pts (+${SCORE.REPAIR_CRISIS} na crise própria)`,
      `Renda passiva: +${SCORE.TRICKLE_PER_TILE}/s por quarteirão dominado (agora +${passiveRate}/s)`,
    ];
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = 'sb-row';
      row.textContent = line;
      panel.appendChild(row);
    }
  }

  function updateCooldown(me) {
    const total = me.cooldownTotal || 4000;
    const cd = me.cooldown || 0;
    const pct = Math.max(0, Math.min(100, (cd / total) * 100));
    const secs = Math.ceil(cd / 1000);
    const slotCd = $('abCd');
    const btnCd = $('actionBtnCd');
    if (cd > 0) {
      slotCd.classList.remove('hidden');
      slotCd.textContent = String(secs);
      slotCd.style.setProperty('--cd', `${pct}%`);
      btnCd.classList.remove('hidden');
      btnCd.textContent = String(secs);
      btnCd.style.setProperty('--cd', `${pct}%`);
    } else {
      slotCd.classList.add('hidden');
      btnCd.classList.add('hidden');
    }
  }

  function renderLeaderboard(players) {
    const board = $('leaderboard');
    board.textContent = '';
    const title = document.createElement('div');
    title.className = 'lb-title';
    title.textContent = 'Ranking';
    board.appendChild(title);

    const sorted = [...players].sort((a, b) => b.score - a.score).slice(0, 8);
    sorted.forEach((p, i) => {
      const item = document.createElement('div');
      item.className = 'lb-item';

      const row = document.createElement('div');
      row.className = 'lb-row' + (p.id === selfId ? ' me' : '');
      const isMayor = snapshot && snapshot.mayorId === p.id;

      const rank = document.createElement('span');
      rank.className = 'lb-rank';
      rank.textContent = `${i + 1}`;
      row.appendChild(rank);

      const name = document.createElement('span');
      name.className = 'lb-name';
      name.textContent = (isMayor ? '👑 ' : '') + p.name;
      row.appendChild(name);

      const score = document.createElement('span');
      score.className = 'lb-score';
      score.textContent = String(Math.round(p.score));
      row.appendChild(score);

      item.appendChild(row);

      const rep = document.createElement('div');
      rep.className = 'lb-rep';
      rep.textContent = `${p.identity} · nv.${p.level}`;
      item.appendChild(rep);

      board.appendChild(item);
    });
  }

  // ---- Election rendering ----
  function renderCandidates(candidates) {
    const wrap = $('candidates');
    wrap.textContent = '';
    candidates.forEach((c, i) => {
      const btn = document.createElement('button');
      btn.className = 'choice';
      btn.type = 'button';

      const name = document.createElement('span');
      const lead = i === 0 ? '★ ' : '';
      name.textContent = lead + c.name + (c.id === selfId ? ' (você)' : '');
      btn.appendChild(name);

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${c.score} pts · ${c.identity} nv.${c.level} · 🏗️${c.built} ⚔️${c.hacked} 🔧${c.repaired}`;
      btn.appendChild(meta);

      btn.addEventListener('click', () => {
        socket.emit('vote', { candidateId: c.id });
        $('voteStatus').textContent = '✅ Voto registrado. Aguardando apuração...';
        Array.from(wrap.children).forEach((el) => el.classList.remove('selected'));
        btn.classList.add('selected');
      });
      wrap.appendChild(btn);
    });
  }

  // ---- Decree rendering ----
  function renderDecreeOptions(options) {
    const wrap = $('decreeOptions');
    wrap.textContent = '';
    let chosen = false;
    for (const d of options) {
      const btn = document.createElement('button');
      btn.className = 'choice';
      btn.type = 'button';
      const name = document.createElement('span');
      name.textContent = d.name;
      btn.appendChild(name);
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = d.desc;
      btn.appendChild(meta);
      btn.addEventListener('click', () => {
        if (chosen) return;
        chosen = true;
        socket.emit('decree', { decreeId: d.id });
        Array.from(wrap.children).forEach((el) => el.classList.remove('selected'));
        btn.classList.add('selected');
        decreeScreen.classList.add('hidden');
      });
      wrap.appendChild(btn);
    }
  }

  // ---- Upgrade rendering ----
  function renderUpgrades(level, choices) {
    $('levelupTitle').textContent = `⬆️ Nível ${level}!`;
    const wrap = $('upgradeOptions');
    wrap.textContent = '';
    let chosen = false;
    for (const u of choices) {
      const btn = document.createElement('button');
      btn.className = 'choice';
      btn.type = 'button';
      const name = document.createElement('span');
      name.textContent = u.name;
      btn.appendChild(name);
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = u.desc;
      btn.appendChild(meta);
      btn.addEventListener('click', () => {
        if (chosen) return;
        chosen = true;
        socket.emit('upgrade:pick', { upgradeId: u.id });
        levelupScreen.classList.add('hidden');
      });
      wrap.appendChild(btn);
    }
  }

  // ---- Decree full-screen announcement ----
  function showDecreeAnnounce(data) {
    Sound.decree();
    shake(6);
    const el = $('decreeAnnounce');
    $('daText').textContent = `${data.mayorName} decretou ${data.name}`;
    $('daDesc').textContent = data.desc || '';
    el.classList.remove('hidden');
    clearTimeout(showDecreeAnnounce._t);
    showDecreeAnnounce._t = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  // ---- Election / decree timer (drives the visible countdown) ----
  setInterval(() => {
    if (snapshot && snapshot.phase === 'voting') {
      const left = Math.max(0, snapshot.phaseEndsAt - Date.now());
      const el = $('electionTimer');
      el.textContent = `${Math.ceil(left / 1000)}`;
      el.classList.toggle('urgent', left <= 5000);
    }
  }, 200);

  // ---- End screen (shareable artifact) ----
  function renderEndScreen(data) {
    electionScreen.classList.add('hidden');
    decreeScreen.classList.add('hidden');
    decreeWaitScreen.classList.add('hidden');
    levelupScreen.classList.add('hidden');
    $('decreeAnnounce').classList.add('hidden');

    const ranking = $('finalRanking');
    ranking.textContent = '';
    for (const p of data.podium) {
      const row = document.createElement('div');
      row.className = 'fr-row' + (p.rank === 1 ? ' gold' : '') + (p.id === selfId ? ' me' : '');

      const left = document.createElement('div');
      const nameLine = document.createElement('div');
      const rankSpan = document.createElement('span');
      rankSpan.className = 'fr-rank';
      rankSpan.textContent = `${p.rank}º `;
      const nameSpan = document.createElement('span');
      nameSpan.className = 'fr-name';
      nameSpan.textContent = `${p.name}${p.isBot ? ' (bot)' : ''}`;
      nameLine.appendChild(rankSpan);
      nameLine.appendChild(nameSpan);

      const rep = document.createElement('div');
      rep.className = 'fr-rep';
      rep.textContent = `${p.identity} nv.${p.level} · 🏗️${p.built} ⚔️${p.hacked} 🔧${p.repaired}`;
      left.appendChild(nameLine);
      left.appendChild(rep);

      const score = document.createElement('div');
      score.className = 'fr-score';
      score.textContent = `${p.score} pts`;

      row.appendChild(left);
      row.appendChild(score);
      ranking.appendChild(row);
    }

    $('story').textContent = data.story; // safe
    $('shareStatus').textContent = '';
    $('restartNote').textContent = solo
      ? 'Uma nova partida solo começa automaticamente...'
      : 'Voltando para a sala de espera em instantes...';
    endScreen.classList.remove('hidden');
    $('shareBtn').onclick = () => shareStory(data.story);
  }

  function shareStory(text) {
    const full = `${text}\n\n— jogue CIDADE.io`;
    copyText(full,
      () => { $('shareStatus').textContent = 'Copiado! Cole onde quiser.'; },
      () => { $('shareStatus').textContent = 'Não foi possível copiar.'; });
  }

  function copyText(text, done, fail) {
    done = done || (() => {});
    fail = fail || (() => {});
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done, fail));
    } else {
      fallbackCopy(text, done, fail);
    }
  }

  function fallbackCopy(text, done, fail) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) { fail(); }
  }

  function flash(msg) {
    resultFlash.textContent = msg;
    resultFlash.classList.remove('hidden');
    clearTimeout(flash._t);
    flash._t = setTimeout(() => resultFlash.classList.add('hidden'), 3000);
  }

  // ---- Rendering loop ----
  let lastT = performance.now();
  function draw(t) {
    requestAnimationFrame(draw);
    const dt = Math.min(0.05, (t - lastT) / 1000) || 0;
    lastT = t;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!snapshot || !inGame) return;

    const me = snapshot.players.find((p) => p.id === selfId);
    let baseX, baseY;
    if (me) { baseX = me.x - canvas.width / 2; baseY = me.y - canvas.height / 2; }
    else { baseX = world.w / 2 - canvas.width / 2; baseY = world.h / 2 - canvas.height / 2; }
    baseX = Math.max(0, Math.min(baseX, world.w - canvas.width));
    baseY = Math.max(0, Math.min(baseY, world.h - canvas.height));
    if (world.w < canvas.width) baseX = (world.w - canvas.width) / 2;
    if (world.h < canvas.height) baseY = (world.h - canvas.height) / 2;

    // screen shake
    if (shakeMag > 0.1) {
      baseX += (Math.random() - 0.5) * shakeMag;
      baseY += (Math.random() - 0.5) * shakeMag;
      shakeMag *= 0.86;
    } else shakeMag = 0;
    camera.x = baseX; camera.y = baseY;

    drawGridBackground();
    drawTiles();
    drawResources();
    if (me) drawRange(me);
    drawFlashes(dt);
    drawPlayers();
    drawParticles(dt);
    drawFloaters(dt);
    drawMinimap();
  }

  function w2sx(x) { return x - camera.x; }
  function w2sy(y) { return y - camera.y; }

  function drawGridBackground() {
    ctx.fillStyle = '#0a0b10';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 1;
    const step = 100;
    const ox = -camera.x % step;
    const oy = -camera.y % step;
    for (let x = ox; x < canvas.width; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = oy; y < canvas.height; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(46,230,214,0.35)';
    ctx.lineWidth = 3;
    ctx.strokeRect(w2sx(0), w2sy(0), world.w, world.h);
  }

  function colorForOwner(ownerId) {
    if (!snapshot) return '#888';
    const p = snapshot.players.find((pp) => pp.id === ownerId);
    return p ? p.color : '#888';
  }

  function drawTiles() {
    const d = world.tileDraw;
    const targetId = currentAction && currentAction.tile ? currentAction.tile.id : null;
    const targetColor = (ACT[currentAction.type] || ACT.none).color;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
    for (const t of snapshot.tiles) {
      const sx = w2sx(t.cx) - d / 2;
      const sy = w2sy(t.cy) - d / 2;
      if (sx > canvas.width || sy > canvas.height || sx + d < 0 || sy + d < 0) continue;

      if (t.disabled) {
        ctx.fillStyle = 'rgba(255,61,129,0.16)';
        ctx.strokeStyle = 'rgba(255,61,129,0.8)';
      } else if (t.ownerId) {
        const c = colorForOwner(t.ownerId);
        ctx.fillStyle = c.replace('hsl', 'hsla').replace(')', ', 0.22)');
        ctx.strokeStyle = c;
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.035)';
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      }
      ctx.lineWidth = 2;
      ctx.fillRect(sx, sy, d, d);
      ctx.strokeRect(sx, sy, d, d);

      if (t.shielded) {
        ctx.strokeStyle = 'rgba(46,230,214,0.9)';
        ctx.lineWidth = 3;
        ctx.strokeRect(sx + 3, sy + 3, d - 6, d - 6);
      }
      if (t.disabled) {
        ctx.fillStyle = 'rgba(255,61,129,0.9)';
        ctx.font = `14px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText('⚠', w2sx(t.cx), w2sy(t.cy) + 5);
      }

      // highlight the contextual target tile
      if (t.id === targetId && currentAction.type !== 'none') {
        ctx.save();
        ctx.strokeStyle = targetColor;
        ctx.globalAlpha = 0.5 + 0.5 * pulse;
        ctx.lineWidth = 4;
        const pad = 4 + pulse * 4;
        ctx.strokeRect(sx - pad, sy - pad, d + pad * 2, d + pad * 2);
        ctx.restore();
      }
    }
  }

  function drawResources() {
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 250);
    for (const r of snapshot.resources) {
      const sx = w2sx(r.x);
      const sy = w2sy(r.y);
      if (sx < -20 || sy < -20 || sx > canvas.width + 20 || sy > canvas.height + 20) continue;
      ctx.save();
      ctx.shadowColor = 'rgba(245,230,66,0.7)';
      ctx.shadowBlur = 10 * pulse;
      ctx.beginPath();
      ctx.arc(sx, sy, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#f5e642';
      ctx.fill();
      ctx.restore();
    }
  }

  function drawRange(me) {
    const meta = ACT[currentAction.type] || ACT.none;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 280);
    ctx.save();
    ctx.beginPath();
    ctx.arc(w2sx(me.x), w2sy(me.y), me.range || 130, 0, Math.PI * 2);
    ctx.strokeStyle = meta.color;
    ctx.globalAlpha = 0.12 + 0.14 * pulse;
    ctx.lineWidth = 2 + pulse * 1.5;
    ctx.stroke();
    ctx.restore();
  }

  function drawFlashes(dt) {
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      f.ttl -= dt;
      if (f.ttl <= 0) { flashes.splice(i, 1); continue; }
      const k = f.ttl / f.max;
      const d = world.tileDraw;
      ctx.save();
      ctx.globalAlpha = k * 0.8;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 3;
      const grow = (1 - k) * 18;
      ctx.strokeRect(w2sx(f.cx) - d / 2 - grow, w2sy(f.cy) - d / 2 - grow, d + grow * 2, d + grow * 2);
      ctx.restore();
    }
  }

  function drawParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.ttl -= dt;
      if (p.ttl <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.92; p.vy *= 0.92;
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.ttl / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(w2sx(p.x), w2sy(p.y), p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawFloaters(dt) {
    ctx.textAlign = 'center';
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.ttl -= dt;
      if (f.ttl <= 0) { floaters.splice(i, 1); continue; }
      f.y += f.vy * dt;
      const k = f.ttl / f.max;
      ctx.save();
      ctx.globalAlpha = Math.min(1, k * 1.4);
      ctx.fillStyle = f.color;
      ctx.font = `bold 18px ${MONO}`;
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 4;
      ctx.fillText(f.text, w2sx(f.x), w2sy(f.y));
      ctx.restore();
    }
  }

  function drawPlayers() {
    ctx.textAlign = 'center';
    for (const p of snapshot.players) {
      const sx = w2sx(p.x);
      const sy = w2sy(p.y);
      if (sx < -50 || sy < -50 || sx > canvas.width + 50 || sy > canvas.height + 50) continue;

      // sabotage-target ring on the owner being targeted
      if (currentAction.type === 'sab' && currentAction.target === p.id) {
        ctx.save();
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 160);
        ctx.strokeStyle = ACT.sab.color;
        ctx.globalAlpha = 0.5 + 0.5 * pulse;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(sx, sy, 26 + pulse * 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      if (p.id === selfId) { ctx.shadowColor = p.color; ctx.shadowBlur = 16; }
      ctx.beginPath();
      ctx.arc(sx, sy, 18, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.restore();
      ctx.lineWidth = p.id === selfId ? 4 : 2;
      ctx.strokeStyle = p.id === selfId ? '#fff' : 'rgba(0,0,0,0.4)';
      ctx.stroke();

      if (snapshot.mayorId === p.id) {
        ctx.fillStyle = '#f5e642';
        ctx.font = `18px ${FONT}`;
        ctx.fillText('👑', sx, sy - 40);
      }

      ctx.fillStyle = '#fff';
      ctx.font = `bold 13px ${FONT}`;
      ctx.fillText(p.name, sx, sy - 24);

      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.font = `11px ${FONT}`;
      ctx.fillText(`${p.phrase} · nv.${p.level}`, sx, sy + 34);
    }
  }

  function drawMinimap() {
    if (canvas.width < 620) return; // keep phones uncluttered (leaderboard is enough)
    const mw = 150;
    const mh = (mw * world.h) / world.w;
    const mx = canvas.width - mw - 12;
    const my = canvas.height - mh - 12;
    ctx.fillStyle = 'rgba(8,10,18,0.7)';
    ctx.fillRect(mx, my, mw, mh);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.strokeRect(mx, my, mw, mh);
    for (const p of snapshot.players) {
      ctx.beginPath();
      ctx.arc(mx + (p.x / world.w) * mw, my + (p.y / world.h) * mh, p.id === selfId ? 3 : 2, 0, Math.PI * 2);
      ctx.fillStyle = p.id === selfId ? '#fff' : p.color;
      ctx.fill();
    }
  }

  requestAnimationFrame(draw);
})();
