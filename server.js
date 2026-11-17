'use strict';
// LIGHTLINE.io — authoritative multiplayer light-cycle server
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const envNum = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };

// ---- Tunables -------------------------------------------------------------
const TICK_HZ = 40, DT = 1 / TICK_HZ, SEND_EVERY = 2;      // 40Hz sim, 20Hz net
const ARENA = 500;                                          // square arena (ffa), units
const BASE_SPEED = 22, MAX_SPEED = 62;
const SPEED_DECAY = 5;                                      // u/s^2 back toward base
const GRIND_RANGE = 4, GRIND_ACCEL = 36;                    // wall-grind boost
const BRAKE_SPEED = 11, BRAKE_MAX = 1.5, BRAKE_REGEN = 0.25;
const RUBBER_MAX = 0.5, RUBBER_REGEN = 0.3, MARGIN = 0.3;   // rubber: seconds of "pressing" a wall
const TRAIL_BASE = 240, TRAIL_PER_KILL = 90, TRAIL_PER_SEC = 1.5, TRAIL_CAP = 1500;
const TARGET_POP = 10, MIN_BOTS = 3;
const HOLE_RADIUS = 8;                                      // death blast: cuts gaps in nearby walls
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];               // 0=right 1=down 2=left 3=up

// ---- Fortress tunables (env overrides for testing) ------------------------
const FORT_ARENA = 640, ZONE_R = 40, TEAM_SIZE = 4;
const CAP_TIME = envNum('CAP_TIME', 5);                     // seconds for one attacker to capture
const CAP_DRAIN = 0.1;                                      // per second when no attackers
const ROUND_TIME = envNum('ROUND_TIME', 180);
const COUNTDOWN = envNum('COUNTDOWN', 3);
const END_TIME = envNum('END_TIME', 5);
const ALL_DEAD_DELAY = 3;
const WIN_BONUS = 25;
const TEAMS = [['CYAN', '#00f0ff'], ['ORANGE', '#ff7a00']];
const ZONES = [[FORT_ARENA / 2, FORT_ARENA - 90], [FORT_ARENA / 2, 90]];   // team 0 bottom, team 1 top

const COLORS = ['#00f0ff', '#ff2bd6', '#ffb000', '#39ff14', '#ff3b3b', '#8a5cff', '#ffffff', '#ff7a00'];
const BOT_NAMES = ['Vex', 'Nyx', 'Kilo', 'Arc', 'Juno', 'Rook', 'Pixel', 'Zed', 'Halo', 'Echo',
  'Volt', 'Mira', 'Quark', 'Sable', 'Ion', 'Lumen', 'Onyx', 'Rift', 'Static', 'Vector'];

let nextId = 1;

function makeRoom(mode) {
  return {
    mode, arena: mode === 'fort' ? FORT_ARENA : ARENA,
    players: new Map(),            // id -> player (alive only)
    clients: new Set(),            // sockets receiving deltas
    pendingInit: [],               // sockets waiting for a full snapshot
    deaths: [], lastBotSpawn: 0,
    // fort only
    roster: new Set(),             // sockets on a team (ws.team)
    phase: 0, phaseT: 0, cap: [0, 0], wins: [0, 0], winner: -1, reason: '', allDeadT: -1,
  };
}
const rooms = { ffa: makeRoom('ffa'), fort: makeRoom('fort') };

const r1 = n => Math.round(n * 10) / 10;
const r2 = n => Math.round(n * 100) / 100;
const flat = pts => { const o = []; for (const p of pts) o.push(r2(p[0]), r2(p[1]), p[2] ? 1 : 0); return o; };
const aliveSec = p => p.born === null ? 0 : (Date.now() - p.born) / 1000;
const score = p => p.kills * 10 + Math.floor(aliveSec(p)) + p.bonus;

