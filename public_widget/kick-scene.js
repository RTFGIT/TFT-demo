/**
 * kick-scene.js — the conversion kick, the widget's reward for every pledge.
 *
 * A small canvas "broadcast camera" standing behind the kicker, looking down the
 * pitch at the posts. Everything is drawn from a simple 3-D world (metres) through
 * one perspective projection, so the ball genuinely shrinks as it travels away,
 * its shadow tracks along the grass, and it passes between the uprights and over
 * the crossbar where they really are.
 *
 *   createKickScene(canvas, { ballSrc, onContact, onGoal, onDone })
 *     .kick({ big })    play one kick (big = milestone: more confetti, longer)
 *     .refresh()        re-read theme colours and redraw (after a theme switch)
 *
 * Colours come from CSS custom properties on the canvas (see pledge-widget.html,
 * --scene-*), so each visual direction restyles the pitch without code changes.
 * The loop only runs while something is moving; an idle scene costs nothing.
 */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp  = (a, b, t) => a + (b - a) * t;
const easeOutBack = (t) => { const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

// World (metres). The camera sits behind the ball at eye height.
const CAM_H     = 1.4;     // behind the kicker, low — with a low horizon so the arc has sky to climb into
const POSTS_Z   = 38;      // distance from camera to the posts
const POST_GAP  = 5.6;     // rugby league: 5.5 m between uprights
const BAR_H     = 3.0;     // crossbar height
const UPRIGHT_H = 11;      // runs off the top of frame — as it does on TV
const BALL_SIZE = 1.0;     // exaggerated (real ≈ 0.28 m) so it reads at small sizes
const STAND_Z   = POSTS_Z + 16;

// Timeline (ms)
const WINDUP   = 140;
const FLIGHT   = 1350;
const RESPAWN  = 2350;

export function createKickScene(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ball = new Image();
  let ballReady = false;
  ball.onload = () => { ballReady = true; draw(performance.now()); };
  ball.src = opts.ballSrc;

  let W = 0, H = 0, dpr = 1, f = 300, cx = 0, hy = 0, Z0 = 5;
  let theme = {};
  let crowd = [];              // stand dots, regenerated on resize
  let kick = null;             // the active kick, or null
  let particles = [];          // confetti + turf
  let glow = 0;                // post flash, 0..1
  let flashes = 0;             // crowd camera-flash intensity, 0..1
  let raf = 0;

  // ─── Geometry ─────────────────────────────────────────────────────────────
  function proj(X, Y, Z) {
    return { x: cx + f * X / Z, y: hy + f * (CAM_H - Y) / Z, s: f / Z };
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    f  = Math.min(W, 680) * 0.6;
    cx = W / 2;
    hy = H * 0.62;
    // Put the ball on its tee near the bottom edge, whatever the widget's size.
    Z0 = f * (CAM_H - 0.2) / (H - 20 - hy);
    seedCrowd();
    draw(performance.now());
  }

  function seedCrowd() {
    let s = 1234567;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const top = proj(0, 4.5, STAND_Z).y, base = proj(0, 0, STAND_Z).y;
    crowd = Array.from({ length: Math.round(W / 3.2) }, () => ({
      x: rnd() * W, y: lerp(top + 2, base - 2, rnd()), c: rnd(), tw: rnd() * TAU
    }));
  }

  function readTheme() {
    const cs = getComputedStyle(canvas);
    const v = (k, d) => (cs.getPropertyValue(k).trim() || d);
    theme = {
      skyTop:   v('--scene-sky-top', '#0b1530'),
      skyBot:   v('--scene-sky-bottom', '#23346b'),
      light:    v('--scene-light', 'rgba(255,255,255,.35)'),
      stand:    v('--scene-stand', '#0a0f1f'),
      crowd:    v('--scene-crowd', '#8fa3d9,#f2c14e,#e2e8f0').split(',').map(s => s.trim()),
      grassA:   v('--scene-grass-a', '#1f7a3a'),
      grassB:   v('--scene-grass-b', '#23883f'),
      lines:    v('--scene-lines', 'rgba(255,255,255,.75)'),
      posts:    v('--scene-posts', '#ffffff'),
      pads:     v('--scene-pads', '#ffd400'),
      glow:     v('--scene-glow', '#ffe066'),
      tee:      v('--scene-tee', '#ff7a1a'),
      confetti: v('--confetti', '#ffd400,#ffffff,#3ddc84,#4cc9f0,#ff5d8f').split(',').map(s => s.trim())
    };
  }

  // ─── Kick ─────────────────────────────────────────────────────────────────
  function startKick({ big = false } = {}) {
    if (!W) resize();
    const clearH = lerp(4.6, 5.4, Math.random());        // height as it passes the bar
    // Height as a function of progress u (0 at the tee, 1 at the posts): a
    // parabola peaking at u = 0.68, passing the posts at clearH.
    const peakU = 0.7;
    const b = (clearH - 0.2) / (2 * peakU - 1);
    kick = {
      t0: performance.now(), big, scored: false, contacted: false,
      a: 2 * peakU * b, b,
      aim: lerp(-1.3, 1.3, Math.random()),                 // where it crosses, inside the uprights
      hook: lerp(-0.7, 0.7, Math.random()),                // a little draw or fade in flight
      spin: lerp(4.2, 5.4, Math.random()) * (Math.random() < .5 ? -1 : 1),
      trail: []
    };
    if (reduceMotion || document.hidden) {                 // no flight — just the reward
      kick = null;
      opts.onContact?.();
      goal(big);
      return;
    }
    // requestAnimationFrame pauses in a hidden tab. The goal must still fire —
    // the widget's flow waits on it — so a timer guarantees it lands on time.
    const k = kick;
    const r = (POSTS_Z - Z0) / (POSTS_Z + 10 - Z0);
    const goalMs = WINDUP + (1 - Math.pow(1 - r, 1 / 1.35)) * FLIGHT;
    setTimeout(() => {
      if (kick !== k) return;
      if (!k.contacted) { k.contacted = true; opts.onContact?.(); }
      if (!k.scored) { k.scored = true; goal(big); }
    }, goalMs + 200);
    loop();
  }

  function ballState(k, now) {
    const t = clamp((now - k.t0 - WINDUP) / FLIGHT, 0, 1);
    const e = 1 - Math.pow(1 - t, 1.35);                   // slows with drag
    const Z = lerp(Z0, POSTS_Z + 10, e);
    const u = (Z - Z0) / (POSTS_Z - Z0);
    const Y = Math.max(0.2 + k.a * u - k.b * u * u, 0.15);
    const X = k.aim * u + k.hook * Math.sin(Math.PI * clamp(u, 0, 1) * 0.9);
    return { t, u, X, Y, Z };
  }

  function goal(big) {
    glow = 1;
    flashes = 1;
    burst(big);
    opts.onGoal?.({ big });
  }

  function burst(big) {
    if (reduceMotion) return;
    const n = big ? 200 : 90;
    const bar = proj(0, BAR_H + 1, POSTS_Z);
    for (let i = 0; i < n; i++) {
      // Half from the posts, half from two side "cannons" low in the frame.
      const src = i % 3;
      const x = src === 0 ? bar.x : src === 1 ? W * 0.04 : W * 0.96;
      const y = src === 0 ? bar.y : H * 0.9;
      const ang = src === 0 ? lerp(-Math.PI, 0, Math.random())
                : src === 1 ? lerp(-1.35, -0.75, Math.random())
                            : lerp(-2.4, -1.8, Math.random());
      const sp = src === 0 ? lerp(1.5, 5, Math.random()) : lerp(5.5, 9.5, Math.random()) * (big ? 1.15 : 1);
      particles.push({
        kind: 'confetti', x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        w: lerp(3, 7, Math.random()), h: lerp(5, 10, Math.random()),
        rot: Math.random() * TAU, vr: lerp(-.25, .25, Math.random()),
        wob: Math.random() * TAU, life: 1, decay: lerp(.004, .008, Math.random()),
        c: theme.confetti[i % theme.confetti.length]
      });
    }
  }

  function turf(x, y, s) {
    for (let i = 0; i < 14; i++) {
      const ang = lerp(-Math.PI * 0.95, -Math.PI * 0.05, Math.random());
      const sp = lerp(1, 3.4, Math.random()) * s;
      particles.push({
        kind: 'turf', x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 1,
        r: lerp(.8, 2.2, Math.random()), life: 1, decay: .04,
        c: Math.random() < .5 ? theme.grassA : theme.grassB
      });
    }
  }

  // ─── Loop ─────────────────────────────────────────────────────────────────
  function loop() {
    if (raf) return;
    const step = (now) => {
      raf = 0;
      const busy = update(now);
      draw(now);
      if (busy) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function update(now) {
    if (kick) {
      const el = now - kick.t0;
      if (!kick.contacted && el >= WINDUP) {
        kick.contacted = true;
        const tee = proj(0, 0, Z0);
        turf(tee.x, tee.y, tee.s / 40);
        opts.onContact?.();
      }
      const b = ballState(kick, now);
      if (!kick.scored && b.u >= 1) { kick.scored = true; goal(kick.big); }
      if (el > WINDUP) {
        kick.trail.unshift(b);
        kick.trail.length = Math.min(kick.trail.length, 5);
      }
      if (el >= RESPAWN + (kick.big ? 500 : 0)) {
        kick = { respawn: now };
        opts.onDone?.();
      }
    }
    if (kick?.respawn && now - kick.respawn > 380) kick = null;

    glow    = Math.max(0, glow - 0.02);
    flashes = Math.max(0, flashes - 0.012);
    for (const p of particles) {
      if (p.kind === 'confetti') {
        p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.12;
        p.wob += 0.15; p.x += p.vx + Math.sin(p.wob) * 0.6; p.y += p.vy;
        p.rot += p.vr;
      } else {
        p.vy += 0.35; p.x += p.vx; p.y += p.vy;
      }
      p.life -= p.decay;
    }
    particles = particles.filter(p => p.life > 0 && p.y < H + 20);
    return !!kick || particles.length > 0 || glow > 0 || flashes > 0;
  }

  // ─── Draw ─────────────────────────────────────────────────────────────────
  function draw(now) {
    if (!W) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Camera shake just after contact.
    if (kick && !kick.respawn) {
      const since = now - kick.t0 - WINDUP;
      if (since > 0 && since < 160) {
        const m = (1 - since / 160) * 2.2;
        ctx.translate((Math.random() - .5) * m, (Math.random() - .5) * m);
      }
    }

    drawSky();
    drawGrass();
    drawStand(now);
    drawLines();
    drawPosts();
    drawBall(now);
    drawParticles();
  }

  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, hy);
    g.addColorStop(0, theme.skyTop); g.addColorStop(1, theme.skyBot);
    ctx.fillStyle = g; ctx.fillRect(-4, -4, W + 8, hy + 8);
    // Floodlights (or sun) — soft glows high in the corners.
    for (const x of [W * 0.06, W * 0.94]) {
      const r = ctx.createRadialGradient(x, 0, 0, x, 0, W * 0.32);
      r.addColorStop(0, theme.light); r.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = r; ctx.fillRect(0, 0, W, hy);
    }
  }

  function drawGrass() {
    ctx.fillStyle = theme.grassA;
    ctx.fillRect(-4, hy, W + 8, H - hy + 4);
    // Mowing stripes every 5 m, drawn nearest-first down to the horizon.
    const zNear = f * CAM_H / (H - hy);
    for (let z = Math.floor(zNear / 5) * 5, k = 0; z < 160; z += 5, k++) {
      if (((z / 5) & 1) === 0) continue;
      const y1 = proj(0, 0, Math.max(z, zNear)).y, y2 = proj(0, 0, z + 5).y;
      ctx.fillStyle = theme.grassB;
      ctx.fillRect(-4, y2, W + 8, y1 - y2);
    }
  }

  function drawStand(now) {
    const top = proj(0, 4.5, STAND_Z).y, base = proj(0, 0, STAND_Z).y;
    ctx.fillStyle = theme.stand;
    ctx.fillRect(-4, top, W + 8, base - top);
    for (const d of crowd) {
      const flash = flashes > 0 && Math.random() < flashes * 0.08;
      ctx.globalAlpha = flash ? 1 : 0.55 + 0.25 * Math.sin(d.tw + now / 900);
      ctx.fillStyle = flash ? '#ffffff' : theme.crowd[Math.floor(d.c * theme.crowd.length)];
      const jump = flashes > 0 ? Math.sin(now / 70 + d.tw * 6) * 1.2 * flashes : 0;
      ctx.fillRect(d.x, d.y + jump, flash ? 2.2 : 1.6, flash ? 2.2 : 1.6);
    }
    ctx.globalAlpha = 1;
  }

  function lineZ(z, x1 = -34, x2 = 34, w = 0.12) {
    const a = proj(x1, 0, z), b = proj(x2, 0, z);
    ctx.lineWidth = Math.max(0.8, w * a.s);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }

  function drawLines() {
    ctx.strokeStyle = theme.lines;
    const zNear = f * CAM_H / (H - hy);
    for (const z of [POSTS_Z, POSTS_Z - 10, POSTS_Z - 20, POSTS_Z + 11]) {
      if (z > zNear) lineZ(z);
    }
    // Touchlines, converging toward the vanishing point.
    for (const X of [-34, 34]) {
      const a = proj(X, 0, zNear), b = proj(X, 0, POSTS_Z + 11);
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }

  function drawPosts() {
    const L = proj(-POST_GAP / 2, 0, POSTS_Z), R = proj(POST_GAP / 2, 0, POSTS_Z);
    const topY = proj(0, UPRIGHT_H, POSTS_Z).y, barY = proj(0, BAR_H, POSTS_Z).y;
    const w = Math.max(2, 0.2 * L.s);
    ctx.save();
    if (glow > 0) { ctx.shadowColor = theme.glow; ctx.shadowBlur = 18 * glow; }
    ctx.strokeStyle = glow > 0.05 ? mix(theme.posts, theme.glow, glow) : theme.posts;
    ctx.lineCap = 'round';
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(L.x, L.y); ctx.lineTo(L.x, topY);
    ctx.moveTo(R.x, R.y); ctx.lineTo(R.x, topY);
    ctx.moveTo(L.x - w * .2, barY); ctx.lineTo(R.x + w * .2, barY);
    ctx.stroke();
    ctx.restore();
    // Post protectors.
    const padH = 1.9 * L.s, padW = Math.max(4, 0.55 * L.s);
    ctx.fillStyle = theme.pads;
    for (const p of [L, R]) roundRect(p.x - padW / 2, p.y - padH, padW, padH, 2);
  }

  function drawBall(now) {
    if (!ballReady) return;
    // Ball on the tee: idle, winding up, or respawning.
    if (!kick || kick.respawn || now - kick.t0 < WINDUP) {
      const tee = proj(0, 0, Z0);
      drawTee(tee);
      let s = 1, sq = 1;
      if (kick?.respawn) s = easeOutBack(clamp((now - kick.respawn) / 380, 0, 1));
      else if (kick) sq = 1 - 0.1 * Math.sin(Math.PI * (now - kick.t0) / WINDUP);
      shadow(0, 0, Z0, 0.2);
      sprite(tee.x, proj(0, 0.2 + BALL_SIZE * 0.35, Z0).y, BALL_SIZE * tee.s * s, -0.25, sq, 1);
      return;
    }
    const tee = proj(0, 0, Z0);
    drawTee(tee);
    const b = ballState(kick, now);
    const fade = b.u > 1.12 ? clamp(1 - (b.u - 1.12) / 0.18, 0, 1) : 1;
    if (fade <= 0) return;
    shadow(b.X, 0, b.Z, b.Y);
    // Ghost trail (cheap motion blur).
    kick.trail.slice(1).forEach((g, i) => {
      const p = proj(g.X, g.Y, g.Z);
      sprite(p.x, p.y, BALL_SIZE * p.s, spinAngle(g), 1, fade * (0.22 - i * 0.05));
    });
    const p = proj(b.X, b.Y, b.Z);
    // End-over-end tumble: the silhouette stretches and shortens as it turns.
    const phase = b.t * kick.spin * TAU;
    const sq = 0.62 + 0.38 * Math.abs(Math.cos(phase));
    sprite(p.x, p.y, BALL_SIZE * p.s, spinAngle(b), sq, fade);
  }
  const spinAngle = (b) => -0.25 + b.t * (kick?.spin || 4) * 1.1;

  function drawTee(tee) {
    const w = 0.34 * tee.s, h = 0.2 * tee.s;
    ctx.fillStyle = theme.tee;
    ctx.beginPath();
    ctx.moveTo(tee.x - w / 2, tee.y); ctx.lineTo(tee.x + w / 2, tee.y);
    ctx.lineTo(tee.x + w * .22, tee.y - h); ctx.lineTo(tee.x - w * .22, tee.y - h);
    ctx.closePath(); ctx.fill();
  }

  function shadow(X, _Y, Z, height) {
    const g = proj(X, 0, Z);
    const rx = 0.42 * g.s * (1 + height * 0.04), ry = rx * 0.28;
    ctx.fillStyle = `rgba(0,0,0,${0.32 * clamp(1 - height / 9, 0.12, 1)})`;
    ctx.beginPath(); ctx.ellipse(g.x, g.y, rx, ry, 0, 0, TAU); ctx.fill();
  }

  function sprite(x, y, size, angle, squash, alpha) {
    if (alpha <= 0) return;
    const h = size, w = size * (ball.width / ball.height);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(1, squash);
    ctx.drawImage(ball, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = clamp(p.life * 1.6, 0, 1);
      ctx.fillStyle = p.c;
      if (p.kind === 'confetti') {
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.scale(1, Math.cos(p.wob));                 // flutter
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      } else {
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
    ctx.fill();
  }

  // Blend two CSS hex colours (only used for the post flash).
  function mix(a, b, t) {
    const pa = hex(a), pb = hex(b);
    if (!pa || !pb) return t > .5 ? b : a;
    const c = pa.map((v, i) => Math.round(lerp(v, pb[i], t)));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  function hex(s) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (!m) return null;
    let h = m[1]; if (h.length === 3) h = h.split('').map(c => c + c).join('');
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  }

  readTheme();
  new ResizeObserver(resize).observe(canvas);
  resize();

  return {
    kick: startKick,
    get busy() { return !!kick; },
    refresh() { readTheme(); seedCrowd(); draw(performance.now()); },
    /** Dev aid: render a fixed kick frozen at `ms` (window.__kick.preview(900)). */
    preview(ms, { big = false } = {}) {
      cancelAnimationFrame(raf); raf = 0;
      const peakU = 0.7, b = (5 - 0.2) / (2 * peakU - 1);
      kick = { t0: 0, big, scored: false, contacted: false, a: 2 * peakU * b, b,
               aim: 0.5, hook: 0.35, spin: 4.6, trail: [] };
      particles = []; glow = 0; flashes = 0;
      const quiet = opts; opts = {};                   // no sounds/callbacks while scrubbing
      for (let t = 0; t <= ms; t += 16) update(t);
      opts = quiet;
      draw(ms);
      kick = null;
    }
  };
}
