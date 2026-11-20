// Demo images are from Arqe (arqe.ai). They are placeholders: swap them for your own before going live. Using them in your own product needs your own Arqe plan.
'use client';

import { forwardRef, useImperativeHandle, useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { CustomEase } from 'gsap/CustomEase';
import './diagonal-gallery.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP, ScrollTrigger, CustomEase);
  CustomEase.create('annnimate', 'M0,0 C0.3,0.9 0.1,1 1,1');
  CustomEase.create('annnimateInOut', 'M0,0 C0.7,0 0.16,1 1,1');
}

// The gap between the large photo and its neighbours, as a share of the large photo's width.
const GAP = 0.06;
// A photo leaving the queue drifts half a thumbnail further up and left as it shrinks away.
const LEAVE_DRIFT = 0.5;
const COPY_OUT = 0.25;
const COPY_IN = 0.6;
const COPY_STAGGER = 0.06;
const LINE_PARK = 110;
const RESIZE_DEBOUNCE = 150;

const DEFAULT_PHOTOS = [
  {
    title: 'Day one',
    text: 'Gravel out of Girona, ninety kilometres and <b>one long climb</b>.',
    image: '/img/report.webp',
    alt: 'A cyclist riding a cream gravel bike down a white stone track',
  },
  {
    title: 'Day two',
    text: 'A ridge walk above the cloud line, <b>bikes left at the hut</b>.',
    image: '/img/report.webp',
    alt: 'A walker in a blue jacket looking across misty hills',
  },
  {
    title: 'Day three',
    text: 'Camp at the col, with dinner cooked <b>before the light goes</b>.',
    image: '/img/report.webp',
    alt: 'The open door of a tent looking out over snowy peaks and clouds',
  },
  {
    title: 'Day four',
    text: 'Down the canyon road, the fastest descent of <b>the whole week</b>.',
    image: '/img/report.webp',
    alt: 'A bird crossing a green canyon seen from above',
  },
  {
    title: 'Day five',
    text: 'The coast by evening and <b>a swim before dinner</b>.',
    image: '/img/report.webp',
    alt: 'A sailboat alone on a calm sea',
  },
];