// ---- Geometry: axis-aligned raycast against every trail + arena -----------
// side=true skips own last two segments (so you don't "grind" the corner you just made)
function ray(R, x, y, dir, maxD, self, side) {
  const horiz = (dir & 1) === 0, s = (dir === 0 || dir === 1) ? 1 : -1;
  const u = horiz ? x : y, v = horiz ? y : x;
  let best = maxD, owner = -1;                 // -1 nothing, 0 arena wall, >0 player id
  const wall = s > 0 ? R.arena - u : u;
  if (wall < best) { best = wall; owner = 0; }
  for (const p of R.players.values()) {
    if (p.dead) continue;
    const pts = p.pts, n = pts.length;
    const lim = p.id === self ? (side ? n - 2 : n - 1) : n;
    for (let i = 0; i < lim; i++) {
      const a = pts[i], b = i + 1 < n ? pts[i + 1] : null;
      if (b && b[2]) continue;                 // gap segment (hole)
      const ax = a[0], ay = a[1], bx = b ? b[0] : p.x, by = b ? b[1] : p.y;
      const au = horiz ? ax : ay, av = horiz ? ay : ax, bu = horiz ? bx : by, bv = horiz ? by : bx;
      if (Math.abs(au - bu) < 1e-6) {          // segment crosses our ray line
        if (v < Math.min(av, bv) - 1e-6 || v > Math.max(av, bv) + 1e-6) continue;
        const t = (au - u) * s;
        if (t > 1e-4 && t < best) { best = t; owner = p.id; }
      } else {                                 // segment parallel to ray
        if (Math.abs(av - v) > 0.05) continue;
        const t1 = (au - u) * s, t2 = (bu - u) * s;
        if (Math.max(t1, t2) <= 1e-4) continue;
        const t = Math.max(Math.min(t1, t2), 0);
        if (t < best) { best = t; owner = p.id; }
      }
    }
  }
  return { d: best, owner };
}

function findSpawn(R) {
  const A = R.arena;
  for (let i = 0; i < 120; i++) {
    const x = 30 + Math.random() * (A - 60), y = 30 + Math.random() * (A - 60);
    const dir = Math.floor(Math.random() * 4);
    if (ray(R, x, y, dir, 80, 0, false).d < 80) continue;
    if (ray(R, x, y, (dir + 1) % 4, 12, 0, false).d < 12) continue;
    if (ray(R, x, y, (dir + 3) % 4, 12, 0, false).d < 12) continue;
    let ok = true;
    for (const p of R.players.values()) if (Math.hypot(p.x - x, p.y - y) < 30) { ok = false; break; }
    if (ok) return { x, y, dir };
  }
  return { x: A / 2, y: A / 2, dir: Math.floor(Math.random() * 4) };
}

function makePlayer(R, name, color, bot, sp, team) {
  sp = sp || findSpawn(R);
  const p = {
    id: nextId++, name, color, bot, x: sp.x, y: sp.y, dir: sp.dir, team: team === undefined ? -1 : team,
    speed: BASE_SPEED, rubber: RUBBER_MAX, brake: BRAKE_MAX, braking: false, blocked: false, grind: 0,
    pts: [[sp.x, sp.y]], base: 0, newPts: [], rev: 0, revDirty: false, trailLen: 0, kills: 0, bonus: 0, born: Date.now(),
    queue: [], caution: 2 + Math.random() * 7, fresh: true, dead: false, ws: null,
    role: null, tx: 0, ty: 0, patrolAt: 0, steerAt: 0,
  };
  R.players.set(p.id, p);
  return p;
}

// Cut a gap into every solid segment (incl. head segment) overlapping circle (cx,cy,r).
// pts entries are [x,y] or [x,y,1] (1 = segment from previous point is a gap). Returns new pts or null.
function cutTrail(pts, hx, hy, cx, cy, r) {
  const n = pts.length, out = [pts[0].slice()];
  let cut = false;
  const push = pt => {                         // merge collinear gap-after-gap points
    const k = out.length;
    if (pt[2] && k >= 2 && out[k - 1][2]) {
      const a = out[k - 2], b = out[k - 1];
      if ((a[0] === b[0] && b[0] === pt[0]) || (a[1] === b[1] && b[1] === pt[1])) { out[k - 1] = pt; return; }
    }
    out.push(pt);
  };
  for (let i = 1; i <= n; i++) {
    const head = i === n, a = pts[i - 1], b = head ? [hx, hy] : pts[i];
    const L = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
    let lo = 0, hi = 0;
    if (!b[2] && L > 1e-6) {
      const ux = Math.sign(b[0] - a[0]), uy = Math.sign(b[1] - a[1]);
      const tc = (cx - a[0]) * ux + (cy - a[1]) * uy;
      const h = Math.abs((cx - a[0]) * uy - (cy - a[1]) * ux);
      if (h < r) {
        const half = Math.sqrt(r * r - h * h);
        lo = Math.max(0, tc - half); hi = Math.min(L, tc + half);
      }
      if (hi - lo >= 1e-3) {
        cut = true;
        const P = t => [a[0] + ux * t, a[1] + uy * t];
        if (lo > 1e-3) push(P(lo));                         // solid part up to lo
        if (hi >= L - 1e-3) { push([b[0], b[1], 1]); continue; } // gap reaches segment end (or head)
        push([...P(hi), 1]);                                // gap, then solid remainder to b
        if (!head) push(b.slice());
        continue;
      }
    }
    if (!head) push(b.slice());
  }
  return cut ? out : null;
}

