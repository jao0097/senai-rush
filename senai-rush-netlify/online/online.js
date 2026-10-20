// SENAI Rush online multiplayer client.
//
// Lives outside the hashed Vite bundles on purpose: it drives the game through
// `window.__game` (exposed by index-*.js) and patches the Game prototype at
// runtime, so the compiled chunks stay untouched.
//
// Flow: Online button -> create lobby (4-digit code) / join by code -> host
// clicks "Começar" -> 60 s to pick a character and vote a track -> everyone
// races the winning track. Each client simulates its own kart and streams its
// pose; remote karts are puppets that follow the stream. The host also streams
// the AI karts so everyone sees the same field.

const params = new URLSearchParams(location.search);
// Set window.SENAI_RUSH_SERVER (or ?server=wss://...) when the game is hosted
// somewhere other than the online server (e.g. static build on Netlify).
const SERVER_URL =
  params.get('server') ||
  window.SENAI_RUSH_SERVER ||
  (location.protocol.startsWith('http')
    ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    : '');
const SEND_HZ = 20;
const INTERP_MS = 110; // render remote karts this far in the past
const EXTRAPOLATE_MS = 250;
const SNAP_DIST = 8;
const NAME_KEY = 'senai-rush-online-name';

const $ = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const state = {
  ws: null,
  connecting: false,
  you: null,
  room: null,
  error: '',
  open: false,
  ping: 0,
  // race in progress on this client (set when the server reveals the track)
  net: null,
  pendingSpawn: null,
  raceSeed: null,
  afterRace: false,
};

// ---------------------------------------------------------------- boot

function waitForGame() {
  return new Promise((done) => {
    const tick = () => {
      const g = window.__game;
      if (g?.game && g.ui?.actions && g.ui.portraits?.size) done(g);
      else setTimeout(tick, 200);
    };
    tick();
  });
}

let G; // window.__game
const root = document.createElement('div');
root.id = 'online';
const chip = document.createElement('div');
chip.id = 'online-chip';

waitForGame().then((g) => {
  G = g;
  document.body.append(root, chip);
  addTitleButton();
  patchGame();
  patchActions();
  installKeyGuard();
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onFieldKey);
  setInterval(sendPose, 1000 / SEND_HZ);
  setInterval(tickTimer, 250);
  setInterval(() => send({ t: 'time', c: performance.now() }), 3000);
  if (/^\d{4}$/.test(params.get('lobby') || '')) {
    openOverlay();
    join(params.get('lobby'));
  }
});

