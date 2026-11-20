'use client';

import { forwardRef, useImperativeHandle, useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { Draggable } from 'gsap/Draggable';
import { CustomEase } from 'gsap/CustomEase';
import './magnetic-tag-cloud.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP, Draggable, CustomEase);
  CustomEase.create('annnimate', 'M0,0 C0.3,0.9 0.1,1 1,1');
  CustomEase.create('annnimateInOut', 'M0,0 C0.7,0 0.16,1 1,1');
}

const DEFAULT_TAGS = [
  { label: 'Road', href: '#', color: 'ink' },
  { label: 'Gravel', href: '#', color: 'outline' },
  { label: 'Padel', href: '#', color: 'outline' },
  { label: 'Tennis', href: '#', color: 'accent' },
  { label: 'Surf', href: '#', color: 'outline' },
  { label: 'Alpine', href: '#', color: 'outline' },
  { label: 'Swim', href: '#', color: 'ink' },
  { label: 'Climb', href: '#', color: 'outline' },
  { label: 'Track', href: '#', color: 'outline' },
  { label: 'Golf', href: '#', color: 'outline' },
];

function isDisabledOnViewport(disable) {
  if (!disable) return false;
  const breakpoints = {
    mobile: '(max-width: 479px)',
    landscape: '(orientation: landscape) and (max-width: 767px)',
    tablet: '(max-width: 991px)',
    desktop: '(min-width: 992px)',
  };
  return String(disable).split(',').some(function (v) {
    const q = breakpoints[v.trim()];
    return q && window.matchMedia(q).matches;
  });
}

/**
 * MagneticTagCloud Component
 * The tags sit packed together in the middle of the stage, each magnetised to
 * a home spot. Sweep the mouse through them and they get knocked outward -
 * harder the faster the mouse moves - tumbling a little and bumping into each
 * other before the magnet pulls every tag back home. A dragged or thrown tag
 * pushes its neighbours the same way.
 *
 * @param {string} [className=''] - Additional CSS classes for the wrapper
 * @param {Array<{label: string, href?: string, color?: string}>} [tags] - The tags; color is a modifier (ink, outline, accent)
 * @param {number} [gap=0] - Space between the tags at home (px)
 * @param {number} [maxRows=4] - How many rows the tags are packed into
 * @param {number} [hoverRadius=90] - How close the mouse has to come before it pushes a tag (px, 0 = off)
 * @param {number} [hoverStrength=1] - How hard a moving mouse knocks the tags away
 * @param {number} [spin=1] - How much the tags tilt when knocked (0 = level)
 * @param {number} [repelRadius=110] - How far away a moving tag starts pushing its neighbours (px)
 * @param {number} [repelStrength=60] - How far a touched neighbour gets pushed (px)
 * @param {number} [stiffness=180] - Spring strength pulling every tag home
 * @param {number} [damping=0.38] - Damping ratio: 1 lands dead, lower rings on the way home
 * @param {number} [throwStrength=1] - Multiplier on the release velocity of a thrown tag
 * @param {string} [disable=''] - Comma list of viewports to skip init on: mobile, landscape, tablet, desktop
 */