function kill(R, p, owner) {
  if (p.dead) return;
  p.dead = true;
  R.deaths.push([p.id, r2(p.x), r2(p.y)]);
  for (const q of R.players.values()) {
    if (q === p || q.dead) continue;
    const np = cutTrail(q.pts, q.x, q.y, p.x, p.y, HOLE_RADIUS);
    if (np) { q.pts = np; q.rev++; q.revDirty = true; }
  }
  let by = 'the arena wall';
  if (owner > 0 && owner !== p.id) {
    const k = R.players.get(owner);
    if (k) {
      const teammate = k.team >= 0 && k.team === p.team;
      if (!k.dead && !teammate) k.kills++;
      by = k.name;
    }
  } else if (owner === p.id) by = 'your own wall';
  if (p.ws && p.ws.readyState === 1) {
    p.ws.send(JSON.stringify({ t: 'dead', by, score: score(p), kills: p.kills, time: Math.floor(aliveSec(p)) }));
  }
}

function trim(p) {
  const maxLen = Math.min(TRAIL_CAP, TRAIL_BASE + p.kills * TRAIL_PER_KILL + aliveSec(p) * TRAIL_PER_SEC);
  let excess = p.trailLen - maxLen;
  while (excess > 1e-9) {
    const a = p.pts[0], b = p.pts.length > 1 ? p.pts[1] : [p.x, p.y];
    const seg = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
    if (seg <= excess + 1e-9 && p.pts.length > 1) {
      p.pts.shift(); p.base++; excess -= seg; p.trailLen -= seg;
    } else {
      const f = Math.min(excess, seg);
      a[0] += Math.sign(b[0] - a[0]) * f; a[1] += Math.sign(b[1] - a[1]) * f;
      p.trailLen -= f; break;
    }
  }
}

function update(R, p) {
  // 1) turn (one queued turn per tick)
  if (p.queue.length) {
    const q = p.queue.shift();
    const nd = q.rel !== undefined ? (p.dir + (q.rel > 0 ? 1 : 3)) % 4 : q.abs;
    if (nd !== p.dir && nd !== (p.dir + 2) % 4) {
      const last = p.pts[p.pts.length - 1];
      if (last[0] !== p.x || last[1] !== p.y) { const pt = [p.x, p.y]; p.pts.push(pt); p.newPts.push(pt); }
      p.dir = nd;
    }
  }
  // 2) speed: brake / decay / grind
  if (p.braking && p.brake > 0) {
    p.brake = Math.max(0, p.brake - DT);
    if (p.speed > BRAKE_SPEED) p.speed = Math.max(BRAKE_SPEED, p.speed - 40 * DT);
  } else {
    p.brake = Math.min(BRAKE_MAX, p.brake + BRAKE_REGEN * DT);
    if (p.speed > BASE_SPEED) p.speed = Math.max(BASE_SPEED, p.speed - SPEED_DECAY * DT);
    else if (p.speed < BASE_SPEED) p.speed = Math.min(BASE_SPEED, p.speed + 25 * DT);
  }
  const l = ray(R, p.x, p.y, (p.dir + 3) % 4, GRIND_RANGE, p.id, true).d;
  const r = ray(R, p.x, p.y, (p.dir + 1) % 4, GRIND_RANGE, p.id, true).d;
  p.grind = (1 - l / GRIND_RANGE) + (1 - r / GRIND_RANGE);
  if (p.grind > 0) p.speed = Math.min(MAX_SPEED, p.speed + GRIND_ACCEL * p.grind * DT);
  // 3) move with rubber
  const stepLen = p.speed * DT;
  const ah = ray(R, p.x, p.y, p.dir, stepLen + MARGIN + 0.5, p.id, false);
  const avail = ah.d - MARGIN;
  let mv;
  if (avail >= stepLen) {
    mv = stepLen; p.blocked = false;
    p.rubber = Math.min(RUBBER_MAX, p.rubber + RUBBER_REGEN * DT);
  } else {
    mv = Math.max(0, avail); p.blocked = true;
    p.rubber -= DT;
    if (p.rubber <= 0) { p.rubber = 0; kill(R, p, ah.owner); return; }
  }
  p.x += DX[p.dir] * mv; p.y += DY[p.dir] * mv;
  p.trailLen += mv;
  trim(p);
}

