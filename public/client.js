'use strict';
(() => {
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const COLORS = ['#00f0ff', '#ff2bd6', '#ffb000', '#39ff14', '#ff3b3b', '#8a5cff', '#ffffff', '#ff7a00'];
  const $ = id => document.getElementById(id);
  const cv = $('c'), ctx = cv.getContext('2d');
  const mini = $('mini'), mctx = mini.getContext('2d');

  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = W * DPR; cv.height = H * DPR;
    const r = mini.getBoundingClientRect();
    mini.width = r.width * DPR; mini.height = r.height * DPR;
  }
  addEventListener('resize', resize); resize();

  // ---- state ----
  let ARENA = 500, HOLE = 10;
  const players = new Map();
  let myId = null, alive = false, lb = [], online = 0, awaitingInit = true;
  const parts = [], blasts = [];
  const cam = { x: 250, y: 250, z: 120 };
  let zoomT = 1, zoomCur = 1, mapHeld = false, mapLock = false, mapK = 0, mapOn = false;
  // modes: `mode` = room we're currently receiving (from init), `selMode` = menu choice
  let mode = 'ffa', fort = null, g = null, rc = { ffa: 0, fort: 0 };
  let myTeam = -1, waiting = false, specId = null, toastUntil = 0, goUntil = 0, prevPhase = -1;
  let prevCap = [0, 0];
  const capRise = [-1e9, -1e9];
  const TEAM_DEF = [['CYAN', '#00f0ff'], ['ORANGE', '#ff7a00']];
  const teamName = t => (fort && fort.teams && fort.teams[t] ? fort.teams[t][0] : (TEAM_DEF[t] || ['?'])[0]);
  const teamCol = t => (fort && fort.teams && fort.teams[t] ? fort.teams[t][1] : (TEAM_DEF[t] || [0, '#ffffff'])[1]);
  const REASON = { capture: 'Zone captured', wipe: 'Team eliminated', time: 'Time' };

  // ---- prefs ----
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  zoomT = Math.max(0.6, Math.min(3, parseFloat(store.get('ll_zoom')) || 1)); zoomCur = zoomT;
  let myColor = store.get('ll_color') || COLORS[Math.floor(Math.random() * COLORS.length)];
  $('name').value = store.get('ll_name') || '';
  const sw = $('swatches');
  COLORS.forEach(c => {
    const b = document.createElement('button');
    b.style.background = c; b.style.boxShadow = `0 0 10px ${c}`;
    if (c === myColor) b.classList.add('sel');
    b.onclick = () => { myColor = c; [...sw.children].forEach(x => x.classList.remove('sel')); b.classList.add('sel'); };
    sw.appendChild(b);
  });
  let selMode = store.get('ll_mode') === 'fort' ? 'fort' : 'ffa';
  let joined = false; // true between PLAY and leave/mode switch/disconnect
  const modeBtns = [...document.querySelectorAll('#modes button')];
  function updateModeUI() {
    modeBtns.forEach(b => b.classList.toggle('sel', b.dataset.m === selMode));
    sw.style.display = selMode === 'fort' ? 'none' : '';
  }
  modeBtns.forEach(b => b.onclick = () => {
    b.blur();
    if (b.dataset.m === selMode) return;
    selMode = b.dataset.m; store.set('ll_mode', selMode); updateModeUI();
    if (!alive) myId = null;
    myTeam = -1; waiting = false; joined = false;
    send({ t: 'watch', mode: selMode });
  });
  updateModeUI();

  // ---- network ----
  let ws;
  function connect() {
    $('conn').style.display = 'block';
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onopen = () => { $('conn').style.display = 'none'; send({ t: 'watch', mode: selMode }); };
    ws.onmessage = e => handle(JSON.parse(e.data));
    ws.onclose = () => {
      alive = false; myId = null; myTeam = -1; waiting = false; toastUntil = 0; awaitingInit = true; joined = false;
      showMenu(); setTimeout(connect, 1200);
    };
  }
  const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

  // flat triples [x,y,g,...] -> [[x,y,g],...]; g=1: segment from previous point is a gap
  function tri(flat, out = []) { for (let i = 0; i < flat.length; i += 3) out.push([flat[i], flat[i + 1], flat[i + 2]]); return out; }
  function addPlayer(j) {
    const [id, name, color, base, flat, x, y, dir, rev, team] = j;
    players.set(id, { id, name, color, base, pts: tri(flat), rev, x, y, dir, team: team ?? -1, vel: 0, rubber: 1, brk: 0, grind: 0, brake: 1, speed: 22, t: performance.now(), rx: x, ry: y });
  }

  function handle(m) {
    if (m.t === 'init') {
      ARENA = m.arena; if (m.hole) HOLE = m.hole; players.clear(); m.players.forEach(addPlayer); awaitingInit = false;
      mode = m.mode === 'fort' ? 'fort' : 'ffa';
      fort = mode === 'fort' ? (m.fort || null) : null;
      g = null; prevPhase = -1; prevCap = [0, 0]; capRise[0] = capRise[1] = -1e9;
      parts.length = 0; blasts.length = 0;
      // round restart / room switch: if our cycle isn't in the new snapshot we're not alive (a later 'you' revives us)
      if (myId == null || !players.has(myId)) alive = false;
    } else if (m.t === 's') {
      if (awaitingInit) return;
      const fresh = new Set();
      for (const j of m.j) { addPlayer(j); fresh.add(j[0]); }
      for (const j of m.f || []) {             // trails cut by a blast: full replace, keep visual state
        const p = players.get(j[0]);
        if (p) { p.pts = tri(j[4]); p.base = j[3]; p.rev = j[8]; if (j.length > 9) p.team = j[9]; } else addPlayer(j);
        fresh.add(j[0]);
      }
      let bad = false;
      const now = performance.now();
      for (const a of m.p) {
        const [id, x, y, dir, vel, rub, base, count, tx, ty, np, brk, grind, brake, speed, sc, kills, rev] = a;
        const p = players.get(id);
        if (!p) { bad = true; continue; }
        if (!fresh.has(id)) {
          if (rev !== p.rev) bad = true;
          else {
            const drop = base - p.base;
            if (drop > 0) p.pts.splice(0, drop);
            p.base = base;
            tri(np, p.pts);
          }
        }
        if (p.pts.length !== count) bad = true;
        if (p.pts.length) { p.pts[0][0] = tx; p.pts[0][1] = ty; }
        Object.assign(p, { x, y, dir, vel, rubber: rub, brk, grind, brake, speed, score: sc, kills, t: now });
      }
      for (const [id, x, y] of m.d) {
        const p = players.get(id);
        blast(x, y, p ? p.color : '#ffffff');
        if (p) { explode(x, y, p.color, p); players.delete(id); }
      }
      lb = m.lb; online = m.n;
      if (m.rc) rc = m.rc;
      if (m.g) {
        const ph = m.g[0];
        if (prevPhase === 0 && ph === 1) goUntil = now + 1000;
        prevPhase = ph;
        for (let t = 0; t < 2; t++) {
          const c = m.g[2 + t] || 0;
          if (c > prevCap[t] + 1e-4) capRise[t] = now;
          prevCap[t] = c;
        }
        g = m.g;
      } else g = null;
      if (bad) { awaitingInit = true; send({ t: 'resync' }); }
    } else if ((m.t === 'team' || m.t === 'you') && !joined) {
      // stale team/spawn message that crossed a leave or mode switch: ignore
    } else if (m.t === 'team') {
      myTeam = m.team; waiting = true; alive = false; toastUntil = 0;
      $('death').style.display = 'none';
      hideMenu();
    } else if (m.t === 'you') {
      myId = m.id; alive = true; waiting = false; mapLock = false; hideMenu();
    } else if (m.t === 'dead') {
      alive = false;
      if (mode === 'fort') {
        $('toastTxt').textContent = `Derezzed by ${m.by}`;
        toastUntil = performance.now() + 2600;
      } else {
        $('deathWhy').textContent = `Crashed into ${m.by}`;
        $('deathScore').textContent = `score ${m.score} · ${m.kills} kills · ${m.time}s alive`;
        $('death').style.display = 'block';
        setTimeout(() => { if (!alive) showMenu(); }, 1100);
      }
    }
  }

  // ---- menu ----
  const menuOpen = () => !$('menu').classList.contains('hidden');
  function showMenu() {
    $('menu').classList.remove('hidden'); document.body.classList.remove('ingame'); $('hud').classList.remove('on');
    setTimeout(() => $('name').focus(), 50);
  }
  function hideMenu() {
    $('menu').classList.add('hidden'); document.body.classList.add('ingame'); $('hud').classList.toggle('on', alive); $('name').blur();
  }
  function play() {
    const name = $('name').value.trim();
    store.set('ll_name', name); store.set('ll_color', myColor); store.set('ll_mode', selMode);
    joined = true;
    send({ t: 'join', name, color: myColor, mode: selMode });
  }
  $('play').onclick = play;
  // fort: leave the team and go back to spectating from the menu
  function leave() {
    send({ t: 'leave' });
    joined = false; alive = false; myId = null; myTeam = -1; waiting = false; toastUntil = 0; specId = null;
    $('death').style.display = 'none';
    showMenu();
  }
  $('fmenu').addEventListener('click', e => { e.stopPropagation(); $('fmenu').blur(); leave(); });
  $('fmenu').addEventListener('touchstart', e => e.stopPropagation(), { passive: true });

  // ---- spectating (fort team, not alive) ----
  const byId = (a, b) => (a.id > b.id) - (a.id < b.id);
  const canSpec = () => !alive && mode === 'fort' && myTeam >= 0 && !menuOpen();
  function specList() {
    const all = [...players.values()], mine = all.filter(p => p.team === myTeam);
    return (mine.length ? mine : all).sort(byId);
  }
  function specTarget() {
    const l = specList();
    if (!l.length) return null;
    let t = players.get(specId);
    if (!t || !l.includes(t)) { t = l[0]; specId = t.id; }
    return t;
  }
  function specStep(d) {
    const l = specList();
    if (!l.length) return;
    let i = l.findIndex(p => p.id === specId);
    i = i < 0 ? 0 : (i + d + l.length) % l.length;
    specId = l[i].id;
  }

  // ---- input ----
  const ABS = { ArrowRight: 0, ArrowDown: 1, ArrowLeft: 2, ArrowUp: 3 };
  addEventListener('keydown', e => {
    if (menuOpen()) { if (e.key === 'Enter') play(); return; }
    if (e.key === 'Escape' && mode === 'fort') { if (!e.repeat) leave(); return; }
    if (e.key in ABS || e.key === ' ' || e.key === 'Tab') e.preventDefault();
    if (e.key === 'Tab') { mapHeld = true; return; }
    if ((e.key === 'm' || e.key === 'M') && !e.repeat) { mapLock = !mapLock; return; }
    if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') { setZoom(zoomT / 1.15); return; }
    if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') { setZoom(zoomT * 1.15); return; }
    if (canSpec() && !e.repeat && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { specStep(e.key === 'ArrowLeft' ? -1 : 1); return; }
    if (!alive) return;
    if (e.key === ' ') { if (!e.repeat) send({ t: 'brake', on: true }); return; }
    if (e.repeat) return;
    if (e.key in ABS) send({ t: 'turn', abs: ABS[e.key] });
    else if (e.key === 'a' || e.key === 'A' || e.key === 'q' || e.key === 'Q') send({ t: 'turn', rel: -1 });
    else if (e.key === 'd' || e.key === 'D' || e.key === 'e' || e.key === 'E') send({ t: 'turn', rel: 1 });
  });
  addEventListener('keyup', e => { if (e.key === ' ') send({ t: 'brake', on: false }); if (e.key === 'Tab') mapHeld = false; });
  addEventListener('blur', () => { mapHeld = false; });
  function setZoom(z) { zoomT = Math.max(0.6, Math.min(3, z)); store.set('ll_zoom', zoomT.toFixed(3)); }
  cv.addEventListener('wheel', e => { e.preventDefault(); setZoom(zoomT * Math.exp(e.deltaY * (e.deltaMode === 1 ? 33 : 1) * 0.0012)); }, { passive: false });
  const mb = $('mapBtn');
  mb.addEventListener('click', e => { e.stopPropagation(); mapLock = !mapLock; mb.blur(); });
  mb.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
  let tStart = null;
  cv.addEventListener('touchstart', e => { const t = e.changedTouches[0]; tStart = { x: t.clientX, y: t.clientY }; e.preventDefault(); }, { passive: false });
  cv.addEventListener('touchend', e => {
    if (!tStart) return;
    if (!alive) {
      if (canSpec()) specStep(e.changedTouches[0].clientX < W / 2 ? -1 : 1);
      tStart = null; return;
    }
    const t = e.changedTouches[0], dx = t.clientX - tStart.x, dy = t.clientY - tStart.y;
    if (Math.hypot(dx, dy) > 24) send({ t: 'turn', abs: Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3) });
    else send({ t: 'turn', rel: t.clientX < W / 2 ? -1 : 1 });
    tStart = null; e.preventDefault();
  }, { passive: false });
  cv.addEventListener('click', e => { if (canSpec()) specStep(e.clientX < W / 2 ? -1 : 1); });

  // ---- fx ----
  function explode(x, y, color, p) {
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2, s = 6 + Math.random() * 38;
      parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.6 + Math.random() * 0.9, max: 1.5, color, w: 0.25 + Math.random() * 0.35 });
    }
    // shatter the trail into falling fragments
    if (p) {
      const pts = p.pts.concat([[x, y, 0]]);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (b[2]) continue;
        const len = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
        const n = Math.min(40, Math.ceil(len / 4));
        for (let k = 0; k < n; k++) {
          const f = Math.random();
          if (parts.length > 2500) break;
          parts.push({ x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, vx: (Math.random() - .5) * 4, vy: (Math.random() - .5) * 4,
            life: 0.4 + Math.random() * 0.6, max: 1, color, w: 0.35 });
        }
      }
    }
  }
  function blast(x, y, color) {
    blasts.push({ x, y, r: HOLE, t: 0, color });
    for (let i = 0; i < 48; i++) {
      const a = Math.random() * Math.PI * 2, s = HOLE * (1.4 + Math.random() * 1.2);
      parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.35 + Math.random() * 0.4, max: 0.75, color: i & 1 ? '#ffd27a' : color, w: 0.3 });
    }
  }
  // trace a trail path, breaking at gap segments and (optionally) segments outside the cull box
  let cx0 = 0, cx1 = 0, cy0 = 0, cy1 = 0;
  function trace(c, p, cull) {
    const pts = p.pts; let pen = true;
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (b[2] || (cull && (Math.max(a[0], b[0]) < cx0 || Math.min(a[0], b[0]) > cx1 || Math.max(a[1], b[1]) < cy0 || Math.min(a[1], b[1]) > cy1))) { pen = false; continue; }
      if (!pen) c.moveTo(a[0], a[1]);
      c.lineTo(b[0], b[1]); pen = true;
    }
    const l = pts[pts.length - 1];
    if (!pen) c.moveTo(l[0], l[1]);
    c.lineTo(p.rx, p.ry);
  }
  function sparks(p) {
    if (Math.random() > p.grind * 0.9) return;
    const back = (p.dir + 2) % 4;
    for (let i = 0; i < 2; i++) parts.push({ x: p.rx, y: p.ry, vx: DX[back] * (8 + Math.random() * 12) + (Math.random() - .5) * 10,
      vy: DY[back] * (8 + Math.random() * 12) + (Math.random() - .5) * 10, life: 0.25 + Math.random() * 0.25, max: 0.5, color: '#ffd27a', w: 0.18 });
  }

  // fort zones; px = CSS pixels per world unit (line widths are given in pixels)
  function drawZones(c, px, now, small) {
    if (!fort || !fort.zones) return;
    const TAU = Math.PI * 2, top = -Math.PI / 2;
    for (const [x, y, r, t] of fort.zones) {
      const col = teamCol(t), atk = teamCol(1 - t), cap = g ? Math.max(0, Math.min(1, g[2 + t] || 0)) : 0;
      const pulsing = now - capRise[t] < 400, pl = pulsing ? 0.5 + 0.5 * Math.sin(now / 60) : 0;
      c.beginPath(); c.arc(x, y, r, 0, TAU);
      c.fillStyle = col; c.globalAlpha = small ? 0.16 : 0.06 + pl * 0.05; c.fill();
      c.strokeStyle = col;
      if (!small) { c.globalAlpha = 0.18; c.lineWidth = 9 / px; c.stroke(); }
      c.globalAlpha = 0.8; c.lineWidth = (small ? 1 : 2) / px; c.stroke();
      if (cap > 0.002) {
        c.beginPath(); c.arc(x, y, r, top, top + cap * TAU);
        c.strokeStyle = atk;
        if (!small) { c.globalAlpha = 0.3 + 0.35 * pl; c.lineWidth = 16 / px; c.stroke(); }
        c.globalAlpha = 1; c.lineWidth = (small ? 2.5 : 5) / px; c.stroke();
        if (pulsing && !small) {               // expanding warning ring while the enemy is gaining
          const k = (now % 700) / 700;
          c.beginPath(); c.arc(x, y, r * (1 + 0.25 * k), 0, TAU);
          c.globalAlpha = 0.5 * (1 - k); c.lineWidth = 2 / px; c.stroke();
        }
      }
    }
    c.globalAlpha = 1;
  }

  // ---- render ----
  let lastFrame = performance.now(), lastDom = 0, lastMini = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - lastFrame) / 1000); lastFrame = now;

    for (const p of players.values()) {
      const e = Math.min((now - p.t) / 1000, 0.06);
      p.rx = Math.max(0, Math.min(ARENA, p.x + DX[p.dir] * p.vel * e));
      p.ry = Math.max(0, Math.min(ARENA, p.y + DY[p.dir] * p.vel * e));
      if (p.grind > 0.05 && p.vel > 0) sparks(p);
    }

    // camera
    const me = myId != null ? players.get(myId) : null;
    let tx, ty, tz;
    if (me && alive) { tx = me.rx; ty = me.ry; tz = 110 + (me.speed - 22) * 1.4; }
    else {
      let tgt;
      if (mode === 'fort' && myTeam >= 0) tgt = specTarget();
      else {
        tgt = lb.length ? players.get(lb[0][3]) : null;
        if (!tgt && mode === 'fort') tgt = [...players.values()].sort(byId)[0];
      }
      if (tgt) { tx = tgt.rx; ty = tgt.ry; tz = 170; }
      else {
        tx = ARENA / 2; ty = ARENA / 2;
        tz = mode === 'fort' ? Math.max(W, H) * ARENA / (0.9 * Math.min(W, H)) / zoomCur : 260;   // whole arena in view
      }
    }
    const k = me && alive ? 1 : Math.min(1, dt * 3);
    cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k; cam.z += (tz - cam.z) * Math.min(1, dt * 2);
    zoomCur += (zoomT - zoomCur) * Math.min(1, dt * 8);
    mapK += ((mapHeld || mapLock ? 1 : 0) - mapK) * Math.min(1, dt * 6);
    if (mapOn !== mapK > 0.5) { mapOn = !mapOn; mini.classList.toggle('off', mapOn); }
    const ez = mapK * mapK * (3 - 2 * mapK);
    const sN = Math.max(W, H) / (cam.z * zoomCur), sM = Math.min(W, H) * 0.9 / ARENA;
    const scale = Math.exp(Math.log(sN) + (Math.log(sM) - Math.log(sN)) * ez);
    const vx = cam.x + (ARENA / 2 - cam.x) * ez, vy = cam.y + (ARENA / 2 - cam.y) * ez;

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#04060c'; ctx.fillRect(0, 0, W, H);
    ctx.setTransform(DPR * scale, 0, 0, DPR * scale, DPR * (W / 2 - vx * scale), DPR * (H / 2 - vy * scale));

    // grid
    const x0 = vx - W / 2 / scale, x1 = vx + W / 2 / scale, y0 = vy - H / 2 / scale, y1 = vy + H / 2 / scale;
    cx0 = x0 - 4; cx1 = x1 + 4; cy0 = y0 - 4; cy1 = y1 + 4;
    ctx.fillStyle = '#060b16'; ctx.fillRect(0, 0, ARENA, ARENA);
    for (const [stepU, col, lw] of [[10, 'rgba(0,240,255,0.06)', 0.08], [50, 'rgba(0,240,255,0.14)', 0.14]]) {
      if (stepU * scale < 5) continue;
      ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
      for (let gx = Math.max(0, Math.ceil(x0 / stepU) * stepU); gx <= Math.min(ARENA, x1); gx += stepU) { ctx.moveTo(gx, Math.max(0, y0)); ctx.lineTo(gx, Math.min(ARENA, y1)); }
      for (let gy = Math.max(0, Math.ceil(y0 / stepU) * stepU); gy <= Math.min(ARENA, y1); gy += stepU) { ctx.moveTo(Math.max(0, x0), gy); ctx.lineTo(Math.min(ARENA, x1), gy); }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'lighter';
    drawZones(ctx, scale, now, false);
    ctx.strokeStyle = 'rgba(0,240,255,0.25)'; ctx.lineWidth = 2.2; ctx.strokeRect(0, 0, ARENA, ARENA);
    ctx.strokeStyle = 'rgba(160,250,255,0.9)'; ctx.lineWidth = 0.5; ctx.strokeRect(0, 0, ARENA, ARENA);

    // trails
    ctx.lineJoin = 'miter'; ctx.lineCap = 'butt';
    for (const p of players.values()) {
      if (!p.pts.length) continue;
      ctx.beginPath(); trace(ctx, p, true);
      ctx.strokeStyle = p.color;
      if (scale > 4) { ctx.globalAlpha = 0.16; ctx.lineWidth = 2.6; ctx.stroke(); }   // widest glow: costly, skip when far out
      ctx.globalAlpha = 0.9; ctx.lineWidth = Math.max(0.6, 1.2 / scale); ctx.stroke();
      ctx.strokeStyle = '#ffffff'; ctx.globalAlpha = 0.55; ctx.lineWidth = 0.16; ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // cycles
    for (const p of players.values()) {
      ctx.save(); ctx.translate(p.rx, p.ry); ctx.rotate(p.dir * Math.PI / 2);
      ctx.fillStyle = p.color; ctx.globalAlpha = 0.25; ctx.fillRect(-3.2, -1.4, 4.4, 2.8);
      ctx.globalAlpha = 1; ctx.fillRect(-2.4, -0.7, 2.8, 1.4);
      ctx.fillStyle = '#fff'; ctx.fillRect(0.0, -0.35, 0.6, 0.7);
      ctx.restore();
      if (p.vel === 0 && p.rubber < 1) {       // rubber pressing a wall
        const pulse = 0.5 + 0.5 * Math.sin(now / 40);
        ctx.strokeStyle = `rgba(255,60,60,${0.4 + 0.5 * pulse})`; ctx.lineWidth = 0.35;
        ctx.beginPath(); ctx.arc(p.rx, p.ry, 2.2 + (1 - p.rubber) * 2.5, 0, Math.PI * 2); ctx.stroke();
      }
    }
    // map-view head dots
    if (mapK > 0.05) {
      ctx.globalAlpha = Math.min(1, mapK * 1.5);
      for (const p of players.values()) {
        ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.rx, p.ry, 4 / scale, 0, Math.PI * 2); ctx.fill();
        if (p.id === myId) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 / scale; ctx.beginPath(); ctx.arc(p.rx, p.ry, 7 / scale, 0, Math.PI * 2); ctx.stroke(); }
      }
      ctx.globalAlpha = 1;
    }
    // blasts: expanding ring showing the punched hole
    for (let i = blasts.length - 1; i >= 0; i--) {
      const b = blasts[i]; b.t += dt;
      if (b.t > 0.9) { blasts.splice(i, 1); continue; }
      const g = Math.min(1, b.t / 0.3), r = b.r * (1 - (1 - g) ** 3), al = 1 - b.t / 0.9;
      ctx.beginPath(); ctx.arc(b.x, b.y, Math.max(0.01, r), 0, Math.PI * 2);
      ctx.fillStyle = b.color; ctx.globalAlpha = 0.08 * al; ctx.fill();
      ctx.strokeStyle = b.color; ctx.globalAlpha = 0.35 * al; ctx.lineWidth = Math.max(1.6, 3 / scale); ctx.stroke();
      ctx.strokeStyle = '#ffffff'; ctx.globalAlpha = 0.9 * al; ctx.lineWidth = Math.max(0.3, 1 / scale); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // particles
    for (let i = parts.length - 1; i >= 0; i--) {
      const q = parts[i]; q.life -= dt;
      if (q.life <= 0) { parts.splice(i, 1); continue; }
      q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 0.96; q.vy *= 0.96;
      ctx.globalAlpha = Math.min(1, q.life / q.max * 1.5); ctx.fillStyle = q.color;
      ctx.fillRect(q.x - q.w / 2, q.y - q.w / 2, q.w, q.w);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';

    // names (screen space)
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (fort && fort.zones) {
      ctx.font = '700 10px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center';
      for (const [zx, zy, zr, t] of fort.zones) {
        const sx = (zx - vx) * scale + W / 2, sy = (zy - vy) * scale + H / 2 - zr * scale - 8;
        if (sx < -80 || sx > W + 80 || sy < -20 || sy > H + 20) continue;
        const cap = g ? g[2 + t] || 0 : 0;
        ctx.fillStyle = teamCol(t); ctx.globalAlpha = 0.85;
        ctx.fillText(teamName(t) + (cap > 0.005 ? `  ${Math.round(cap * 100)}%` : ''), sx, sy);
      }
      ctx.globalAlpha = 1;
    }
    ctx.font = mapOn ? '600 10px ui-monospace, Menlo, monospace' : '600 12px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center';
    const nOff = mapOn ? 10 : 2.6 * scale + 6;
    for (const p of players.values()) {
      const sx = (p.rx - vx) * scale + W / 2, sy = (p.ry - vy) * scale + H / 2;
      if (sx < -50 || sx > W + 50 || sy < -50 || sy > H + 50) continue;
      ctx.fillStyle = p.id === myId ? (mode === 'fort' && myTeam >= 0 ? teamCol(myTeam) : '#ffffff') : 'rgba(207,233,255,.75)';
      ctx.fillText(p.name, sx, sy - nOff);
    }

    if (!mapOn && now - lastMini > 100) { lastMini = now; drawMini(); }
    if (now - lastDom > 100) { lastDom = now; updateDom(me, now); }
  }

  function drawMini() {
    const w = mini.width, h = mini.height, s = w / ARENA;
    mctx.setTransform(1, 0, 0, 1, 0, 0); mctx.clearRect(0, 0, w, h);
    mctx.setTransform(s, 0, 0, s, 0, 0);
    drawZones(mctx, s / DPR, performance.now(), true);
    mctx.lineWidth = 1.6 / s * DPR;
    for (const p of players.values()) {
      if (!p.pts.length) continue;
      mctx.strokeStyle = p.color; mctx.globalAlpha = p.id === myId ? 1 : 0.55;
      mctx.beginPath(); trace(mctx, p, false); mctx.stroke();
    }
    mctx.globalAlpha = 1;
    const me = players.get(myId);
    if (me && alive) { mctx.fillStyle = '#fff'; mctx.beginPath(); mctx.arc(me.rx, me.ry, 4 / s * DPR / 2, 0, Math.PI * 2); mctx.fill(); }
    mctx.strokeStyle = 'rgba(0,240,255,.25)'; mctx.lineWidth = 1 / s; mctx.strokeRect(0, 0, ARENA, ARENA);
  }

  const mmss = s => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const dots = (n, col) => { n = Math.max(0, n | 0); const k = Math.min(n, 8);
    return `<i style="background:${col};box-shadow:0 0 5px ${col}"></i>`.repeat(k) + (n > k ? `<em>+${n - k}</em>` : '') + (n ? '' : '<em>0</em>'); };
  const setTxt = (id, v) => { const el = $(id); v = String(v); if (el.textContent !== v) el.textContent = v; return el; };
  function updateDom(me, now) {
    const inFort = mode === 'fort', ingame = !menuOpen();
    $('online').textContent = online;
    setTxt('rcFfa', rc.ffa ?? 0); setTxt('rcFort', rc.fort ?? 0);
    $('lbList').innerHTML = lb.map((r, i) =>
      `<li class="${r[3] === myId ? 'me' : ''}"><span class="rk">${i + 1}</span>${inFort && r[5] >= 0 ? `<span class="tdot" style="background:${teamCol(r[5])}"></span>` : ''}<span class="n" style="color:${r[2]}">${esc(r[0])}</span><span>${r[1]}</span></li>`).join('');
    $('hud').classList.toggle('on', ingame && alive);
    const tint = inFort && alive && myTeam >= 0 ? teamCol(myTeam) : '';
    $('hud').style.borderColor = tint; $('hud').style.boxShadow = tint ? `0 0 14px ${tint}55` : '';
    const tt = setTxt('teamTag', tint ? teamName(myTeam) : ''); tt.style.color = tint; tt.style.display = tint ? '' : 'none';
    $('fmenu').style.display = inFort && ingame ? '' : 'none';
    // notices
    const nt = $('notice');
    if (inFort && ingame && waiting && !alive && myTeam >= 0) {
      nt.innerHTML = `Joined <b style="color:${teamCol(myTeam)}">${esc(teamName(myTeam))}</b> — waiting for next round`; nt.style.display = '';
    } else nt.style.display = 'none';
    $('toast').style.display = inFort && now < toastUntil ? '' : 'none';
    const spT = canSpec() ? players.get(specId) : null;
    if (spT && !waiting) {
      $('spec').innerHTML = `spectating <b style="color:${spT.color}">${esc(spT.name)}</b> · ${matchMedia('(pointer: coarse)').matches ? 'tap' : '←/→'} to switch`;
      $('spec').style.display = '';
    } else $('spec').style.display = 'none';
    // fort HUD + phase banners
    const fh = $('fhud'), bn = $('banner');
    if (inFort && g) {
      const [ph, tl, , , w0, w1, a0, a1, win, why] = g;
      fh.style.display = '';
      setTxt('fn0', teamName(0)).style.color = teamCol(0); setTxt('fn1', teamName(1)).style.color = teamCol(1);
      setTxt('fw0', w0 ?? 0).style.color = teamCol(0); setTxt('fw1', w1 ?? 0).style.color = teamCol(1);
      setTxt('ftime', ph === 1 ? mmss(tl) : ph === 0 ? 'READY' : 'END');
      const d0 = dots(a0, teamCol(0)), d1 = dots(a1, teamCol(1));
      if ($('fa0').innerHTML !== d0) $('fa0').innerHTML = d0;
      if ($('fa1').innerHTML !== d1) $('fa1').innerHTML = d1;
      let big = '', sub = '', col = '#ffffff';
      if (ph === 0) { big = String(Math.max(1, Math.ceil(tl))); sub = 'round starting'; }
      else if (ph === 1 && now < goUntil) big = 'GO';
      else if (ph === 2) {
        if (win === 0 || win === 1) { big = `${teamName(win)} WINS`; col = teamCol(win); }
        else big = win === 2 ? 'DRAW' : 'ROUND OVER';
        sub = REASON[why] || '';
      }
      if (big) {
        const bb = $('bannerBig');
        if (bb.textContent !== big) { bb.textContent = big; bb.classList.remove('pop'); void bb.offsetWidth; bb.classList.add('pop'); }
        bb.style.color = col; bb.style.textShadow = `0 0 18px ${col}, 0 0 40px ${col}`;
        setTxt('bannerSub', sub);
        bn.style.display = '';
      } else { bn.style.display = 'none'; $('bannerBig').textContent = ''; }
    } else { fh.style.display = 'none'; bn.style.display = 'none'; $('bannerBig').textContent = ''; }
    if (me && alive) {
      $('spdTxt').textContent = Math.round(me.speed);
      $('spdBar').firstElementChild.style.width = Math.min(100, (me.speed - 10) / 52 * 100) + '%';
      $('rubberBar').firstElementChild.style.width = (me.rubber * 100) + '%';
      $('rubberBar').classList.toggle('warn', me.rubber < 0.99);
      $('brakeBar').firstElementChild.style.width = (me.brake * 100) + '%';
      $('scoreTxt').textContent = me.score ?? 0;
      $('killTxt').textContent = me.kills ?? 0;
      $('grind').style.opacity = me.grind > 0.05 ? 1 : 0;
    } else $('grind').style.opacity = 0;
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  connect();
  requestAnimationFrame(frame);
})();
