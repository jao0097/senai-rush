// SENAI Rush online server: 4-digit lobbies, character pick + track vote
// (60 s window started by the host), then a dumb relay for kart poses.
// Also serves the static game build so one process hosts everything.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8080;
const STATIC_DIR = resolve(
  process.env.STATIC_DIR ||
    join(fileURLToPath(new URL('.', import.meta.url)), '..', 'senai-rush-netlify'),
);
const MAX_PLAYERS = 4; // the game has 4 human grid slots
const SELECT_MS = Number(process.env.SELECT_MS) || 60_000;
const REVEAL_MS = 4_000; // "track chosen" screen before the race intro starts
const RACE_TIMEOUT_MS = 10 * 60_000;
const NAME_MAX = 14;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
};

const http = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path.endsWith('/')) path += 'index.html';
  const file = join(STATIC_DIR, path);
  if (!file.startsWith(STATIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    const body = await readFile(file);
    const hashed = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

/** @type {Map<string, Room>} */
const rooms = new Map();
let nextId = 1;

/**
 * @typedef {{ id: string, name: string, ws: import('ws').WebSocket, char: string|null,
 *   vote: string|null, ready: boolean, inRace: boolean, finished: number|null }} Player
 * @typedef {{ code: string, host: string, phase: 'lobby'|'select'|'reveal'|'race',
 *   players: Player[], chars: string[], tracks: string[], deadline: number,
 *   timer: NodeJS.Timeout|null, race: object|null }} Room
 */

function newCode() {
  for (let i = 0; i < 1000; i += 1) {
    const code = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
    if (!rooms.has(code)) return code;
  }
  return null;
}

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

function view(room) {
  return {
    code: room.code,
    host: room.host,
    phase: room.phase,
    remaining: room.phase === 'select' ? Math.max(0, room.deadline - Date.now()) : 0,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      char: p.char,
      vote: p.vote,
      ready: p.ready,
      inRace: p.inRace,
      finished: p.finished,
    })),
    race: room.race,
  };
}

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const p of room.players) if (p.id !== except && p.ws.readyState === 1) p.ws.send(data);
}

const sync = (room) => broadcast(room, { t: 'room', room: view(room) });

function cleanList(list, fallback) {
  if (!Array.isArray(list)) return fallback;
  const out = list.filter((s) => typeof s === 'string' && /^[a-z0-9_-]{1,24}$/i.test(s));
  return out.length ? [...new Set(out)].slice(0, 64) : fallback;
}