// ---- Bots -----------------------------------------------------------------
function botThink(R, p) {
  if (p.queue.length) return;
  const look = p.speed * 0.35 + p.caution;
  const ahead = ray(R, p.x, p.y, p.dir, look, p.id, false).d;
  if (ahead < look) {
    const L = ray(R, p.x, p.y, (p.dir + 3) % 4, 160, p.id, true).d;
    const Rt = ray(R, p.x, p.y, (p.dir + 1) % 4, 160, p.id, true).d;
    p.queue.push({ rel: (L > Rt || (L === Rt && Math.random() < 0.5)) ? -1 : 1 });
    return;
  }
  if (R.mode === 'fort' && p.role) {
    if (botSteer(R, p)) return;
    if (Math.random() < 0.12 * DT) {
      const side = Math.random() < 0.5 ? -1 : 1;
      if (ray(R, p.x, p.y, (p.dir + (side > 0 ? 1 : 3)) % 4, 40, p.id, true).d >= 40) p.queue.push({ rel: side });
    }
    return;
  }
  if (Math.random() < 0.7 * DT) {
    const side = Math.random() < 0.5 ? -1 : 1;
    if (ray(R, p.x, p.y, (p.dir + (side > 0 ? 1 : 3)) % 4, 40, p.id, true).d >= 40) p.queue.push({ rel: side });
  }
}

// Fort: steer toward role target when the way ahead is clear. Returns true if a turn was queued.
function botSteer(R, p) {
  const now = Date.now();
  if (now < p.steerAt) return false;
  if (ray(R, p.x, p.y, p.dir, 40, p.id, false).d < 40) return false;
  if (p.role === 'atk') {
    const z = ZONES[1 - p.team]; p.tx = z[0]; p.ty = z[1];
  } else if (now >= p.patrolAt) {
    const z = ZONES[p.team], a = Math.random() * Math.PI * 2;
    p.tx = z[0] + Math.cos(a) * (ZONE_R + 20); p.ty = z[1] + Math.sin(a) * (ZONE_R + 20);
    p.patrolAt = now + 2500 + Math.random() * 1000;
  }
  const dx = p.tx - p.x, dy = p.ty - p.y;
  const rd = (p.dir + 1) % 4;
  const fwd = dx * DX[p.dir] + dy * DY[p.dir], lat = dx * DX[rd] + dy * DY[rd];
  let side = 0;
  if (Math.abs(lat) > 10 && fwd < Math.abs(lat)) side = lat > 0 ? 1 : -1;
  else if (fwd < -10) side = Math.random() < 0.5 ? -1 : 1;          // target behind: turn either way
  if (!side) return false;
  const nd = (p.dir + (side > 0 ? 1 : 3)) % 4;
  if (ray(R, p.x, p.y, nd, 30, p.id, true).d < 30) {
    if (fwd >= -10) return false;
    const od = (p.dir + (side > 0 ? 3 : 1)) % 4;                     // behind: try other side
    if (ray(R, p.x, p.y, od, 30, p.id, true).d < 30) return false;
    side = -side;
  }
  p.queue.push({ rel: side });
  p.steerAt = now + 300;
  return true;
}

function freeBotName(R) {
  const used = new Set(); for (const p of R.players.values()) used.add(p.name);
  const free = BOT_NAMES.filter(n => !used.has(n));
  return free[Math.floor(Math.random() * free.length)] || 'Bot';
}

