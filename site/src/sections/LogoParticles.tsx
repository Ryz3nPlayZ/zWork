import { useEffect, useRef } from "react";
import { onReveal } from "../lib/intro";

/**
 * The hero's backdrop: the zWork mark drawn in dust. Particles drift in from
 * across the hero once the preloader slides off, settle into the six slats,
 * and the mark turns slowly; the pointer pushes them aside. A thin field of
 * loose dust drifts around it.
 *
 * One 2D canvas, a single fill per frame, DPR capped at 2, paused while the
 * hero is off screen or the tab is in the background.
 * With reduced motion it draws the settled mark once.
 */

// The slat geometry from Logo.tsx, in its 40-unit box.
const SKEW = Math.tan((-18 * Math.PI) / 180);
const TURN = 0.035; // radians per second
const SPRING = 0.035;
const DAMP = 0.86;
const PUSH_RADIUS = 120; // css px
const PUSH = 2.4;

type P = { x: number; y: number; vx: number; vy: number; hx: number; hy: number; loose: boolean; ph: number; a: number };

/** A random point on one of the six slats, in mark units around the centre. */
function slatPoint(): [number, number] {
  const i = Math.floor(Math.random() * 6);
  const u = (Math.random() * 2 - 1) * 2.1;
  const v = (Math.random() * 2 - 1) * 5.5;
  const x = u + SKEW * v;
  const y = v - 12.5;
  const t = (i * Math.PI) / 3;
  return [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)];
}

export function LogoParticles({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const bg = canvas.closest<HTMLElement>(".hero-bg");
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let W = 0, H = 0, dpr = 1, unit = 1, cx = 0, cy = 0;
    let ps: P[] = [];
    let color = "0 0 0";
    let formed = still ? 1 : 0;
    let angle = 0;
    let visible = true;
    let raf = 0;
    let last = 0;
    const pointer = { x: -1e4, y: -1e4 };

    const readColor = () => {
      color = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() || "0 0 0";
    };

    const seed = () => {
      const n = Math.round(Math.min(2400, Math.max(900, (W * H) / 480)));
      ps = Array.from({ length: n }, (_, k) => {
        const loose = k % 6 === 0;
        const [hx, hy] = loose ? [Math.random() * W, Math.random() * H] : slatPoint();
        return {
          x: Math.random() * W,
          y: Math.random() * H,
          vx: 0,
          vy: 0,
          hx,
          hy,
          loose,
          ph: Math.random() * Math.PI * 2,
          a: loose ? Math.random() * 0.5 : 0.4 + Math.random() * 0.6,
        };
      });
      if (still) for (const p of ps) [p.x, p.y] = home(p, 0);
    };

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const changed = Math.abs(r.width - W) > 1 || Math.abs(r.height - H) > 1;
      W = r.width;
      H = r.height;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      // The mark spans most of the hero, its hollow centre behind the headline;
      // on a phone it overhangs the sides rather than shrinking to a badge.
      unit = W < 640 ? (W * 1.1) / 40 : Math.min(W * 0.88, H * 1.02) / 40;
      const title = canvas.parentElement?.parentElement?.querySelector(".hero-title");
      const tr = title?.getBoundingClientRect();
      cx = W / 2;
      cy = tr && tr.height ? tr.top + tr.height / 2 - r.top : H * 0.5;
      if (changed || !ps.length) seed();
      if (still) draw();
    };

    const home = (p: P, t: number): [number, number] => {
      if (p.loose) return [p.hx + Math.sin(t * 0.21 + p.ph) * 24, p.hy + Math.cos(t * 0.17 + p.ph) * 18];
      const c = Math.cos(angle), s = Math.sin(angle);
      const wob = Math.sin(t * 0.9 + p.ph) * 0.35;
      return [cx + (p.hx * c - p.hy * s) * unit + wob * unit * 0.4, cy + (p.hx * s + p.hy * c) * unit + wob * unit * 0.3];
    };

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const size = W < 640 ? 1.5 : 1.8;
      // Four alpha buckets keep it to a handful of fills.
      for (let b = 0; b < 4; b++) {
        ctx.fillStyle = `rgb(${color} / ${(0.16 + b * 0.09) * (0.35 + 0.65 * formed)})`;
        ctx.beginPath();
        for (const p of ps) {
          if (Math.min(3, Math.floor(p.a * 4)) !== b) continue;
          ctx.rect(p.x, p.y, size, size);
        }
        ctx.fill();
      }
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!visible || document.hidden || bg?.style.visibility === "hidden") {
        last = now;
        return;
      }
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      const t = now / 1000;
      angle += TURN * dt;
      const k = SPRING * formed;
      // The physics is tuned per 60 Hz step; take one to three of them so it
      // runs at the same pace on 120 Hz screens and through dropped frames.
      const steps = Math.max(1, Math.min(3, Math.round(dt * 60)));
      const fast = dt < 1 / 90;
      for (const p of ps) {
        const [tx, ty] = home(p, t);
        for (let n = 0; n < steps; n++) {
          const h = fast ? 0.5 : 1;
          p.vx += (tx - p.x) * k * h;
          p.vy += (ty - p.y) * k * h;
          const dx = p.x - pointer.x, dy = p.y - pointer.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < PUSH_RADIUS * PUSH_RADIUS && d2 > 0.01) {
            const d = Math.sqrt(d2);
            const f = (1 - d / PUSH_RADIUS) ** 2 * PUSH * h;
            p.vx += (dx / d) * f;
            p.vy += (dy / d) * f;
          }
          const damp = fast ? Math.sqrt(DAMP) : DAMP;
          p.vx *= damp;
          p.vy *= damp;
          p.x += p.vx * h;
          p.y += p.vy * h;
        }
      }
      draw();
    };

    readColor();
    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const mo = new MutationObserver(() => {
      readColor();
      if (still) draw();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => {
      readColor();
      if (still) draw();
    };
    scheme.addEventListener("change", onScheme);

    if (still) {
      return () => {
        ro.disconnect();
        mo.disconnect();
        scheme.removeEventListener("change", onScheme);
      };
    }

    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(canvas);
    // The canvas sits under the hero's content, so listen on the window.
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
    };
    const onLeave = () => {
      pointer.x = pointer.y = -1e4;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    // Loose dust until the preloader is gone, then the mark pulls together.
    let form = 0;
    const off = onReveal(() => {
      const t0 = performance.now();
      const step = () => {
        formed = Math.min(1, (performance.now() - t0) / 1800);
        if (formed < 1) form = requestAnimationFrame(step);
      };
      form = requestAnimationFrame(step);
    });
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(form);
      off();
      io.disconnect();
      ro.disconnect();
      mo.disconnect();
      scheme.removeEventListener("change", onScheme);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className={className} />;
}