function addTitleButton() {
  const nav = document.querySelector('.screen-title nav.menu');
  if (!nav || nav.querySelector('[data-online]')) return;
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.dataset.nav = '';
  btn.dataset.online = '';
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/></svg><span>Online</span>`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openOverlay();
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopImmediatePropagation();
      openOverlay();
    }
  });
  const race = nav.querySelector('[data-act="race"]');
  race ? race.after(btn) : nav.prepend(btn);
}

// Menus listen on window; while the overlay is up, keys belong to it.
function installKeyGuard() {
  const guard = (e) => {
    if (!state.open) return;
    if (e.type === 'keydown' && e.key === 'Escape') back();
    e.stopImmediatePropagation();
  };
  window.addEventListener('keydown', guard, true);
  window.addEventListener('keyup', guard, true);
}

// ---------------------------------------------------------------- data from the game

function characters() {
  return [...G.ui.portraits.keys()].map((id) => ({
    id,
    name: G.ui.t(`char.${id}.name`),
    img: G.ui.portraits.get(id),
  }));
}

function tracks() {
  const cards = document.querySelectorAll('.screen-tracks [data-track-cards] .track-card');
  return [...cards].map((c) => ({
    id: c.dataset.id,
    name: c.querySelector('.track-name')?.textContent || c.dataset.id,
    thumb: c.querySelector('.track-thumb')?.innerHTML || '',
  }));
}

const charById = (id) => characters().find((c) => c.id === id);
const trackById = (id) => tracks().find((t) => t.id === id);

// ---------------------------------------------------------------- network

function connect() {
  if (state.ws && state.ws.readyState <= 1) return Promise.resolve();
  if (!SERVER_URL) {
    state.error = 'Online precisa do jogo aberto pelo servidor (não funciona por arquivo).';
    render();
    return Promise.reject(new Error('no server'));
  }
  state.connecting = true;
  render();
  return new Promise((ok, fail) => {
    const ws = new WebSocket(SERVER_URL);
    state.ws = ws;
    ws.onopen = () => {
      state.connecting = false;
      state.error = '';
      ok();
    };
    ws.onerror = () => {
      state.connecting = false;
      state.error = 'Não deu pra conectar no servidor online.';
      render();
      fail(new Error('ws error'));
    };
    ws.onclose = () => {
      if (state.ws !== ws) return;
      state.ws = null;
      const wasIn = !!state.room;
      state.room = null;
      state.you = null;
      if (wasIn) state.error = 'Conexão com o servidor caiu.';
      if (state.net) endNetRace();
      render();
    };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  });
}

function send(msg) {
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(msg));
}

function playerName() {
  return (localStorage.getItem(NAME_KEY) || '').trim();
}

async function create() {
  await connect();
  send({
    t: 'create',
    name: playerName(),
    chars: characters().map((c) => c.id),
    tracks: tracks().map((t) => t.id),
  });
}

async function join(code) {
  if (!/^\d{4}$/.test(code)) {
    state.error = 'O código tem 4 números.';
    return render();
  }
  await connect();
  send({ t: 'join', code, name: playerName() });
}

function onMessage(m) {
  switch (m.t) {
    case 'joined':
      state.you = m.you;
      state.error = '';
      break;
    case 'error':
      state.error = m.msg;
      render();
      break;
    case 'room':
      onRoom(m.room);
      break;
    case 'time':
      state.ping = Math.round(performance.now() - m.c);
      updateChip();
      break;
    case 's':
      pushSample(`p${m.from}`, m.from, m.ts, m.k);
      break;
    case 'a':
      for (const k of m.k) pushSample(`ai${k[0]}`, m.from, m.ts, k.slice(1));
      break;
    case 'hit':
      applyRemoteHit(m);
      break;
    case 'abort':
      if (state.net) leaveRace();
      break;
  }
}

function onRoom(room) {
  const prev = state.room;
  state.room = room;
  if (room.phase === 'reveal' && room.race && state.raceSeed !== room.race.seed) {
    state.raceSeed = room.race.seed;
    if (room.race.order.some((o) => o.id === state.you)) beginRace(room.race);
  }
  if (room.phase === 'lobby' && prev?.phase !== 'lobby') state.afterRace = false;
  // race screens are the game's own; the overlay comes back afterwards
  if (!state.net) openOverlay(false);
  render();
}

// ---------------------------------------------------------------- overlay UI

function openOverlay(focus = true) {
  state.open = true;
  document.body.classList.add('online-open');
  render();
  if (focus) root.querySelector('input, button')?.focus({ preventScroll: true });
}

function closeOverlay() {
  state.open = false;
  document.body.classList.remove('online-open');
}

function back() {
  if (state.room && state.room.phase === 'select') return; // no backing out mid-pick by accident
  if (state.room) return leaveRoom();
  closeOverlay();
  G.ui.show('title');
  document.querySelector('.screen-title [data-online]')?.focus({ preventScroll: true });
}

function leaveRoom() {
  send({ t: 'leave' });
  state.room = null;
  state.you = null;
  state.ws?.close();
  state.ws = null;
  render();
}

let lastHtml = '';
function render() {
  if (!G) return;
  const html = state.room ? roomHtml(state.room) : menuHtml();
  if (html === lastHtml) return;
  // keep focus on the same control across re-renders
  const focused = document.activeElement?.closest?.('#online [data-k]')?.dataset.k;
  root.innerHTML = html;
  lastHtml = html;
  if (focused) root.querySelector(`[data-k="${focused}"]`)?.focus({ preventScroll: true });
  tickTimer();
}

function menuHtml() {
  return `<div class="on-panel">
    <div class="on-row" style="justify-content:space-between">
      <h2>Corrida Online</h2>
      <button class="btn" data-a="close" data-k="close">Voltar</button>
    </div>
    <div class="on-box on-col">
      <h3>Seu nome</h3>
      <div class="on-row"><input class="on-input on-name" data-f="name" data-k="name" maxlength="14" placeholder="Piloto" value="${$(playerName())}"></div>
    </div>
    <div class="on-split">
      <div class="on-box on-col">
        <h3>Criar lobby</h3>
        <p class="on-muted">Gera um código de 4 números pra mandar pros amigos.</p>
        <div><button class="btn btn-primary btn-big" data-a="create" data-k="create" ${state.connecting ? 'disabled' : ''}>Criar lobby</button></div>
      </div>
      <div class="on-box on-col">
        <h3>Entrar com código</h3>
        <div class="on-row">
          <input class="on-input on-code" data-f="code" data-k="code" inputmode="numeric" maxlength="4" placeholder="0000" autocomplete="off">
          <button class="btn btn-primary" data-a="join" data-k="join" ${state.connecting ? 'disabled' : ''}>Entrar</button>
        </div>
      </div>
    </div>
    <p class="on-err">${$(state.error)}</p>
  </div>`;
}

function playerRow(p, room, extra = '') {
  const c = p.char && charById(p.char);
  const tags = [
    p.id === room.host ? '<span class="on-tag">LÍDER</span>' : '',
    p.id === state.you ? '<span class="on-tag ok">VOCÊ</span>' : '',
    extra,
  ].join('');
  return `<div class="on-player${p.id === state.you ? ' me' : ''}">
    ${c ? `<img src="${c.img}" alt="">` : '<span class="on-av"></span>'}
    <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${$(p.name)}</span>${tags}
  </div>`;
}

function roomHtml(room) {
  const isHost = room.host === state.you;
  if (room.phase === 'select') return selectHtml(room);
  if (room.phase === 'reveal' && room.race) return revealHtml(room);
  const racing = room.phase === 'race';
  const slots = Array.from({ length: 4 - room.players.length }, () => '<div class="on-player" style="opacity:.35"><span class="on-av"></span>Vaga livre</div>').join('');
  return `<div class="on-panel">
    <div class="on-row" style="justify-content:space-between">
      <h2>Lobby</h2>
      <button class="btn" data-a="leave" data-k="leave">Sair</button>
    </div>
    <div class="on-box on-row" style="justify-content:space-between">
      <div class="on-col" style="gap:4px">
        <span class="on-muted">Código do lobby</span>
        <span class="on-bigcode" data-a="copy" title="Copiar">${room.code}</span>
      </div>
      <p class="on-muted" style="max-width:340px">Manda esse código pros amigos. Eles clicam em <b>Online → Entrar com código</b>.</p>
    </div>
    <div class="on-box on-col">
      <h3>Jogadores ${room.players.length}/4</h3>
      <div class="on-players">${room.players.map((p) => playerRow(p, room, racing && p.inRace ? '<span class="on-tag">CORRENDO</span>' : '')).join('')}${slots}</div>
    </div>
    <div class="on-row">
      ${
        racing
          ? `<p class="on-muted">Esperando a corrida terminar pra todo mundo…</p>${isHost ? '<button class="btn" data-a="abort" data-k="abort">Encerrar corrida</button>' : ''}`
          : isHost
            ? `<button class="btn btn-primary btn-big" data-a="start" data-k="start">Começar</button><p class="on-muted">Ao começar, todos têm 1 minuto pra escolher personagem e votar no mapa.</p>`
            : '<p class="on-muted">Esperando o líder começar…</p>'
      }
    </div>
    <p class="on-err">${$(state.error)}</p>
  </div>`;
}

function selectHtml(room) {
  const me = room.players.find((p) => p.id === state.you);
  const takenBy = new Map(room.players.filter((p) => p.char).map((p) => [p.char, p]));
  const votes = new Map();
  for (const p of room.players) if (p.vote) votes.set(p.vote, [...(votes.get(p.vote) || []), p]);
  const chars = characters()
    .map((c) => {
      const who = takenBy.get(c.id);
      const mine = who?.id === state.you;
      return `<button class="on-char${mine ? ' mine' : ''}" data-a="pick" data-id="${c.id}" data-k="c-${c.id}" ${who && !mine ? 'disabled' : ''}>
        ${who ? `<span class="on-who">${$(who.name)}</span>` : ''}
        <img src="${c.img}" alt=""><span>${$(c.name)}</span>
      </button>`;
    })
    .join('');
  const trackCards = tracks()
    .map((t) => {
      const v = votes.get(t.id) || [];
      return `<button class="on-track${me?.vote === t.id ? ' mine' : ''}" data-a="vote" data-id="${t.id}" data-k="t-${t.id}">
        ${v.length ? `<span class="on-votes">${v.map((p) => `<span title="${$(p.name)}">${$(p.name.slice(0, 1).toUpperCase())}</span>`).join('')}</span>` : ''}
        <span class="track-thumb">${t.thumb}</span><span>${$(t.name)}</span>
      </button>`;
    })
    .join('');
  return `<div class="on-panel">
    <div class="on-timer"><h2>Escolha e vote!</h2><span class="on-bar"><i data-bar></i></span><b data-time>60</b></div>
    <div class="on-box on-col">
      <h3>Personagem</h3>
      <div class="on-chars">${chars}</div>
    </div>
    <div class="on-box on-col">
      <h3>Vote no mapa</h3>
      <div class="on-tracks">${trackCards}</div>
    </div>
    <div class="on-row" style="justify-content:space-between">
      <div class="on-row">${room.players.map((p) => `<span class="on-tag${p.ready ? ' ok' : ''}">${$(p.name)}${p.ready ? ' ✓' : ''}</span>`).join('')}</div>
      <button class="btn ${me?.ready ? '' : 'btn-primary'}" data-a="ready" data-k="ready" ${me?.char ? '' : 'disabled'}>${me?.ready ? 'Cancelar' : 'Pronto!'}</button>
    </div>
  </div>`;
}

function revealHtml(room) {
  const t = trackById(room.race.track);
  return `<div class="on-panel on-col on-reveal">
    <span class="on-muted">Mapa escolhido</span>
    <span class="on-trackname">${$(t?.name || room.race.track)}</span>
    <div class="on-players" style="width:100%">${room.race.order.map((o) => playerRow({ ...o }, room)).join('')}</div>
    <p class="on-muted">Preparando a largada…</p>
  </div>`;
}

let selectStartedAt = 0;
let selectRemaining = 0;
function tickTimer() {
  const room = state.room;
  if (!room || room.phase !== 'select') return;
  // server sends remaining ms with each update; count down locally between them
  if (room.remaining !== selectRemaining) {
    selectRemaining = room.remaining;
    selectStartedAt = performance.now();
  }
  const left = Math.max(0, selectRemaining - (performance.now() - selectStartedAt));
  const t = root.querySelector('[data-time]');
  const bar = root.querySelector('[data-bar]');
  if (t) {
    t.textContent = String(Math.ceil(left / 1000));
    t.classList.toggle('low', left < 10_000);
  }
  if (bar) bar.style.width = `${(left / 60_000) * 100}%`;
}

function onInput(e) {
  const f = e.target.dataset.f;
  if (f === 'name') localStorage.setItem(NAME_KEY, e.target.value.trim());
  if (f === 'code') e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
}

function onFieldKey(e) {
  if (e.key !== 'Enter') return;
  if (e.target.dataset.f === 'code') join(e.target.value);
  if (e.target.dataset.f === 'name') root.querySelector('[data-f="code"]')?.focus();
}

function onClick(e) {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const room = state.room;
  const me = room?.players.find((p) => p.id === state.you);
  switch (el.dataset.a) {
    case 'close':
      return back();
    case 'create':
      return create().catch(() => {});
    case 'join':
      return join(root.querySelector('[data-f="code"]').value).catch(() => {});
    case 'leave':
      return leaveRoom();
    case 'copy':
      return navigator.clipboard?.writeText(room.code).catch(() => {});
    case 'start':
      return send({ t: 'start' });
    case 'abort':
      return send({ t: 'abort' });
    case 'pick':
      return send({ t: 'pick', char: el.dataset.id });
    case 'vote':
      return send({ t: 'vote', track: el.dataset.id });
    case 'ready':
      return send({ t: 'ready', ready: !me?.ready });
  }
}

function updateChip() {
  const r = state.room;
  chip.textContent = r ? `ONLINE · ${r.code} · ${r.players.length} jogadores · ${state.ping} ms` : 'ONLINE';
}

// ---------------------------------------------------------------- race

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function beginRace(race) {
  const myIndex = race.order.findIndex((o) => o.id === state.you);
  const myChar = race.order[myIndex].char;
  G.save.update({ tutorialDone: true, character: myChar });
  // builds the Game for this track (no-op if already loaded)
  G.ui.actions.trackChanged(race.track);
  G.game.showSelect(myChar);
  state.net = {
    race,
    myIndex,
    isHost: state.room.host === state.you,
    puppets: new Map(), // key -> racer
    buffers: new Map(), // key -> samples
    clocks: new Map(), // sender id -> clock offset
    finishedSent: false,
    started: false,
  };
  render();
  setTimeout(() => {
    const net = state.net;
    if (!net || net.race !== race) return;
    closeOverlay();
    document.body.classList.add('online-race');
    updateChip();
    state.pendingSpawn = net;
    G.ui.actions.startRace([myChar], []);
    net.started = true;
  }, race.startIn);
}

function endNetRace() {
  state.net = null;
  state.pendingSpawn = null;
  document.body.classList.remove('online-race');
}

// results "again" / "change" / pause "quit": hand the player back to the lobby
function leaveRace() {
  const wasRacing = !!state.net;
  endNetRace();
  send({ t: 'back' });
  G.ui.actions.backToTitle();
  if (wasRacing && state.room) openOverlay();
}

function patchActions() {
  const a = G.ui.actions;
  for (const key of ['again', 'change', 'quit', 'backToTitle', 'restart']) {
    const orig = a[key];
    a[key] = (...args) => {
      if (!state.net) return orig(...args);
      if (key === 'restart') return a.resume(); // can't restart a shared race
      if (key === 'backToTitle') {
        endNetRace();
        send({ t: 'back' });
        orig(...args);
        if (state.room) openOverlay();
        return;
      }
      leaveRace();
    };
  }
}

const charCache = new Map();
const cacheChars = (game) => {
  for (const r of game.racers) charCache.set(r.character.id, r.character);
};

function patchGame() {
  const proto = Object.getPrototypeOf(G.game);
  if (proto.__online) return;
  proto.__online = true;

  const spawn = proto.spawn;
  proto.spawn = function (chars) {
    const net = state.pendingSpawn;
    if (!net) {
      spawn.call(this, chars);
      cacheChars(this);
      return;
    }
    state.pendingSpawn = null;
    for (const c of chars) charCache.set(c.id, c);
    // character objects aren't exported; harvest them from attract-mode grids
    for (let i = 0; i < 40 && net.race.order.some((o) => !charCache.has(o.char)); i += 1) {
      spawn.call(this, []);
      cacheChars(this);
    }
    const grid = net.race.order.map((o) => charCache.get(o.char) ?? chars[0]);
    const random = Math.random;
    Math.random = mulberry32(net.race.seed); // same AI picks on every client
    try {
      spawn.call(this, grid);
    } finally {
      Math.random = random;
    }
    let me;
    for (const r of this.racers) {
      if (r.playerIndex > 0) {
        const o = net.race.order[r.playerIndex - 1];
        if (o.id === state.you) {
          me = r;
          r.playerIndex = 1;
          continue;
        }
        r.isPlayer = false;
        r.playerIndex = 0;
        r.driver = this.playerDriver;
        makePuppet(r, `p${o.id}`, net);
      } else if (!net.isHost) makePuppet(r, `ai${r.id}`, net);
    }
    this.locals = [me];
    this.player = me;
    this.updateStandings();
  };

  const wrapSkip = (name) => {
    const orig = proto[name];
    proto[name] = function (r, ...rest) {
      if (state.net && r?.net) {
        if (name === 'driveAi') r.input = { throttle: 0, brake: 0, steer: 0, drift: false };
        return;
      }
      return orig.call(this, r, ...rest);
    };
  };
  wrapSkip('driveAi');
  wrapSkip('aiItems');
  wrapSkip('startRespawn');

  const skipIntro = proto.skipIntro;
  proto.skipIntro = function () {
    if (!state.net) skipIntro.call(this); // keep everyone's countdown aligned
  };

  // items only exist locally; forward hits on remote karts to their owner
  const onHit = proto.onHit;
  proto.onHit = function (target, source, kind) {
    onHit.call(this, target, source, kind);
    if (!state.net || remoteHit || !target?.net) return;
    const key = target.net.key;
    if (key.startsWith('p')) send({ t: 'hit', to: key.slice(1), kind });
    else send({ t: 'hit', to: 'ai', ai: target.id, kind });
  };
}

let remoteHit = false;
function applyRemoteHit(m) {
  const game = G.game;
  if (!state.net || !game?.racers) return;
  const target = m.to === 'ai' ? game.racers.find((r) => r.id === m.ai && !r.net) : game.player;
  if (!target || target.shielded || target.invincible || target.finished) return;
  target.kart.spinOut(m.kind === 'bolt' ? 0.45 : 0.7, 0.35);
  const source = state.net.puppets.get(`p${m.from}`);
  remoteHit = true;
  try {
    game.onHit(target, source, m.kind);
  } finally {
    remoteHit = false;
  }
}

function makePuppet(racer, key, net) {
  racer.net = { key };
  net.puppets.set(key, racer);
  const k = racer.kart;
  k.step = function (dt) {
    this.prevPosition.copy(this.position);
    this.prevYaw = this.yaw;
    const s = sampleAt(net.buffers.get(key), performance.now() - INTERP_MS);
    if (!s) {
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.intended.set(0, 0, 0);
      return;
    }
    const dx = s[0] - this.position.x;
    const dy = s[1] - this.position.y;
    const dz = s[2] - this.position.z;
    if (Math.hypot(dx, dy, dz) > SNAP_DIST) {
      this.body.setTranslation({ x: s[0], y: s[1], z: s[2] }, true);
      this.position.set(s[0], s[1], s[2]);
      this.prevPosition.copy(this.position);
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.intended.set(0, 0, 0);
    } else {
      const v = { x: dx / dt, y: dy / dt, z: dz / dt };
      this.body.setLinvel(v, true);
      this.intended.set(v.x, v.y, v.z);
    }
    this.yaw = s[3];
    this.speed = s[4];
    this.drifting = !!s[5];
    this.boostTime = s[6] ? 0.2 : 0;
    this.spinTime = s[7];
    this.grounded = true;
  };
}

// pose: [x, y, z, yaw, speed, drifting, boosting, spinTime]
function poseOf(kart) {
  const p = kart.position;
  const r = (n, d = 100) => Math.round(n * d) / d;
  return [r(p.x), r(p.y), r(p.z), r(kart.yaw, 1000), r(kart.speed), kart.drifting ? 1 : 0, kart.boostTime > 0 ? 1 : 0, r(kart.spinTime)];
}

function sendPose() {
  const net = state.net;
  const game = G?.game;
  if (!net?.started || !game?.player) return;
  if (game.mode !== 'playing' && game.mode !== 'ended' && game.mode !== 'paused') return;
  const ts = Math.round(performance.now());
  send({ t: 's', ts, k: poseOf(game.player.kart) });
  if (net.isHost) {
    const ai = game.racers.filter((r) => !r.isPlayer && !r.net).map((r) => [r.id, ...poseOf(r.kart)]);
    if (ai.length) send({ t: 'a', ts, k: ai });
  }
  if (game.player.finished && !net.finishedSent) {
    net.finishedSent = true;
    send({ t: 'finish', time: game.raceTime });
  }
}

function pushSample(key, from, ts, pose) {
  const net = state.net;
  if (!net) return;
  // map the sender's clock onto ours using the lowest observed delay
  const now = performance.now();
  const off = Math.min(net.clocks.get(from) ?? Infinity, now - ts);
  net.clocks.set(from, off);
  let buf = net.buffers.get(key);
  if (!buf) net.buffers.set(key, (buf = []));
  buf.push({ t: ts + off, p: pose });
  if (buf.length > 40) buf.splice(0, buf.length - 40);
}

function sampleAt(buf, t) {
  if (!buf?.length) return null;
  let i = buf.length - 1;
  while (i > 0 && buf[i - 1].t > t) i -= 1;
  const b = buf[i];
  const a = buf[i - 1];
  if (!a || t >= b.t) {
    // ahead of the newest packet: extrapolate briefly along the last motion
    if (!a) return b.p;
    const dt = Math.min(t - b.t, EXTRAPOLATE_MS);
    const span = b.t - a.t || 1;
    const out = b.p.slice();
    for (let j = 0; j < 3; j += 1) out[j] = b.p[j] + ((b.p[j] - a.p[j]) / span) * dt;
    return out;
  }
  if (t <= a.t) return a.p;
  const f = (t - a.t) / (b.t - a.t);
  const out = b.p.slice();
  for (let j = 0; j < 3; j += 1) out[j] = a.p[j] + (b.p[j] - a.p[j]) * f;
  let dy = b.p[3] - a.p[3];
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  out[3] = a.p[3] + dy * f;
  out[4] = a.p[4] + (b.p[4] - a.p[4]) * f;
  return out;
}