function manageBots(R) {
  let humans = 0, bots = [];
  for (const p of R.players.values()) p.bot ? bots.push(p) : humans++;
  const target = Math.max(MIN_BOTS, TARGET_POP - humans);
  const now = Date.now();
  if (bots.length < target && now - R.lastBotSpawn > 600) {
    R.lastBotSpawn = now;
    makePlayer(R, freeBotName(R), COLORS[Math.floor(Math.random() * COLORS.length)], true);
  } else if (bots.length > target + 1) {
    kill(R, bots[0], -1);
  }
}

// ---- Fortress rounds ------------------------------------------------------
function startRound(R) {
  R.players.clear(); R.deaths = [];
  for (const c of R.clients) if (!R.pendingInit.includes(c)) R.pendingInit.push(c);
  R.clients.clear();
  R.phase = 0; R.phaseT = COUNTDOWN; R.cap = [0, 0]; R.winner = -1; R.reason = ''; R.allDeadT = -1;
  const hum = [[], []];
  for (const ws of R.roster) { ws.player = null; hum[ws.team].push(ws); }
  const n = Math.max(TEAM_SIZE, hum[0].length, hum[1].length), A = R.arena;
  const gap = n > 1 ? Math.min(40, (A - 60) / (n - 1)) : 0;
  for (let t = 0; t < 2; t++) {
    const y = t === 0 ? A - 30 : 30, dir = t === 0 ? 3 : 1;
    let botIdx = 0;
    for (let i = 0; i < n; i++) {
      const sp = { x: A / 2 + (i - (n - 1) / 2) * gap, y, dir };
      let p;
      if (i < hum[t].length) {
        const ws = hum[t][i];
        p = makePlayer(R, ws.pname, TEAMS[t][1], false, sp, t);
        p.ws = ws; ws.player = p; ws.pendingYou = p.id;   // 'you' sent right after the new init
      } else {
        p = makePlayer(R, freeBotName(R), TEAMS[t][1], true, sp, t);
        p.role = botIdx++ % 2 ? 'def' : 'atk';
      }
      p.born = null;                                    // frozen: no alive-time during WAIT
    }
  }
}

function endRound(R, winner, reason) {
  R.phase = 2; R.phaseT = END_TIME; R.winner = winner; R.reason = reason; R.allDeadT = -1;
  if (winner === 0 || winner === 1) {
    R.wins[winner]++;
    for (const p of R.players.values()) if (!p.dead && p.team === winner) p.bonus += WIN_BONUS;
  }
}

startRound(rooms.fort);

const timeWinner =R => R.cap[1] > R.cap[0] ? 0 : R.cap[0] > R.cap[1] ? 1 : 2;

function stepFort(R) {
  for (const [id, p] of R.players) if (p.dead) R.players.delete(id);  // players dropped mid-countdown
  R.phaseT -= DT;
  if (R.phase === 0) {
    for (const p of R.players.values()) p.queue.length = 0;
    if (R.phaseT <= 0) {
      R.phase = 1; R.phaseT = ROUND_TIME;
      const now = Date.now();
      for (const p of R.players.values()) p.born = now;
    }
    return;
  }
  for (const p of R.players.values()) if (p.bot && !p.dead) botThink(R, p);
  for (const p of R.players.values()) if (!p.dead) update(R, p);
  for (const [id, p] of R.players) if (p.dead) R.players.delete(id);
  if (R.phase === 2) { if (R.phaseT <= 0) startRound(R); return; }
  // PLAY: capture
  const alive = [0, 0];
  let humansAlive = 0;
  for (const p of R.players.values()) if (p.team >= 0) { alive[p.team]++; if (!p.bot) humansAlive++; }
  for (let T = 0; T < 2; T++) {
    const z = ZONES[T];
    let att = 0, def = 0;
    for (const p of R.players.values()) {
      if (Math.hypot(p.x - z[0], p.y - z[1]) > ZONE_R) continue;
      if (p.team === T) def++; else if (p.team === 1 - T) att++;
    }
    if (att > 0 && def === 0) R.cap[T] += DT / CAP_TIME * (1 + 0.5 * (att - 1));
    else if (att === 0) R.cap[T] = Math.max(0, R.cap[T] - CAP_DRAIN * DT);
  }
  const c0 = R.cap[0] >= 1, c1 = R.cap[1] >= 1;
  R.cap[0] = Math.min(1, R.cap[0]); R.cap[1] = Math.min(1, R.cap[1]);
  if (c0 && c1) return endRound(R, 2, 'capture');
  if (c0) return endRound(R, 1, 'capture');
  if (c1) return endRound(R, 0, 'capture');
  if (alive[0] === 0 || alive[1] === 0) return endRound(R, alive[0] ? 0 : alive[1] ? 1 : 2, 'wipe');
  if (R.phaseT <= 0) return endRound(R, timeWinner(R), 'time');
  let rosterHumans = 0; for (const ws of R.roster) rosterHumans++;
  if (rosterHumans > 0 && humansAlive === 0) {
    if (R.allDeadT < 0) R.allDeadT = ALL_DEAD_DELAY;
    R.allDeadT -= DT;
    if (R.allDeadT <= 0) return endRound(R, timeWinner(R), 'time');
  } else R.allDeadT = -1;
}

