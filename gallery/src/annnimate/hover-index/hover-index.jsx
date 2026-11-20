// Demo images are from Arqe (arqe.ai). They are placeholders: swap them for your own before going live. Using them in your own product needs your own Arqe plan.
'use client';

import { forwardRef, useImperativeHandle, useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { CustomEase } from 'gsap/CustomEase';
import './hover-index.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP, CustomEase);
  CustomEase.create('annnimate', 'M0,0 C0.3,0.9 0.1,1 1,1');
  CustomEase.create('annnimateInOut', 'M0,0 C0.7,0 0.16,1 1,1');
}

// Brightness falls off with distance from the lens on this curve, so the rows next to it stay readable.
const CURVE = 1.6;
const WIPE = 0.7;
const SETTLE = 0.001;
const DESKTOP_QUERY = '(min-width: 768px)';
const RESIZE_DEBOUNCE = 150;

const DEFAULT_PROJECTS = [
  { name: "Northfield", image: "/img/report.webp", alt: "A black padel racket floating over a pale blue gradient" },
  { name: "Alder & Vine", image: "/img/report.webp", alt: "The nose of a cream surfboard on a warm brown ground" },
  { name: "Halden Studio", image: "/img/report.webp", alt: "A dark matte bike frame and saddle on a violet ground" },
  { name: "Meridian Coast", image: "/img/report.webp", alt: "A single wave rolling in under a pale dawn sky" },
  { name: "Oakline", image: "/img/report.webp", alt: "A green leaf lit from the side against black" },
  { name: "Saltmarsh", image: "/img/report.webp", alt: "Silver wraparound sunglasses on black" },
  { name: "Kestrel Works", image: "/img/report.webp", alt: "A runner blurred in motion against a blue sky" },
  { name: "Fernhill", image: "/img/report.webp", alt: "A golf iron head on a soft grey ground" },
  { name: "Brightwater", image: "/img/report.webp", alt: "A spoon of green matcha powder over a dark gradient" },
  { name: "Lowmoor", image: "/img/report.webp", alt: "A dark feathered shuttlecock on white" },
  { name: "Ashgrove", image: "/img/report.webp", alt: "A close blur of a frosted green bottle" },
  { name: "Tidewell", image: "/img/report.webp", alt: "A racer in a helmet looking down" },
];

function toNumber(value, fallback) {
  const n = parseFloat(value);
  return isNaN(n) ? fallback : n;
}

/**
 * HoverIndex
 *
 * A dark work index where your pointer is the lens: every project name
 * brightens by how close it sits to the cursor, so the light falls off
 * smoothly across the list, and a large preview card in the bottom right
 * wipes to the next photo in the direction you move.
 *
 * @param {string} [className=''] - Additional CSS classes for the root element
 * @param {number} [range=2] - How many rows the light falls off over (1.2-3)
 * @param {number} [dim=14] - How bright the far names stay (4-30)
 * @param {number} [follow=9] - How quickly the lens catches up with the pointer (4-16)
 * @param {{name: string, image: string, alt: string}[]} [projects] - The names, each with its photo
 */