const MagneticTagCloud = forwardRef(function MagneticTagCloud({
  className = '',
  tags = DEFAULT_TAGS,
  gap = 0,
  maxRows = 4,
  hoverRadius = 90,
  hoverStrength = 1,
  spin = 1,
  repelRadius = 110,
  repelStrength = 60,
  stiffness = 180,
  damping = 0.38,
  throwStrength = 1,
  disable = '',
}, ref) {
  const wrapRef = useRef(null);
  const cloudRef = useRef(null);
  const tagRefs = useRef([]);
  const apiRef = useRef({});

  useImperativeHandle(ref, () => ({
    refresh: () => apiRef.current.refresh?.(),
    demo: () => (apiRef.current.demo ? apiRef.current.demo() : null),
  }), []);

  useGSAP((context, contextSafe) => {
    const container = wrapRef.current;
    if (!container || isDisabledOnViewport(disable)) return;

    // --- 1. Selectors ---
    const cloud = cloudRef.current;
    const tagEls = tagRefs.current.slice(0, tags.length).filter(Boolean);

    if (!cloud || !tagEls.length) return;

    // --- 2. Config ---
    const GAP = readNum(gap, 0, 0, 80);
    const MAX_ROWS = Math.round(readNum(maxRows, 4, 1, 12));
    const HOVER_RADIUS = readNum(hoverRadius, 90, 0, 300);
    const HOVER_STRENGTH = readNum(hoverStrength, 1, 0, 3);
    const SPIN = readNum(spin, 1, 0, 3);
    const REPEL_RADIUS = readNum(repelRadius, 110, 10, 400);
    const REPEL_STRENGTH = readNum(repelStrength, 60, 0, 200);
    const STIFFNESS = readNum(stiffness, 180, 20, 800);
    const DAMPING = readNum(damping, 0.38, 0.05, 1.5);
    const THROW_STRENGTH = readNum(throwStrength, 1, 0, 3);

    // --- 3. Constants ---
    // Critical damping is 2 * sqrt(k) for a unit mass, so DAMPING reads as a
    // ratio: 1 lands dead, lower values ring on the way home.
    const SPRING_C = 2 * DAMPING * Math.sqrt(STIFFNESS);
    // The same spring pulls the tilt back to level, so a tag lands and
    // straightens with one feel.
    const ROT_K = STIFFNESS;
    const ROT_C = SPRING_C;
    // While a released tag still travels AWAY from home its spring is softened
    // so a throw actually carries; the full spring takes over on the way back.
    const FLY_SOFTEN = 0.28;
    const FLY_K = STIFFNESS * FLY_SOFTEN;
    const FLY_C = 2 * DAMPING * Math.sqrt(FLY_K);
    // Braking that only acts while a tag has flown PAST home and is still
    // moving away (drag grows with speed squared). The return keeps the full
    // spring's snap, but a tag let go far away no longer overshoots in
    // proportion to the distance - the wobble stays small and elastic.
    const OVERSHOOT_BRAKE = 0.06;
    // A neighbour touching the magnet is pushed until the spring balances the
    // push, so strength x stiffness makes REPEL_STRENGTH a distance in px.
    const PUSH_K = REPEL_STRENGTH * STIFFNESS;
    // Hover push: acceleration per px/s of mouse speed at full reach, so a
    // slow drift nudges and a fast sweep knocks tags right out.
    const HOVER_FORCE = 6 * HOVER_STRENGTH;
    // How much the mouse's own direction steers the push (0 = straight away
    // from the cursor, higher = along the sweep).
    const SWEEP_MIX = 0.7;
    const CURSOR_MAX_SPEED = 4000;
    const CURSOR_SMOOTH = 0.5;
    const CURSOR_DECAY = 14;
    // Torque is scaled down from true rigid-body values - real pills would
    // spin like coins; this keeps the tumble to a readable tilt.
    const SPIN_SCALE = 0.14 * SPIN;
    const MAX_ROT = 0.5;
    const COLLIDE_K = 3000;
    const CONTACT_DAMP = 28;
    const PHYS_PAD = 4;
    const SUBSTEPS = 3;
    const MAX_FRAME_DT = 1 / 30;
    const MAX_SPEED = 3200;
    const VEL_SMOOTH = 0.35;
    const RETURN_DIST = 24;
    const WALL_BOUNCE = 0.45;
    const REST_SPEED = 2;
    const REST_SPIN = 0.02;
    const REST_DIST = 0.5;
    const REST_FRAMES = 8;
    const LIFT_SCALE = 1.06;
    const LIFT_DUR = 0.5;
    const DRAG_CLICK_PX = 4;
    // Fixed seeds: the irregular layout is the same on every load. Several
    // layouts are tried and the one where same-coloured tags touch least
    // wins, so the colours come out mixed.
    const LAYOUT_SEED = 7;
    const LAYOUT_TRIES = 24;
    const MIX_TOUCH = 12;
    const REST_TILT = 0.14;
    const DEAL_JITTER = 0.5;
    const ROW_SHIFT = 0.45;
    const FIT_MIN = 0.4;
    const RAD_TO_DEG = 180 / Math.PI;
    const DEMO_IN_DUR = 0.8;
    const DEMO_HOLD = 0.2;
    const DEMO_THROW_DUR = 0.55;
    const DEMO_THROW_BACK = 0.45;
    const DEMO_SETTLE_DUR = 1.4;
    const RESIZE_DEBOUNCE = 150;

    // --- 4. State ---
    const n = tagEls.length;
    const bodies = tagEls.map(function () {
      return {
        x: 0, y: 0, vx: 0, vy: 0, a: 0, va: 0, hx: 0, hy: 0, ha: 0, rx: 0, ry: 0,
        w: 0, h: 0, ew: 0, eh: 0, hw: 0, hh: 0, color: '', inertia: 1, held: false, src: null, magnet: false,
      };
    });
    const setX = tagEls.map(function (t) { return gsap.quickSetter(t, 'x', 'px'); });
    const setY = tagEls.map(function (t) { return gsap.quickSetter(t, 'y', 'px'); });
    const setRot = tagEls.map(function (t) { return gsap.quickSetter(t, 'rotation', 'deg'); });
    // Per-pair contact padding, capped at each pair's own gap at home, so a
    // tightly packed cloud never pushes itself off its homes while at rest.
    const restPad = new Float32Array(n * n);
    const g = { ux: 0, uy: 0, gap: 0 };
    const wall = { a: 0, b: 0 };
    const cursor = { on: false, x: 0, y: 0, vx: 0, vy: 0, t: 0 };
    const acc = { fx: 0, fy: 0, t: 0 };
    const cp = { x: 0, y: 0 };
    const demoPos = { x: 0, y: 0 };
    const demoPlan = { idx: -1, inX: 0, inY: 0, outX: 0, outY: 0 };
    let cloudPageX = 0;
    let cloudPageY = 0;
    let awake = false;
    let restFrames = 0;
    let reduced = false;
    let draggables = [];
    let lastDragDist = 0;
    let demoTl = null;
    let resizeTimer = null;
    let alive = true;

    // --- 5. Helpers ---
    function readNum(raw, fallback, min, max) {
      const v = parseFloat(raw);
      return isNaN(v) ? fallback : Math.max(min, Math.min(max, v));
    }

    function clamp(v, min, max) {
      return Math.max(min, Math.min(max, v));
    }

    function shuffle(list, rand) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const t = list[i];
        list[i] = list[j];
        list[j] = t;
      }
      return list;
    }

    // mulberry32 - a tiny seeded random, so "irregular" is repeatable.
    function seeded(seed) {
      let t = seed >>> 0;
      return function () {
        t = (t + 0x6d2b79f5) >>> 0;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
      };
    }

    // Spring pull toward home, plus the overshoot brake on the way out.
    function springForce(b, k, c, braking) {
      acc.fx = -k * (b.x - b.hx) - c * b.vx;
      acc.fy = -k * (b.y - b.hy) - c * b.vy;
      if (!braking) return;
      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      acc.fx -= OVERSHOOT_BRAKE * b.vx * speed;
      acc.fy -= OVERSHOOT_BRAKE * b.vy * speed;
    }

    // Edge-to-edge gap between two boxes and the unit normal that separates
    // them, pointing from box a to box b. Side by side the gap is the free
    // space on that axis; corner to corner it is the diagonal between the
    // corners; overlapping it goes negative along the shallower axis.
    function gapBetween(ax, ay, aw, ah, bx, by, bw, bh, out) {
      const dx = bx - ax;
      const dy = by - ay;
      const gx = Math.abs(dx) - (aw + bw) / 2;
      const gy = Math.abs(dy) - (ah + bh) / 2;
      const sx = dx < 0 ? -1 : 1;
      const sy = dy < 0 ? -1 : 1;
      if (gx > 0 && gy > 0) {
        out.gap = Math.sqrt(gx * gx + gy * gy);
        out.ux = (sx * gx) / out.gap;
        out.uy = (sy * gy) / out.gap;
      } else if (gx > gy) {
        out.gap = gx;
        out.ux = sx;
        out.uy = 0;
      } else {
        out.gap = gy;
        out.ux = 0;
        out.uy = sy;
      }
      return out;
    }

    // A force applied off-centre also turns the tag: torque = r x f, divided
    // by the box's moment of inertia (unit mass), scaled down to a tilt.
    function spinFrom(b, px, py, fx, fy) {
      const rx = px - b.x;
      const ry = py - b.y;
      return ((rx * fy - ry * fx) / b.inertia) * SPIN_SCALE;
    }

    // Where two boxes touch: on b's face along the normal, halfway across the
    // stretch the two boxes share on the other axis.
    function contactPoint(b, o, out) {
      if (g.uy === 0) {
        out.x = b.x - g.ux * b.ew / 2;
        out.y = (Math.max(b.y - b.eh / 2, o.y - o.eh / 2) + Math.min(b.y + b.eh / 2, o.y + o.eh / 2)) / 2;
      } else if (g.ux === 0) {
        out.y = b.y - g.uy * b.eh / 2;
        out.x = (Math.max(b.x - b.ew / 2, o.x - o.ew / 2) + Math.min(b.x + b.ew / 2, o.x + o.ew / 2)) / 2;
      } else {
        out.x = b.x - Math.sign(g.ux) * b.ew / 2;
        out.y = b.y - Math.sign(g.uy) * b.eh / 2;
      }
      return out;
    }

    // Homes come from rows, at most MAX_ROWS of them: tags are dealt out
    // widest first into whichever row is shortest so far (balanced rows), each
    // row is shuffled, the row order is shuffled, and every row is nudged
    // sideways by a random amount so the pack reads loose, not like a grid.
    function rowLayout(sizes, a, gap, seed, rowCount) {
      const rand = seeded(seed);
      const rows = [];
      for (let r = 0; r < rowCount; r++) rows.push({ items: [], w: -gap, h: 0 });
      const order = sizes
        .map(function (sz, i) { return { i: i, k: sz.w * (1 - DEAL_JITTER / 2 + rand() * DEAL_JITTER) }; })
        .sort(function (p, q) { return q.k - p.k; });
      order.forEach(function (o) {
        let row = rows[0];
        rows.forEach(function (r) { if (r.w < row.w) row = r; });
        row.items.push(o.i);
        row.w += sizes[o.i].w + gap;
        row.h = Math.max(row.h, sizes[o.i].h);
      });
      const used = rows.filter(function (r) { return r.items.length; });
      shuffle(used, rand);
      let avgW = 0;
      sizes.forEach(function (sz) { avgW += sz.w / sizes.length; });
      let totalH = -gap;
      let widest = 0;
      used.forEach(function (r) {
        totalH += r.h + gap;
        widest = Math.max(widest, r.w);
      });
      const pts = sizes.map(function () { return { x: 0, y: 0 }; });
      let y = -totalH / 2;
      used.forEach(function (r) {
        shuffle(r.items, rand);
        const room = Math.max(0, a - r.w / 2);
        let x = -r.w / 2 + (rand() * 2 - 1) * Math.min(avgW * ROW_SHIFT, room);
        r.items.forEach(function (i) {
          pts[i].x = x + sizes[i].w / 2;
          pts[i].y = y + r.h / 2;
          x += sizes[i].w + gap;
        });
        y += r.h + gap;
      });
      return { pts: pts, widest: widest };
    }

    // Size reads happen here only - on init, resize and font load - never in
    // the frame loop.
    function measure() {
      container.classList.add('is-live');
      const cs = window.getComputedStyle(cloud);
      wall.a = cloud.clientWidth / 2;
      wall.b = cloud.clientHeight / 2;
      bodies.forEach(function (b, i) {
        b.w = tagEls[i].offsetWidth;
        b.h = tagEls[i].offsetHeight;
        b.ew = b.w;
        b.eh = b.h;
        b.inertia = (b.w * b.w + b.h * b.h) / 12;
        b.color = window.getComputedStyle(tagEls[i]).backgroundColor;
        const c = Math.abs(Math.cos(b.ha));
        const sn = Math.abs(Math.sin(b.ha));
        b.hw = b.w * c + b.h * sn;
        b.hh = b.w * sn + b.h * c;
      });
      const r = cloud.getBoundingClientRect();
      cloudPageX = r.left + window.scrollX + r.width / 2;
      cloudPageY = r.top + window.scrollY + r.height / 2;
      return {
        a: wall.a - (parseFloat(cs.paddingLeft) || 0),
        b: wall.b - (parseFloat(cs.paddingTop) || 0),
      };
    }

    function colourClashes(pts, sizes) {
      let clashes = 0;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (bodies[i].color !== bodies[j].color) continue;
          gapBetween(pts[i].x, pts[i].y, sizes[i].w, sizes[i].h, pts[j].x, pts[j].y, sizes[j].w, sizes[j].h, g);
          if (g.gap < GAP + MIX_TOUCH) clashes++;
        }
      }
      return clashes;
    }

    function computeRestPads() {
      for (let i = 0; i < n; i++) {
        const bi = bodies[i];
        for (let j = i + 1; j < n; j++) {
          const bj = bodies[j];
          gapBetween(bi.hx, bi.hy, bi.hw, bi.hh, bj.hx, bj.hy, bj.hw, bj.hh, g);
          const pad = Math.min(PHYS_PAD, g.gap - 0.5);
          restPad[i * n + j] = pad;
          restPad[j * n + i] = pad;
        }
      }
    }

    function anyEngaged() {
      return bodies.some(function (b) { return b.held || b.magnet; });
    }

    // A tilted tag takes up more room: collide on its rotated bounding box.
    function updateExtents() {
      for (let i = 0; i < n; i++) {
        const b = bodies[i];
        const c = Math.abs(Math.cos(b.a));
        const s = Math.abs(Math.sin(b.a));
        b.ew = b.w * c + b.h * s;
        b.eh = b.w * s + b.h * c;
      }
    }

    // --- 6. Animation routines ---
    // Tries every seed and keeps the layout with the fewest same-coloured
    // neighbours, then the narrowest widest row.
    function bestLayout(box) {
      const sizes = bodies.map(function (b) { return { w: b.hw, h: b.hh }; });
      const rowCount = Math.min(MAX_ROWS, n);
      let best = null;
      let bestScore = Infinity;
      for (let t = 0; t < LAYOUT_TRIES; t++) {
        const lay = rowLayout(sizes, box.a, GAP, LAYOUT_SEED + t * 101, rowCount);
        const score = colourClashes(lay.pts, sizes) * 1e6 + lay.widest;
        if (score < bestScore) {
          bestScore = score;
          best = lay;
        }
      }
      return best;
    }

    // Capping the rows can make a row wider than the stage. Then every tag is
    // scaled down through --mtc-fit and laid out again at the smaller size.
    function relayout() {
      const tilt = seeded(LAYOUT_SEED + 1);
      bodies.forEach(function (b) { b.ha = (tilt() * 2 - 1) * REST_TILT; });
      container.style.setProperty('--mtc-fit', '1');
      let box = measure();
      let lay = bestLayout(box);
      if (lay.widest > box.a * 2) {
        const fit = Math.max(FIT_MIN, Math.floor((box.a * 2 / lay.widest) * 1000) / 1000);
        container.style.setProperty('--mtc-fit', String(fit));
        box = measure();
        lay = bestLayout(box);
      }
      const homes = lay.pts;
      cursor.on = false;
      bodies.forEach(function (b, i) {
        b.hx = homes[i].x;
        b.hy = homes[i].y;
        if (b.held) return;
        b.x = b.hx;
        b.y = b.hy;
        b.vx = 0;
        b.vy = 0;
        b.a = b.ha;
        b.va = 0;
        b.rx = 0;
        b.ry = 0;
        b.magnet = false;
        tagEls[i].style.zIndex = '';
      });
      computeRestPads();
      render();
      if (!anyEngaged()) sleep();
    }

    function render() {
      for (let i = 0; i < n; i++) {
        const b = bodies[i];
        setX[i](b.x);
        setY[i](b.y);
        setRot[i](b.a * RAD_TO_DEG);
      }
    }

    // The mouse is a moving pusher: every tag within reach of it is shoved
    // along a mix of "away from the cursor" and "the way the mouse is going",
    // scaled by mouse speed. The shove lands at the point of the tag nearest
    // the cursor, so it also sets the tag turning.
    function applyHover(b, acc) {
      const speed = Math.sqrt(cursor.vx * cursor.vx + cursor.vy * cursor.vy);
      if (speed < 1) return;
      const px = clamp(cursor.x, b.x - b.ew / 2, b.x + b.ew / 2);
      const py = clamp(cursor.y, b.y - b.eh / 2, b.y + b.eh / 2);
      const ddx = px - cursor.x;
      const ddy = py - cursor.y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d >= HOVER_RADIUS) return;
      let rx = b.x - cursor.x;
      let ry = b.y - cursor.y;
      const rl = Math.sqrt(rx * rx + ry * ry) || 1;
      rx = rx / rl + (cursor.vx / speed) * SWEEP_MIX;
      ry = ry / rl + (cursor.vy / speed) * SWEEP_MIX;
      const dl = Math.sqrt(rx * rx + ry * ry) || 1;
      const falloff = Math.pow(1 - d / HOVER_RADIUS, 2);
      const f = HOVER_FORCE * speed * falloff;
      const fx = (rx / dl) * f;
      const fy = (ry / dl) * f;
      acc.fx += fx;
      acc.fy += fy;
      acc.t += spinFrom(b, px, py, fx, fy);
      b.rx = 0;
      b.ry = 0;
    }

    function stepPhysics(dt) {
      updateExtents();
      const hovering = cursor.on && HOVER_RADIUS > 0 && HOVER_FORCE > 0;
      for (let i = 0; i < n; i++) {
        const b = bodies[i];
        acc.t = -ROT_K * (b.a - b.ha) - ROT_C * b.va;
        if (b.held) {
          b.va += acc.t * dt;
          continue;
        }
        const dx = b.x - b.hx;
        const dy = b.y - b.hy;
        const away = dx * b.vx + dy * b.vy > 0;
        // rx/ry remember which side of home the tag was coming back from, so
        // "moving away on the OTHER side" is an overshoot and gets braked. A
        // throw still flying out, or a tag knocked by the mouse, is not.
        const overshoot = away && dx * b.rx + dy * b.ry < 0;
        if (b.magnet && away && !overshoot) springForce(b, FLY_K, FLY_C, false);
        else springForce(b, STIFFNESS, SPRING_C, overshoot);
        if (!away) {
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > 1) {
            b.rx = dx / d;
            b.ry = dy / d;
          }
        }
        if (hovering) applyHover(b, acc);
        // A magnet only answers to its spring - it pushes, it is not pushed.
        if (!b.magnet) {
          for (let j = 0; j < n; j++) {
            if (j === i) continue;
            const o = bodies[j];
            gapBetween(o.x, o.y, o.ew, o.eh, b.x, b.y, b.ew, b.eh, g);
            let f = 0;
            if (o.held || o.magnet) {
              if (g.gap >= REPEL_RADIUS) continue;
              f = PUSH_K * Math.pow(1 - Math.max(0, g.gap) / REPEL_RADIUS, 2);
            } else {
              const pad = restPad[i * n + j];
              if (g.gap >= pad) continue;
              const closing = Math.min(0, (b.vx - o.vx) * g.ux + (b.vy - o.vy) * g.uy);
              f = (pad - g.gap) * COLLIDE_K - closing * CONTACT_DAMP;
            }
            acc.fx += g.ux * f;
            acc.fy += g.uy * f;
            contactPoint(b, o, cp);
            acc.t += spinFrom(b, cp.x, cp.y, g.ux * f, g.uy * f);
          }
        }
        b.vx += acc.fx * dt;
        b.vy += acc.fy * dt;
        b.va += acc.t * dt;
      }
      for (let i = 0; i < n; i++) {
        const b = bodies[i];
        b.a += b.va * dt;
        if (b.a > MAX_ROT || b.a < -MAX_ROT) {
          b.a = clamp(b.a, -MAX_ROT, MAX_ROT);
          b.va *= -WALL_BOUNCE;
        }
        if (b.held) continue;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        const lx = Math.max(0, wall.a - b.ew / 2);
        const ly = Math.max(0, wall.b - b.eh / 2);
        if (b.x > lx || b.x < -lx) { b.x = clamp(b.x, -lx, lx); b.vx *= -WALL_BOUNCE; }
        if (b.y > ly || b.y < -ly) { b.y = clamp(b.y, -ly, ly); b.vy *= -WALL_BOUNCE; }
      }
    }

    // Held tags follow their source (a Draggable, or the demo proxy). Their
    // velocity is measured here per frame - Draggable has no velocity getter
    // without InertiaPlugin, and the throw needs one.
    function followHeld(frameDt) {
      bodies.forEach(function (b) {
        if (!b.held) return;
        b.vx += ((b.src.x - b.x) / frameDt - b.vx) * VEL_SMOOTH;
        b.vy += ((b.src.y - b.y) / frameDt - b.vy) * VEL_SMOOTH;
        b.x = b.src.x;
        b.y = b.src.y;
      });
    }

    // A released magnet hands back to the pack once it is home and inbound.
    function retireMagnets() {
      bodies.forEach(function (b, i) {
        if (!b.magnet) return;
        const dx = b.x - b.hx;
        const dy = b.y - b.hy;
        if (dx * dx + dy * dy > RETURN_DIST * RETURN_DIST || dx * b.vx + dy * b.vy > 0) return;
        b.magnet = false;
        tagEls[i].style.zIndex = '';
      });
    }

    function isStill() {
      if (anyEngaged()) return false;
      if (cursor.vx * cursor.vx + cursor.vy * cursor.vy > 1) return false;
      return bodies.every(function (b) {
        return b.vx * b.vx + b.vy * b.vy < REST_SPEED * REST_SPEED && Math.abs(b.va) < REST_SPIN;
      });
    }

    function tick(time, deltaMs) {
      const frameDt = Math.min(deltaMs / 1000, MAX_FRAME_DT);
      if (frameDt <= 0) return;
      followHeld(frameDt);
      const dt = frameDt / SUBSTEPS;
      for (let s = 0; s < SUBSTEPS; s++) stepPhysics(dt);
      // Mouse speed fades once the mouse stops, so a resting cursor over the
      // cloud pushes nothing and the magnet wins.
      const decay = Math.exp(-CURSOR_DECAY * frameDt);
      cursor.vx *= decay;
      cursor.vy *= decay;
      retireMagnets();
      restFrames = isStill() ? restFrames + 1 : 0;
      if (restFrames >= REST_FRAMES) {
        bodies.forEach(function (b) {
          b.vx = 0;
          b.vy = 0;
          b.va = 0;
          if (Math.abs(b.x - b.hx) < REST_DIST && Math.abs(b.y - b.hy) < REST_DIST) {
            b.x = b.hx;
            b.y = b.hy;
          }
          if (Math.abs(b.a - b.ha) < REST_SPIN) b.a = b.ha;
        });
        render();
        sleep();
        return;
      }
      render();
    }

    function wake() {
      restFrames = 0;
      if (awake) return;
      awake = true;
      // Re-sync held tags so the first frame back measures no fake speed.
      bodies.forEach(function (b) {
        if (!b.held) return;
        b.x = b.src.x;
        b.y = b.src.y;
      });
      gsap.ticker.add(tick);
    }

    function sleep() {
      awake = false;
      gsap.ticker.remove(tick);
    }

    // contextSafe: grab/release tween after mount, from Draggable callbacks.
    const grab = contextSafe(function (i, src) {
      const b = bodies[i];
      b.held = true;
      b.src = src;
      b.magnet = false;
      b.vx = 0;
      b.vy = 0;
      tagEls[i].classList.add('is-active');
      tagEls[i].style.zIndex = '3';
      gsap.to(tagEls[i], { scale: LIFT_SCALE, duration: LIFT_DUR, ease: 'annnimate', overwrite: 'auto', force3D: true });
      wake();
    });

    const release = contextSafe(function (i) {
      const b = bodies[i];
      b.held = false;
      b.src = null;
      b.magnet = true;
      b.vx *= THROW_STRENGTH;
      b.vy *= THROW_STRENGTH;
      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (speed > MAX_SPEED) {
        b.vx *= MAX_SPEED / speed;
        b.vy *= MAX_SPEED / speed;
      }
      tagEls[i].classList.remove('is-active');
      tagEls[i].style.zIndex = '2';
      gsap.to(tagEls[i], { scale: 1, duration: LIFT_DUR, ease: 'annnimate', overwrite: 'auto', force3D: true });
      wake();
    });

    function initDrag() {
      if (typeof Draggable === 'undefined') return;
      draggables = tagEls.map(function (tag, i) {
        return Draggable.create(tag, {
          type: 'x,y',
          bounds: cloud,
          dragClickables: true,
          allowContextMenu: true,
          zIndexBoost: false,
          cursor: 'grab',
          activeCursor: 'grabbing',
          onPress: function () {
            if (demoTl) demoTl.pause();
            releaseDemo();
            lastDragDist = 0;
            grab(i, this);
          },
          onRelease: function () {
            lastDragDist = Math.max(Math.abs(this.x - this.startX), Math.abs(this.y - this.startY));
            if (bodies[i].held && bodies[i].src === this) release(i);
          },
        })[0];
      });
    }

    // Demo pass: the leftmost tag is dragged into its three nearest
    // neighbours, flung back out past its home and let go, so one pass shows
    // the push, the throw and the spring home. Planned at PLAY time from the
    // live homes, so it survives a resize without a rebuild.
    function planDemo() {
      let idx = 0;
      bodies.forEach(function (b, i) { if (b.hx < bodies[idx].hx) idx = i; });
      const b = bodies[idx];
      const near = bodies
        .map(function (o, i) { return { i: i, d: i === idx ? Infinity : Math.hypot(o.hx - b.hx, o.hy - b.hy) }; })
        .sort(function (p, q) { return p.d - q.d; })
        .slice(0, Math.min(3, n - 1));
      let cx = b.hx + 80;
      let cy = b.hy;
      if (near.length) {
        cx = 0;
        cy = 0;
        near.forEach(function (m) { cx += bodies[m.i].hx; cy += bodies[m.i].hy; });
        cx /= near.length;
        cy /= near.length;
      }
      demoPlan.idx = idx;
      demoPlan.inX = cx;
      demoPlan.inY = cy;
      demoPlan.outX = b.hx + (b.hx - cx) * DEMO_THROW_BACK;
      demoPlan.outY = b.hy + (b.hy - cy) * DEMO_THROW_BACK;
      demoPos.x = b.x;
      demoPos.y = b.y;
    }

    function holdDemo() {
      const b = bodies[demoPlan.idx];
      if (!b || (b.held && b.src !== demoPos)) return;
      if (!b.held) grab(demoPlan.idx, demoPos);
      wake();
    }

    function releaseDemo() {
      const b = bodies[demoPlan.idx];
      if (!b || !b.held || b.src !== demoPos) return;
      release(demoPlan.idx);
    }

    function buildDemoTl() {
      const tl = gsap.timeline({ paused: true });
      tl.call(planDemo, null, 0);
      tl.to(demoPos, {
        x: function () { return demoPlan.inX; },
        y: function () { return demoPlan.inY; },
        duration: DEMO_IN_DUR,
        ease: 'annnimateInOut',
        onUpdate: holdDemo,
        data: { label: 'A tag is dragged into its neighbours' },
      }, 0.01);
      // expo.in on purpose: the pointer path has to END fast, so the
      // measured release speed turns into a real throw.
      tl.to(demoPos, {
        x: function () { return demoPlan.outX; },
        y: function () { return demoPlan.outY; },
        duration: DEMO_THROW_DUR,
        ease: 'expo.in',
        onUpdate: holdDemo,
        data: { label: 'The tag is flung back out' },
      }, '+=' + DEMO_HOLD);
      tl.call(releaseDemo);
      tl.to({}, { duration: DEMO_SETTLE_DUR, data: { label: 'Every tag springs back home' } });
      return tl;
    }

    function demo() {
      if (reduced || !demoTl) return null;
      if (bodies.some(function (b) { return b.held && b.src !== demoPos; })) return null;
      demoTl.invalidate().restart(true, false);
      return demoTl;
    }

    // --- 7. Event listeners ---
    function onPointerMove(e) {
      if (e.pointerType !== 'mouse' || reduced) return;
      const x = e.pageX - cloudPageX;
      const y = e.pageY - cloudPageY;
      const now = e.timeStamp;
      if (cursor.on) {
        const dt = Math.max(0.004, (now - cursor.t) / 1000);
        let vx = (x - cursor.x) / dt;
        let vy = (y - cursor.y) / dt;
        const s = Math.sqrt(vx * vx + vy * vy);
        if (s > CURSOR_MAX_SPEED) {
          vx *= CURSOR_MAX_SPEED / s;
          vy *= CURSOR_MAX_SPEED / s;
        }
        cursor.vx += (vx - cursor.vx) * CURSOR_SMOOTH;
        cursor.vy += (vy - cursor.vy) * CURSOR_SMOOTH;
      }
      cursor.on = true;
      cursor.x = x;
      cursor.y = y;
      cursor.t = now;
      wake();
    }

    function onPointerLeave() {
      cursor.on = false;
      cursor.vx = 0;
      cursor.vy = 0;
    }

    // A tag that was dragged never follows its link. Keyboard activation
    // (detail 0) always goes through; the demo's "#" links never navigate.
    function onClick(e) {
      const tag = tagEls.find(function (t) { return t.contains(e.target); });
      if (!tag) return;
      if (e.detail !== 0 && lastDragDist > DRAG_CLICK_PX) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (tag.getAttribute('href') === '#') e.preventDefault();
    }

    function onVisibility() {
      if (document.hidden) gsap.globalTimeline.pause();
      else gsap.globalTimeline.resume();
    }

    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerleave', onPointerLeave);
    cloud.addEventListener('click', onClick, true);
    document.addEventListener('visibilitychange', onVisibility);

    const ro = new ResizeObserver(function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(relayout, RESIZE_DEBOUNCE);
    });
    ro.observe(container);

    // Tag widths depend on the webfont, so lay out again once it is in.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);

    // --- 8. Initial DOM state ---
    gsap.set(tagEls, { xPercent: -50, yPercent: -50, force3D: true });
    relayout();
    initDrag();
    demoTl = buildDemoTl();

    // --- 9. Reduced motion ---
    // The cloud stays laid out but holds still: no dragging, no hover push.
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: reduce)', function () {
      reduced = true;
      if (demoTl) demoTl.pause();
      draggables.forEach(function (d) { d.disable(); });
      relayout();
      return function () {
        reduced = false;
        draggables.forEach(function (d) { d.enable(); });
      };
    });

    // --- 10. Public API ---
    apiRef.current = {
      refresh: relayout,
      demo: demo,
    };

    return function cleanup() {
      alive = false;
      apiRef.current = {};
      sleep();
      clearTimeout(resizeTimer);
      mm.revert();
      if (demoTl) demoTl.kill();
      draggables.forEach(function (d) { d.kill(); });
      ro.disconnect();
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerleave', onPointerLeave);
      cloud.removeEventListener('click', onClick, true);
      document.removeEventListener('visibilitychange', onVisibility);
      gsap.set(tagEls, { clearProps: 'all' });
      tagEls.forEach(function (t) { t.classList.remove('is-active'); });
      container.classList.remove('is-live');
      container.style.removeProperty('--mtc-fit');
    };
  }, {
    scope: wrapRef,
    dependencies: [tags, gap, maxRows, hoverRadius, hoverStrength, spin, repelRadius, repelStrength, stiffness, damping, throwStrength, disable],
    revertOnUpdate: true,
  });

  return (
    <section
      ref={wrapRef}
      className={'mtc_wrap' + (className ? ' ' + className : '')}
      data-anm-magnetic-tag-cloud
      data-anm-disable={disable || undefined}
    >
      <div className="mtc_cloud" ref={cloudRef} data-anm-mtc-cloud>
        <ul className="mtc_list" role="list">
          {tags.map(function (tag, i) {
            return (
              <li key={i + '-' + tag.label}>
                <a
                  className={'mtc_tag' + (tag.color ? ' mtc_tag--' + tag.color : '')}
                  ref={function (el) { tagRefs.current[i] = el; }}
                  data-anm-mtc-tag
                  href={tag.href || '#'}
                >
                  {tag.label}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
});

export default MagneticTagCloud;