// ---- Loop -----------------------------------------------------------------
let tick = 0;
function stepRoom(R) {
  if (R.mode === 'fort') return stepFort(R);
  manageBots(R);
  for (const p of R.players.values()) if (p.bot) botThink(R, p);
  for (const p of R.players.values()) if (!p.dead) update(R, p);
  for (const [id, p] of R.players) if (p.dead) R.players.delete(id);
}

function step() {
  for (const R of Object.values(rooms)) stepRoom(R);
  if (++tick % SEND_EVERY === 0) {
    const rc = {};
    for (const k in rooms) rc[k] = rooms[k].clients.size + rooms[k].pendingInit.length;
    for (const R of Object.values(rooms)) broadcast(R, rc);
  }
}

const fullEntry = p => [p.id, p.name, p.color, p.base, flat(p.pts), r2(p.x), r2(p.y), p.dir, p.rev, p.team];

function broadcast(R, rc) {
  const j = [];
  for (const p of R.players.values()) if (p.fresh) { j.push(fullEntry(p)); p.fresh = false; }
  const f = [];                    // trails cut by holes: full resend (covers any unsent newPts)
  for (const p of R.players.values()) if (p.revDirty) { f.push(fullEntry(p)); p.revDirty = false; p.newPts = []; }
  const ps = [];
  for (const p of R.players.values()) {
    ps.push([p.id, r2(p.x), r2(p.y), p.dir, p.blocked ? 0 : r2(p.speed), r2(p.rubber / RUBBER_MAX),
      p.base, p.pts.length, r2(p.pts[0][0]), r2(p.pts[0][1]), flat(p.newPts),
      (p.braking && p.brake > 0) ? 1 : 0, r2(p.grind), r2(p.brake / BRAKE_MAX), r2(p.speed), score(p), p.kills, p.rev]);
    p.newPts = [];
  }
  const lb = [...R.players.values()].map(p => [p.name, score(p), p.color, p.id, p.kills, p.team])
    .sort((a, b) => b[1] - a[1]).slice(0, 10);
  const s = { t: 's', j, p: ps, f, d: R.deaths, lb, n: R.clients.size + R.pendingInit.length, rc };
  if (R.mode === 'fort') {
    const alive = [0, 0];
    for (const p of R.players.values()) if (p.team >= 0) alive[p.team]++;
    s.g = [R.phase, r1(Math.max(0, R.phaseT)), r2(R.cap[0]), r2(R.cap[1]), R.wins[0], R.wins[1],
      alive[0], alive[1], R.winner, R.reason];
  }
  const msg = JSON.stringify(s);
  R.deaths = [];
  for (const c of R.clients) if (c.readyState === 1) c.send(msg);
  // new / resyncing sockets get a full snapshot *after* this delta, so nothing is double-applied
  if (R.pendingInit.length) {
    const im = { t: 'init', mode: R.mode, arena: R.arena, hole: HOLE_RADIUS, players: [...R.players.values()].map(fullEntry) };
    if (R.mode === 'fort') im.fort = { zones: ZONES.map((z, t) => [z[0], z[1], ZONE_R, t]), teams: TEAMS.map(t => t.slice()) };
    const init = JSON.stringify(im);
    for (const c of R.pendingInit) {
      if (c.readyState !== 1) continue;
      c.send(init); R.clients.add(c);
      if (c.pendingYou) { c.send(JSON.stringify({ t: 'you', id: c.pendingYou })); c.pendingYou = 0; }
    }
    R.pendingInit = [];
  }
}