function cleanName(name, id) {
  const n = String(name ?? '').replace(/[<>&"'`]/g, '').trim().slice(0, NAME_MAX);
  return n || `Piloto ${id}`;
}

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function startSelect(room) {
  room.phase = 'select';
  room.deadline = Date.now() + SELECT_MS;
  room.race = null;
  for (const p of room.players) {
    p.ready = false;
    p.vote = null;
    p.inRace = false;
    p.finished = null;
    // keep last character if still valid, so rematches are quick
    if (p.char && !room.chars.includes(p.char)) p.char = null;
  }
  clearTimer(room);
  room.timer = setTimeout(() => finishSelect(room), SELECT_MS);
  sync(room);
}

const pickRandom = (list) => list[Math.floor(Math.random() * list.length)];

function finishSelect(room) {
  if (room.phase !== 'select') return;
  clearTimer(room);
  // whoever didn't pick gets a random free character
  for (const p of room.players) {
    if (p.char) continue;
    const taken = new Set(room.players.map((q) => q.char));
    const free = room.chars.filter((c) => !taken.has(c));
    p.char = pickRandom(free.length ? free : room.chars);
  }
  const tally = new Map();
  for (const p of room.players) if (p.vote) tally.set(p.vote, (tally.get(p.vote) || 0) + 1);
  const top = Math.max(0, ...tally.values());
  const tied = top ? [...tally].filter(([, n]) => n === top).map(([t]) => t) : room.tracks;
  const track = pickRandom(tied);

  room.phase = 'reveal';
  room.race = {
    track,
    seed: Math.floor(Math.random() * 2 ** 31),
    // grid order = lobby order; every client spawns the same layout
    order: room.players.map((p) => ({ id: p.id, char: p.char, name: p.name })),
    votes: Object.fromEntries(tally),
    startIn: REVEAL_MS,
  };
  for (const p of room.players) {
    p.inRace = true;
    p.finished = null;
  }
  sync(room);
  room.timer = setTimeout(() => {
    room.phase = 'race';
    sync(room);
    room.timer = setTimeout(() => endRace(room), RACE_TIMEOUT_MS);
  }, REVEAL_MS);
}

function endRace(room) {
  clearTimer(room);
  room.phase = 'lobby';
  room.race = null;
  for (const p of room.players) {
    p.inRace = false;
    p.ready = false;
  }
  sync(room);
}

function maybeEndRace(room) {
  if ((room.phase === 'race' || room.phase === 'reveal') && !room.players.some((p) => p.inRace)) {
    endRace(room);
  }
}

function leave(player, room) {
  room.players = room.players.filter((p) => p !== player);
  if (!room.players.length) {
    clearTimer(room);
    rooms.delete(room.code);
    return;
  }
  if (room.host === player.id) room.host = room.players[0].id;
  broadcast(room, { t: 'left', id: player.id });
  if (room.phase === 'select' && room.players.every((p) => p.ready)) finishSelect(room);
  else maybeEndRace(room);
  sync(room);
}

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  const id = String(nextId++);
  /** @type {Player|null} */
  let me = null;
  /** @type {Room|null} */
  let room = null;
  let alive = true;
  ws.on('pong', () => (alive = true));
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 15_000);

  const join = (r, name) => {
    room = r;
    me = { id, name: cleanName(name, id), ws, char: null, vote: null, ready: false, inRace: false, finished: null };
    r.players.push(me);
    send(ws, { t: 'joined', you: id, code: r.code });
    sync(r);
  };

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m.t !== 'string') return;

    // hot path: race traffic is relayed untouched (sender id stamped)
    if (room && me && (m.t === 's' || m.t === 'a' || m.t === 'hit')) {
      if (room.phase !== 'race' && room.phase !== 'reveal') return;
      if (m.t === 'a' && room.host !== me.id) return;
      m.from = id;
      if (m.t === 'hit') {
        const target = m.to === 'ai' ? room.players.find((p) => p.id === room.host) : room.players.find((p) => p.id === m.to);
        if (target) send(target.ws, m);
      } else broadcast(room, m, id);
      return;
    }

    switch (m.t) {
      case 'time':
        send(ws, { t: 'time', c: m.c, s: Date.now() });
        return;
      case 'create': {
        if (room) return;
        const code = newCode();
        if (!code) return send(ws, { t: 'error', msg: 'Servidor cheio, tente de novo.' });
        const r = {
          code,
          host: id,
          phase: 'lobby',
          players: [],
          chars: cleanList(m.chars, ['hamster']),
          tracks: cleanList(m.tracks, ['campus']),
          deadline: 0,
          timer: null,
          race: null,
        };
        rooms.set(code, r);
        join(r, m.name);
        return;
      }
      case 'join': {
        if (room) return;
        const r = rooms.get(String(m.code ?? '').trim());
        if (!r) return send(ws, { t: 'error', msg: 'Lobby não encontrado. Confere o código.' });
        if (r.players.length >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'Lobby cheio (máx. 4).' });
        if (r.phase !== 'lobby') return send(ws, { t: 'error', msg: 'Esse lobby já começou. Espera acabar a corrida.' });
        join(r, m.name);
        return;
      }
    }

    if (!room || !me) return;
    switch (m.t) {
      case 'leave':
        leave(me, room);
        room = null;
        me = null;
        return;
      case 'start':
        if (room.host === me.id && room.phase === 'lobby') startSelect(room);
        return;
      case 'pick': {
        if (room.phase !== 'select' || !room.chars.includes(m.char)) return;
        if (room.players.some((p) => p !== me && p.char === m.char)) return;
        me.char = m.char;
        sync(room);
        return;
      }
      case 'vote':
        if (room.phase !== 'select' || !room.tracks.includes(m.track)) return;
        me.vote = m.track;
        sync(room);
        return;
      case 'ready':
        if (room.phase !== 'select') return;
        me.ready = !!m.ready && !!me.char;
        if (room.players.every((p) => p.ready)) finishSelect(room);
        else sync(room);
        return;
      case 'finish':
        if (room.phase !== 'race') return;
        if (me.finished == null) me.finished = Number(m.time) || 0;
        sync(room);
        return;
      case 'back':
        // player left the race screen; room returns to lobby once everyone is back
        me.inRace = false;
        maybeEndRace(room);
        sync(room);
        return;
      case 'abort':
        if (room.host === me.id && (room.phase === 'race' || room.phase === 'reveal')) {
          broadcast(room, { t: 'abort' });
          endRace(room);
        }
        return;
    }
  });

  ws.on('close', () => {
    clearInterval(ping);
    if (me && room) leave(me, room);
  });
});

http.listen(PORT, () => {
  console.log(`SENAI Rush online: http://localhost:${PORT}  (static: ${STATIC_DIR})`);
});
