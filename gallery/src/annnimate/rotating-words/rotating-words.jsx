'use client';

import { forwardRef, useImperativeHandle, useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { CustomEase } from 'gsap/CustomEase';
import './rotating-words.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP, ScrollTrigger, CustomEase);
  CustomEase.create('annnimate', 'M0,0 C0.3,0.9 0.1,1 1,1');
  CustomEase.create('annnimateInOut', 'M0,0 C0.7,0 0.16,1 1,1');
}

const FALLBACK_EASE = 'expo.out';
const SPIN_EASE = 'annnimate';
const SETTLE_EASE = 'annnimateInOut';
const SETTLE_DURATION = 0.6;
const GOTO_DURATION = 0.9;
// Neighbour words sit this light; the centre word is fully dark.
const DIM = 0.14;
// The landing word steps up in weight and tightens its tracking, so it
// clicks in like a dial instead of just getting darker.
const WEIGHT_REST = 300;
const WEIGHT_ACTIVE = 500;
const TRACK_REST = -0.02;
const TRACK_ACTIVE = -0.045;
// Distance between two neighbour words on the drum, in item heights.
const ITEM_GAP = 1.5;
const PERSPECTIVE = 4;
// Nav dots: the one for the centre word stretches into a pill.
const DOT_STRETCH = 2.6;
const DOT_DIM = 0.3;
const DRUM_SMOOTH = 0.9;
// Blur on the words themselves, by how far they have curved away: none
// near the centre (BLUR_FROM of the way to the edge), the full amount at
// the edge. A blur overlay on top cannot see 3D-transformed content in
// Safari, so the blur lives on each word. Rounded to half pixels so tiny
// changes do not repaint.
const BLUR_FROM = 0.2;
const SNAP_DURATION = { min: 0.25, max: 0.7 };
const RESIZE_DEBOUNCE = 150;
const BREAKPOINTS = {
  mobile: '(max-width: 479px)',
  landscape: '(orientation: landscape) and (max-width: 767px)',
  tablet: '(max-width: 991px)',
  desktop: '(min-width: 992px)',
};

const DEFAULT_WORDS = [
  'Road', 'Gravel', 'Padel', 'Tennis', 'Surf',
  'Alpine', 'Swim', 'Climb', 'Golf', 'Track',
];

function isDisabled(disable) {
  if (!disable) return false;
  return disable.split(',').some((v) => {
    const q = BREAKPOINTS[v.trim()];
    return q && window.matchMedia(q).matches;
  });
}

function ease(name) {
  return gsap.parseEase(name) ? name : FALLBACK_EASE;
}

/**
 * RotatingWords
 * A 3D word wheel. Scrubbed, the scrollbar turns the drum; otherwise it
 * spins through the list once on enter and settles on the last word. A row
 * of dots under the wheel tracks the centre word; click one to go there.
 *
 * Scrub range: `trackRef` if given, else the closest [data-anm-rw-track]
 * ancestor (top top -> bottom bottom), else the wheel crossing the viewport.
 * Props are read when the wheel is built; a change rebuilds it.
 * Ref handle: { goTo(index) }.
 */