let last = performance.now();
setInterval(() => {
  const now = performance.now();
  let n = 0;
  while (now - last >= DT * 1000 && n++ < 8) { step(); last += DT * 1000; }
  if (now - last > 1000) last = now;    // don't spiral after a stall
}, 4);

// ---- HTTP + WebSocket -----------------------------------------------------
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let url; try { url = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  if (url.includes("\0")) { res.writeHead(400); return res.end(); }
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  const file = path.join(PUB, url === '/' ? 'index.html' : url);
  if (file !== PUB && !file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// Kill the socket's player (silently: no 'dead' message) and take it off the fort roster.
function dropPlayer(ws) {
  const R = ws.room, p = ws.player;
  if (p && !p.dead) { p.ws = null; kill(R, p, -1); }
  ws.player = null; ws.pendingYou = 0;
  R.roster.delete(ws); ws.team = -1;
}

function moveTo(ws, R) {
  if (ws.room === R) return;
  dropPlayer(ws);
  const old = ws.room;
  old.clients.delete(ws); old.pendingInit = old.pendingInit.filter(c => c !== ws);
  ws.room = R; R.pendingInit.push(ws);
}

const cleanName = n => String(n || '').replace(/[^\w \-.!?]/g, '').trim().slice(0, 16) || 'Anon';

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', ws => {
  ws.player = null; ws.team = -1; ws.pendingYou = 0; ws.pname = 'Anon';
  ws.room = rooms.ffa;
  rooms.ffa.pendingInit.push(ws);
  ws.on('error', () => {});  // oversized/malformed frames: 'close' still runs cleanup
  ws.on('message', data => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    if (m.mode !== undefined && m.mode !== 'ffa' && m.mode !== 'fort') return;
    const R = ws.room, p = ws.player;
    if (m.t === 'watch') {
      if (m.mode) moveTo(ws, rooms[m.mode]);
    } else if (m.t === 'join') {
      const T = rooms[m.mode || R.mode];
      if (T.mode === 'ffa') {
        if (T === R && p && !p.dead) return;
        moveTo(ws, T);
        const color = COLORS.includes(m.color) ? m.color : COLORS[Math.floor(Math.random() * COLORS.length)];
        const np = makePlayer(T, cleanName(m.name), color, false);
        np.ws = ws; ws.player = np;
        ws.send(JSON.stringify({ t: 'you', id: np.id }));
      } else {
        if (T === R && R.roster.has(ws)) return;
        moveTo(ws, T);
        ws.pname = cleanName(m.name);
        let h0 = 0, h1 = 0;
        for (const c of T.roster) c.team ? h1++ : h0++;
        ws.team = h0 < h1 ? 0 : h1 < h0 ? 1 : (Math.random() < 0.5 ? 0 : 1);
        if (T.roster.size === 0) T.wins = [0, 0];  // fresh tally for the first human in
        T.roster.add(ws);
        ws.send(JSON.stringify({ t: 'team', team: ws.team }));
        let others = false;
        for (const q of T.players.values()) if (!q.bot && !q.dead && q.ws !== ws) { others = true; break; }
        if (T.phase === 0) {  // re-seed the round but keep the countdown running, so a stream of joins can't stall it
          const keep = T.phaseT; startRound(T); T.phaseT = keep;
        } else if (T.phase === 1 && !others) startRound(T);
      }
    } else if (m.t === 'leave') {
      dropPlayer(ws);
    } else if (m.t === 'turn' && p && !p.dead) {
      if (R.mode === 'fort' && R.phase === 0) return;
      if (p.queue.length < 4) p.queue.push(m.rel ? { rel: m.rel > 0 ? 1 : -1 } : { abs: (((m.abs | 0) % 4) + 4) % 4 });
    } else if (m.t === 'brake' && p) {
      p.braking = !!m.on;
    } else if (m.t === 'resync') {
      R.clients.delete(ws); if (!R.pendingInit.includes(ws)) R.pendingInit.push(ws);
    }
  });
  ws.on('close', () => {
    const R = ws.room;
    dropPlayer(ws);
    R.clients.delete(ws);
    R.pendingInit = R.pendingInit.filter(c => c !== ws);
  });
});

server.listen(PORT, () => console.log(`LIGHTLINE.io running on http://localhost:${PORT}`));