const HoverIndex = forwardRef(function HoverIndex({
  className = '',
  range = 2,
  label = 'Selected work',
  dim = 14,
  follow = 9,
  projects = DEFAULT_PROJECTS,
}, ref) {
  const containerRef = useRef(null);
  const itemRefs = useRef([]);
  const listRef = useRef(null);
  const cardRef = useRef(null);
  const frameRef = useRef(null);
  const apiRef = useRef(null);

  useImperativeHandle(ref, () => ({
    refresh: (...args) => apiRef.current?.refresh(...args),
    demo: (...args) => apiRef.current?.demo(...args),
  }), []);

  // Keyed by the vanilla names, so the build body reads like the vanilla one.
  const config = {
    range: Math.min(6, Math.max(1.2, toNumber(range, 2))),
    dim: Math.min(40, Math.max(0, toNumber(dim, 14))) / 100,
    follow: Math.min(20, Math.max(3, toNumber(follow, 9))),
  };

  useGSAP((context, contextSafe) => {
    // --- 1. Selectors ---
    const container = containerRef.current;
    const items = itemRefs.current.filter(Boolean);
    const list = listRef.current;
    const card = cardRef.current;
    const frame = frameRef.current;

    if (items.length < 2 || !list) return null;

    // --- 2. Config ---
    const { range, dim, follow } = config;

    // --- 4. State ---
    const count = items.length;
    const state = { f: Math.floor((count - 1) / 2), target: Math.floor((count - 1) / 2) };
    let active = -1;
    let centers = [];
    let imgs = [];
    let wipes = [];
    let layer = 1;
    let demoTl = null;
    let lastTime = 0;
    let dirty = true;
    let reduced = false;
    let resizeTimer = null;

    // --- 5. Helpers ---
    function measure() {
      const box = container.getBoundingClientRect();
      centers = items.map((el) => {
        const r = el.getBoundingClientRect();
        return r.top - box.top + r.height / 2;
      });
      // The card sits bottom right with its bottom edge on the list's last row.
      if (!card) return;
      if (window.matchMedia(DESKTOP_QUERY).matches) {
        card.style.top = (list.getBoundingClientRect().bottom - box.top - card.offsetHeight).toFixed(1) + 'px';
      } else {
        card.style.removeProperty('top');
      }
    }

    // The pointer's height maps onto the list as a continuous row number, so the lens glides between rows.
    function rowAt(y) {
      if (y <= centers[0]) return 0;
      for (let i = 1; i < count; i++) {
        if (y <= centers[i]) return i - 1 + (y - centers[i - 1]) / (centers[i] - centers[i - 1]);
      }
      return count - 1;
    }

    // --- 6. Animation routines ---
    function buildImages() {
      imgs = items.map((item, i) => {
        const img = document.createElement('img');
        img.className = 'hi_img';
        img.src = item.getAttribute('data-image') || '';
        img.alt = '';
        img.decoding = 'async';
        img.style.setProperty('--hi-clip-top', i === Math.round(state.f) ? '0%' : '100%');
        frame.appendChild(img);
        return img;
      });
      wipes = imgs.map(() => null);
    }

    // The new photo comes in from the side the lens is moving toward and lands over the last one.
    function showImage(i, dir) {
      const img = imgs[i];
      if (!img) return;
      if (wipes[i]) wipes[i].kill();
      img.style.zIndex = String(++layer);
      const fromTop = dir > 0 ? '100%' : '0%';
      const fromBottom = dir > 0 ? '0%' : '100%';
      wipes[i] = gsap.fromTo(img,
        { '--hi-clip-top': fromTop, '--hi-clip-bottom': fromBottom },
        { '--hi-clip-top': '0%', '--hi-clip-bottom': '0%', duration: reduced ? 0 : WIPE, ease: 'annnimate' });
    }

    function setActive(i) {
      if (i === active) return;
      const dir = active < 0 ? 1 : Math.sign(i - active);
      active = i;
      showImage(i, dir);
    }

    function paint() {
      items.forEach((el, i) => {
        const near = Math.max(0, 1 - Math.abs(i - state.f) / range);
        el.style.opacity = (dim + (1 - dim) * Math.pow(near, CURVE)).toFixed(3);
      });
      setActive(Math.round(state.f));
    }

    function tick() {
      const now = gsap.ticker.time;
      const dt = Math.max(1 / 240, now - lastTime);
      lastTime = now;
      const before = state.f;
      state.f = reduced ? state.target : state.f + (state.target - state.f) * (1 - Math.exp(-dt * follow));
      if (Math.abs(state.target - state.f) < SETTLE) state.f = state.target;
      if (state.f === before && !dirty) return;
      dirty = false;
      paint();
    }

    // Pre-built and paused (Timeline inspector contract): the lens runs down the list and back.
    function buildDemo() {
      const start = state.target;
      demoTl = gsap.timeline({ paused: true });
      demoTl
        .to(state, { target: Math.min(count - 1, start + 3), duration: 1.2, ease: 'annnimateInOut', data: { label: 'Lens moves down the list' } }, 0.01)
        .to(state, { target: start, duration: 1.2, ease: 'annnimateInOut', data: { label: 'Lens moves back up' } }, '+=0.4');
    }

    function demo() {
      if (demoTl && demoTl.isActive()) return null;
      demoTl.restart(true, false);
      return demoTl;
    }

    // --- 7. Event listeners ---
    function handlePointerMove(e) {
      if (e.pointerType === 'touch') return;
      if (demoTl) demoTl.pause();
      state.target = rowAt(e.clientY - container.getBoundingClientRect().top);
    }

    function handlePointerDown(e) {
      const i = items.indexOf(e.target.closest('[data-anm-hi-item]'));
      if (i > -1) state.target = i;
    }

    function handleFocusIn(e) {
      const i = items.indexOf(e.target);
      if (i > -1) state.target = i;
    }

    function handleKey(e) {
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === 'ArrowDown' && i < count - 1) { e.preventDefault(); items[i + 1].focus(); }
      else if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); items[i - 1].focus(); }
    }

    function handleResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        measure();
        dirty = true;
      }, RESIZE_DEBOUNCE);
    }

    function handleVisibility() {
      if (document.hidden) gsap.globalTimeline.pause();
      else gsap.globalTimeline.resume();
    }

    const onTick = contextSafe(tick);
    const onPointerMove = contextSafe(handlePointerMove);
    const onPointerDown = contextSafe(handlePointerDown);
    const onFocusIn = contextSafe(handleFocusIn);
    const onKey = contextSafe(handleKey);
    const onResize = contextSafe(handleResize);
    const onVisibility = contextSafe(handleVisibility);

    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerdown', onPointerDown);
    list.addEventListener('focusin', onFocusIn);
    list.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);

    // --- 8. Initial DOM state ---
    if (frame) buildImages();
    measure();
    active = Math.round(state.f);
    paint();
    buildDemo();
    lastTime = gsap.ticker.time;
    gsap.ticker.add(onTick);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measure(); dirty = true; });

    // --- 9. Reduced motion ---
    const mm = gsap.matchMedia();
    mm.add({ motion: '(prefers-reduced-motion: no-preference)', reduce: '(prefers-reduced-motion: reduce)' }, (ctx) => {
      reduced = !!ctx.conditions.reduce;
      dirty = true;
    });

    // --- 10. Public API ---
    function refresh() {
      measure();
      dirty = true;
    }

    function kill() {
      gsap.ticker.remove(onTick);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerdown', onPointerDown);
      list.removeEventListener('focusin', onFocusIn);
      list.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(resizeTimer);
      mm.revert();
      if (demoTl) demoTl.kill();
      wipes.forEach((tw) => { if (tw) tw.kill(); });
      imgs.forEach((img) => img.remove());
      items.forEach((el) => el.style.removeProperty('opacity'));
      if (card) card.style.removeProperty('top');
    }

    const api = { refresh, kill, demo };
    apiRef.current = api;

    return () => {
      apiRef.current = null;
      api.kill();
    };
  }, {
    scope: containerRef,
    dependencies: [range, dim, follow, projects],
    revertOnUpdate: true,
  });

  return (
    <div
      ref={containerRef}
      className={'hi_wrap' + (className ? ' ' + className : '')}
      data-anm-hover-index
    >
      <p className="hi_label">{label}</p>
      <ol ref={listRef} className="hi_list" data-anm-hi-list>
        {projects.map((project, i) => (
          <li key={project.name} className="hi_row">
            <button
              ref={(el) => { itemRefs.current[i] = el; }}
              className="hi_name"
              type="button"
              data-anm-hi-item
              data-image={project.image}
              data-alt={project.alt}
            >{project.name}</button>
          </li>
        ))}
      </ol>
      <figure ref={cardRef} className="hi_card" data-anm-hi-card aria-hidden="true">
        <div ref={frameRef} className="hi_frame" data-anm-hi-frame />
      </figure>
    </div>
  );
});

export default HoverIndex;