const RotatingWords = forwardRef(function RotatingWords({
  className = '',
  words = DEFAULT_WORDS,
  scrub = true,
  spin = 2.4,
  settle = 0.15,
  step = 18,
  hold = 0,
  snap = false,
  snapDelay = 0.1,
  start = 'top 75%',
  once = false,
  nav = true,
  blur = 8,
  disable = '',
  trackRef,
  ...rest
}, ref) {
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const itemRefs = useRef([]);
  const dotRefs = useRef([]);
  const goToRef = useRef(null);
  const blurC = Math.max(0, blur);

  useImperativeHandle(ref, () => ({
    goTo: (i) => goToRef.current && goToRef.current(i),
  }), []);

  useGSAP((context, contextSafe) => {
    const root = rootRef.current;
    const list = listRef.current;
    const items = itemRefs.current.slice(0, words.length).filter(Boolean);
    if (!root || !list || items.length < 2) return undefined;
    const track = (trackRef && trackRef.current) || root.closest('[data-anm-rw-track]');
    const dots = nav ? dotRefs.current.slice(0, words.length).filter(Boolean) : [];
    const holdC = Math.min(0.9, Math.max(0, hold));

    const last = items.length - 1;
    const drum = { p: 0 };
    const scrollProxy = { t: 0 };
    let radius = 0;
    let tl = null;
    let st = null;
    let goTween = null;
    let active = false;
    let resizeTimer = null;
    let lastWidth = window.innerWidth;

    // Scrub: optionally linger on each word, then turn to the next. `hold`
    // is the share of every word-to-word stretch spent standing still (0 =
    // an even turn). Word i always sits exactly at progress i / last.
    function shape(t) {
      const raw = t * last;
      const i = Math.min(last, Math.floor(raw));
      const f = raw - i;
      if (!holdC) return raw;
      const g = Math.min(1, Math.max(0, (f - holdC / 2) / (1 - holdC)));
      return i + g * g * (3 - 2 * g);
    }

    // Radius from the item height: neighbours sit ITEM_GAP item heights
    // apart along the drum's surface.
    function layout() {
      const itemH = items[0].offsetHeight || 1;
      radius = (itemH * ITEM_GAP) / (2 * Math.sin((step * Math.PI) / 360));
      list.style.height = Math.round(radius * 2) + 'px';
      list.style.perspective = Math.round(radius * PERSPECTIVE) + 'px';
      render();
    }

    function render() {
      const p = drum.p;
      for (let i = 0; i < items.length; i++) {
        const el = items[i];
        const d = i - p;
        const a = d * step;
        if (Math.abs(a) >= 90) {
          el.style.visibility = 'hidden';
          continue;
        }
        const near = Math.max(0, 1 - Math.abs(d));
        const fade = 1 - Math.abs(a) / 90;
        el.style.visibility = '';
        el.style.transform = 'translate(-50%, -50%) translateZ(' + (-radius) + 'px) rotateX(' + (-a) + 'deg) translateZ(' + radius + 'px)';
        el.style.opacity = String(DIM * fade + (1 - DIM) * near);
        el.style.fontWeight = String(Math.round(WEIGHT_REST + (WEIGHT_ACTIVE - WEIGHT_REST) * near));
        el.style.letterSpacing = (TRACK_REST + (TRACK_ACTIVE - TRACK_REST) * near) + 'em';
        if (blurC) {
          const depth = Math.max(0, (Math.abs(a) / 90 - BLUR_FROM) / (1 - BLUR_FROM));
          const b = Math.round(blurC * depth * depth * 2) / 2;
          el.style.filter = b > 0 ? 'blur(' + b + 'px)' : '';
        }
      }
      const current = Math.round(p);
      dots.forEach((dot, k) => {
        const near = Math.max(0, 1 - Math.abs(k - p));
        dot.style.setProperty('--rw-dot', String(1 + (DOT_STRETCH - 1) * near));
        dot.style.opacity = String(DOT_DIM + (1 - DOT_DIM) * near);
        if (k === current) dot.setAttribute('aria-current', 'true');
        else dot.removeAttribute('aria-current');
      });
    }

    // Click a dot: scrub mode scrolls the page to where that word sits; spin
    // mode turns the wheel there directly.
    function goTo(i) {
      if (scrub && st) {
        const target = st.start + (st.end - st.start) * (i / last);
        window.scrollTo({ top: target, behavior: 'smooth' });
        return;
      }
      if (tl) tl.pause();
      if (goTween) goTween.kill();
      goTween = gsap.to(drum, { p: i, duration: GOTO_DURATION, ease: ease(SETTLE_EASE), onUpdate: render });
    }
    goToRef.current = contextSafe(goTo);

    function buildEnterTimeline() {
      const t = gsap.timeline({ paused: true });
      t.fromTo(drum, { p: 0 }, {
        p: last + settle, duration: spin, ease: ease(SPIN_EASE), onUpdate: render,
        data: { label: 'Drum spins through the list' },
      }, 0);
      t.to(drum, {
        p: last, duration: SETTLE_DURATION, ease: ease(SETTLE_EASE), onUpdate: render,
        data: { label: 'Drum settles on the last word' },
      }, spin);
      return t;
    }

    function scrubRange() {
      return track
        ? { trigger: track, start: 'top top', end: 'bottom bottom' }
        : { trigger: root, start: 'top bottom', end: 'bottom top' };
    }

    function build() {
      layout();
      if (scrub) {
        const drumTween = gsap.fromTo(scrollProxy, { t: 0 }, {
          t: 1, ease: 'none', paused: true,
          onUpdate: () => { drum.p = shape(scrollProxy.t); render(); },
          data: { label: 'Drum turns with the scroll' },
        });
        const config = { scrub: DRUM_SMOOTH, animation: drumTween, ...scrubRange() };
        // Snap: when scrolling stops, the page settles so a word sits in the
        // centre.
        if (snap) config.snap = { snapTo: 1 / last, duration: SNAP_DURATION, delay: Math.max(0, snapDelay), ease: ease(SETTLE_EASE) };
        st = ScrollTrigger.create(config);
      } else {
        tl = buildEnterTimeline();
        st = ScrollTrigger.create({
          trigger: root,
          start,
          once,
          toggleActions: once ? 'play none none none' : 'play none none reverse',
          animation: tl,
        });
      }
      gsap.set(root, { autoAlpha: 1 });
    }

    function teardown() {
      if (st) st.kill();
      if (tl) tl.kill();
      if (goTween) goTween.kill();
      st = null;
      tl = null;
      goTween = null;
    }

    // Reduced motion or a disabled viewport: the wheel rests on its last
    // word, nothing moves (the dots still jump to a word).
    function showStatic() {
      drum.p = last;
      layout();
      gsap.set(root, { autoAlpha: 1 });
    }

    function whenFontsReady(cb) {
      const ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
      ready.then(cb);
    }

    function enable() {
      if (isDisabled(disable)) {
        whenFontsReady(showStatic);
        return undefined;
      }
      active = true;
      drum.p = 0;
      scrollProxy.t = 0;
      gsap.set(root, { autoAlpha: 0 });
      whenFontsReady(() => { if (active) build(); });
      return () => {
        active = false;
        teardown();
      };
    }

    // Width only: a mobile URL bar changes the height on every scroll.
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (window.innerWidth === lastWidth) return;
        lastWidth = window.innerWidth;
        layout();
        ScrollTrigger.refresh();
      }, RESIZE_DEBOUNCE);
    }

    function onVisibility() {
      if (document.hidden) gsap.globalTimeline.pause();
      else gsap.globalTimeline.resume();
    }

    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);

    // Without JS the words are a plain centred list; the built class turns
    // them into the drum.
    root.classList.add('rw_is-built');

    // Owned by the useGSAP context, which reverts it (and runs enable's
    // cleanup) on unmount or prop change.
    gsap.matchMedia().add({ motion: '(prefers-reduced-motion: no-preference)', reduce: '(prefers-reduced-motion: reduce)' }, (ctx) => {
      if (ctx.conditions.motion) return enable();
      whenFontsReady(showStatic);
      return undefined;
    });

    return () => {
      active = false;
      goToRef.current = null;
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      root.classList.remove('rw_is-built');
      items.forEach((el) => el.removeAttribute('style'));
      dots.forEach((el) => {
        el.removeAttribute('style');
        el.removeAttribute('aria-current');
      });
      list.removeAttribute('style');
      gsap.set(root, { clearProps: 'visibility,opacity' });
    };
  }, {
    scope: rootRef,
    dependencies: [words.join('\n'), scrub, spin, settle, step, hold, snap, snapDelay, start, once, nav, blurC, disable, trackRef],
    revertOnUpdate: true,
  });

  return (
    <div
      ref={rootRef}
      className={`rw_wheel ${className}`.trim()}
      data-anm-rotating-words=""
      {...rest}
    >
      <ul ref={listRef} className="rw_list" data-anm-rw-list="">
        {words.map((word, i) => (
          <li key={i} ref={(el) => { itemRefs.current[i] = el; }} className="rw_item">{word}</li>
        ))}
      </ul>
      {nav && (
        <div className="rw_nav">
          {words.map((word, i) => (
            <button
              key={i}
              ref={(el) => { dotRefs.current[i] = el; }}
              type="button"
              className="rw_dot"
              aria-label={'Go to ' + String(word).trim()}
              onClick={() => goToRef.current && goToRef.current(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
});

export default RotatingWords;