function toNumber(value, fallback) {
  const n = parseFloat(value);
  return isNaN(n) ? fallback : n;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * DiagonalGallery
 *
 * A queue of photos on a diagonal that steps on as you scroll. The current
 * photo sits large in the middle with its copy beside it, the next one waits
 * small at the bottom right, and each step sends the current one up to a
 * small thumbnail at the top left while the next grows into the middle and
 * the step number rolls on.
 *
 * @param {string} [className=''] - Additional CSS classes for the root element
 * @param {number} [step=110] - How much scroll each photo gets (60-160)
 * @param {number} [duration=0.9] - How long one move between photos takes (0.5-1.3)
 * @param {Array<{title: string, text: string, image: string, alt: string}>} [photos] - The photos, each with a title, a line of copy (may hold <b>), an image URL and alt text
 * @param {number} [thumb=22] - How big the next and previous photos sit, as a share of the large one (12-32)
 */
const DiagonalGallery = forwardRef(function DiagonalGallery({
  className = '',
  step = 110,
  duration = 0.9,
  thumb = 22,
  photos: photoData = DEFAULT_PHOTOS,
}, ref) {
  const containerRef = useRef(null);
  const photoRefs = useRef([]);
  const titleLineRef = useRef(null);
  const textLineRef = useRef(null);
  const numberElRef = useRef(null);
  const totalElRef = useRef(null);
  const apiRef = useRef(null);

  useImperativeHandle(ref, () => ({
    refresh: (...args) => apiRef.current?.refresh(...args),
    kill: (...args) => apiRef.current?.kill(...args),
  }), []);

  // Keyed by the vanilla names, so the build body reads like the vanilla one.
  const config = {
    step: Math.min(200, Math.max(40, toNumber(step, 110))),
    duration: Math.min(1.4, Math.max(0.4, toNumber(duration, 0.9))),
    thumb: Math.min(34, Math.max(12, toNumber(thumb, 22))) / 100,
  };

  useGSAP(() => {
    // --- 1. Selectors ---
    const container = containerRef.current;
    const photos = photoRefs.current.slice(0, photoData.length).filter(Boolean);

    if (photos.length < 2) return null;

    const titleLine = titleLineRef.current;
    const textLine = textLineRef.current;
    const numberEl = numberElRef.current;
    const totalEl = totalElRef.current;

    // --- 2. Config ---
    const { step, duration, thumb } = config;

    // --- 4. State ---
    const count = photos.length;
    let index = 0;
    let w = 0;
    let h = 0;
    let moving = null;
    let copyTl = null;
    let digits = [];
    let trigger = null;
    let reduced = false;
    let resizeTimer = null;

    // --- 5. Helpers ---
    function measure() {
      w = photos[0].offsetWidth;
      h = photos[0].offsetHeight;
    }

    // Where a photo sits relative to the current one: 0 large in the middle, 1 waiting small at the
    // bottom right, -1 small at the top left, further out shrunk to nothing beyond those spots.
    function pose(rel) {
      const sw = w * thumb;
      const sh = h * thumb;
      const nx = w / 2 + w * GAP + sw / 2;
      const ny = h / 2 - sh / 2;
      if (rel === 0) return { x: 0, y: 0, scale: 1, zIndex: 3 };
      if (rel === 1) return { x: nx, y: ny, scale: thumb, zIndex: 2 };
      if (rel === -1) return { x: -nx, y: -ny, scale: thumb, zIndex: 1 };
      if (rel > 1) return { x: nx, y: ny, scale: 0, zIndex: 0 };
      const drift = (sw + w * GAP) * LEAVE_DRIFT;
      return { x: -nx - drift, y: -ny - drift, scale: 0, zIndex: 0 };
    }

    function buildDigits() {
      if (!numberEl) return;
      const places = String(count).length < 2 ? 2 : String(count).length;
      numberEl.textContent = '';
      digits = Array.from({ length: places }, () => {
        const wrap = document.createElement('span');
        wrap.className = 'dia_digit';
        const col = document.createElement('span');
        col.className = 'dia_digit_col';
        for (let d = 0; d <= 9; d++) {
          const n = document.createElement('span');
          n.textContent = String(d);
          col.appendChild(n);
        }
        wrap.appendChild(col);
        numberEl.appendChild(wrap);
        return col;
      });
      if (totalEl) totalEl.textContent = '/ ' + String(count).padStart(places, '0');
    }

    // --- 6. Animation routines ---
    function place(k, animate) {
      const retarget = !!(moving && moving.some((tw) => tw.isActive()));
      moving = photos.map((photo, i) => {
        const p = pose(i - k);
        gsap.set(photo, { zIndex: p.zIndex });
        if (!animate) return gsap.set(photo, { x: p.x, y: p.y, scale: p.scale, force3D: true });
        // A step that lands while the queue is still moving carries on from where it is, without a slow start.
        return gsap.to(photo, { x: p.x, y: p.y, scale: p.scale, duration, ease: retarget ? 'annnimate' : 'annnimateInOut', overwrite: true, force3D: true });
      });
    }

    function rollNumber(k, animate) {
      const places = digits.length;
      const value = String(k + 1).padStart(places, '0');
      digits.forEach((col, p) => {
        const d = Number(value[p]);
        if (animate) gsap.to(col, { yPercent: -d * 10, duration, ease: 'annnimateInOut', overwrite: true });
        else gsap.set(col, { yPercent: -d * 10 });
      });
    }

    function swapCopy(k) {
      const lines = [titleLine, textLine].filter(Boolean);
      if (!lines.length) return;
      if (copyTl) copyTl.kill();
      const photo = photos[k];
      copyTl = gsap.timeline()
        .to(lines, { yPercent: -LINE_PARK, duration: COPY_OUT, ease: 'annnimateInOut', overwrite: true })
        .call(() => {
          if (titleLine) titleLine.textContent = photo.getAttribute('data-title') || '';
          if (textLine) textLine.innerHTML = photo.getAttribute('data-text') || '';
        })
        // immediateRender off: parked at build time, the incoming lines jumped out of view before the exit ran.
        .fromTo(lines, { yPercent: LINE_PARK }, { yPercent: 0, duration: COPY_IN, ease: 'annnimate', stagger: COPY_STAGGER, immediateRender: false });
    }

    function goTo(k) {
      if (k === index) return;
      index = k;
      place(k, !reduced);
      rollNumber(k, !reduced);
      if (reduced) {
        if (titleLine) titleLine.textContent = photos[k].getAttribute('data-title') || '';
        if (textLine) textLine.innerHTML = photos[k].getAttribute('data-text') || '';
      } else {
        swapCopy(k);
      }
    }

    // The steps play on their own clock; the scrubbed proxy only gives the Timeline inspector one row per step.
    function buildScroll() {
      if (trigger) trigger.kill();
      const proxy = {};
      const tl = gsap.timeline({ paused: true });
      photos.slice(1).forEach((photo, i) => {
        tl.to(proxy, { duration: 1, data: { label: (photo.getAttribute('data-title') || 'Photo ' + (i + 2)) + ' takes the centre' } });
      });
      tl.to(proxy, { duration: 1 });
      trigger = ScrollTrigger.create({
        trigger: container,
        start: 'top top',
        end: 'bottom bottom',
        scrub: 0.5,
        animation: tl,
        onUpdate: (self) => goTo(Math.min(count - 1, Math.floor(self.progress * count))),
      });
    }

    // --- 7. Event listeners ---
    function handleResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        measure();
        place(index, false);
        ScrollTrigger.refresh();
      }, RESIZE_DEBOUNCE);
    }

    function handleVisibility() {
      if (document.hidden) gsap.globalTimeline.pause();
      else gsap.globalTimeline.resume();
    }

    window.addEventListener('resize', handleResize);
    document.addEventListener('visibilitychange', handleVisibility);

    // --- 8. Initial DOM state ---
    container.style.setProperty('--dia-length', count * step + 'vh');
    measure();
    buildDigits();
    place(0, false);
    rollNumber(0, false);

    // --- 9. Reduced motion ---
    // Reduced motion keeps the steps but swaps them in place instead of moving the photos.
    const mm = gsap.matchMedia();
    mm.add({ motion: '(prefers-reduced-motion: no-preference)', reduce: '(prefers-reduced-motion: reduce)' }, (ctx) => {
      reduced = !!ctx.conditions.reduce;
      buildScroll();
      return () => {
        if (trigger) trigger.kill();
        trigger = null;
      };
    });

    // --- 10. Public API ---
    function refresh() {
      measure();
      place(index, false);
      ScrollTrigger.refresh();
    }

    function kill() {
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('visibilitychange', handleVisibility);
      clearTimeout(resizeTimer);
      mm.revert();
      if (copyTl) copyTl.kill();
      gsap.killTweensOf(photos.concat(digits));
      gsap.set(photos.concat(digits), { clearProps: 'all' });
      container.style.removeProperty('--dia-length');
    }

    const api = { refresh, kill };
    apiRef.current = api;

    return () => {
      apiRef.current = null;
      api.kill();
      if (titleLine) titleLine.innerHTML = escapeHtml(first.title);
      if (textLine) textLine.innerHTML = first.text;
    };
  }, {
    scope: containerRef,
    dependencies: [step, duration, thumb, photoData],
    revertOnUpdate: true,
  });

  const first = photoData[0] || { title: '', text: '' };

  return (
    <div
      ref={containerRef}
      className={'dia_wrap' + (className ? ' ' + className : '')}
      data-anm-diagonal-gallery
    >
      <div className="dia_stage" data-anm-dia-stage>
        <h2 className="dia_headline"><span>One Friday</span> <span className="dia_dim">in six minutes</span></h2>
        <div className="dia_photos">
          {photoData.map((photo, i) => (
            <figure
              key={photo.title + i}
              ref={(el) => { photoRefs.current[i] = el; }}
              className="dia_photo"
              data-anm-dia-photo
              data-title={photo.title}
              data-text={photo.text}
            >
              <img className="dia_img" src={photo.image} alt={photo.alt} decoding="async" />
            </figure>
          ))}
        </div>
        <div className="dia_copy">
          <p className="dia_title"><span ref={titleLineRef} className="dia_line" data-anm-dia-title dangerouslySetInnerHTML={{ __html: escapeHtml(first.title) }} /></p>
          <p className="dia_text"><span ref={textLineRef} className="dia_line" data-anm-dia-text dangerouslySetInnerHTML={{ __html: first.text }} /></p>
        </div>
        <p className="dia_count" aria-hidden="true"><span ref={numberElRef} className="dia_number" data-anm-dia-number /> <span ref={totalElRef} className="dia_total" data-anm-dia-total /></p>
      </div>
    </div>
  );
});

export default DiagonalGallery;
