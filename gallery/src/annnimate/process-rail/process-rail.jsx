// Demo images are from Arqe (arqe.ai). They are placeholders: swap them for your own before going live. Using them in your own product needs your own Arqe plan.
'use client';

import { useRef, useCallback } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { MotionPathPlugin } from 'gsap/MotionPathPlugin';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { CustomEase } from 'gsap/CustomEase';
import './process-rail.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP, ScrollTrigger, MotionPathPlugin, DrawSVGPlugin, CustomEase);
}

const DEFAULT_STEPS = [
  {
    num: '01',
    title: 'Scout',
    text: 'We walk every route before anyone rides it.',
    image: '/img/report.webp',
    alt: 'Walker in a blue jacket above misty hills',
  },
  {
    num: '02',
    title: 'Map',
    text: 'Climbs, water and shelter marked to the metre.',
    image: '/img/report.webp',
    alt: 'Aerial view of a turquoise river through a rust canyon',
  },
  {
    num: '03',
    title: 'Camp',
    text: 'A tent pitched at the col before the group arrives.',
    image: '/img/report.webp',
    alt: 'Open tent door onto snowy peaks',
  },
  {
    num: '04',
    title: 'Ride',
    text: 'Six riders, one guide, and the bikes already set up.',
    image: '/img/report.webp',
    alt: 'A bird over a deep green canyon',
  },
];

const EASE = 'annnimate';
// extra scroll the sticky stage holds for, in viewport heights
const TRACK_VH = 200;
// a click scrolls just past the step's anchor, so the step is reached
const ARRIVE = 0.02;
// only the bead and the line are scrubbed; a step's arrival plays in seconds
// when the bead reaches it and plays back when the page scrolls above it
const CARD_DUR = 0.5;
const MEDIA_DUR = 0.8;
const ROLL_DUR = 0.6;
const ROLL_STAGGER = 0.05;
// opacity tiers: not reached yet, already passed, active is 1
const UPCOMING = 0.42;
const VISITED = 0.72;
// a step's image scales up from MEDIA_FROM when the bead reaches it, then stays
const MEDIA_FROM = 0.9;
// on mobile the bead reaches a step's number as that number crosses this height
// in the viewport (the stage does not stick there)
const MOBILE_READ = '60%';
const BREAKPOINTS = {
  mobile: '(max-width: 479px)',
  landscape: '(orientation: landscape) and (max-width: 767px)',
  tablet: '(max-width: 991px)',
  desktop: '(min-width: 992px)',
};

// The index text becomes one column per digit: a 1em window over a strip of
// glyphs 0..d that starts one glyph below the window (empty slot) and rolls up
// until d is in view. Non-digits stay as plain text.
function columnsFor(num, fallback) {
  const text = String(num == null ? fallback : num).trim();
  return text.split('').map((ch) => {
    if (!/[0-9]/.test(ch)) return { ch };
    const d = parseInt(ch, 10);
    const len = d + 1;
    return {
      ch,
      glyphs: Array.from({ length: len }, (_, g) => String(g)),
      hidden: 100 / len,
      target: -d * 100 / len,
    };
  });
}

/**
 * ProcessRail - a how-it-works row on a line. The root is a scroll track and
 * its stage is CSS position: sticky (no JS pin); one scrubbed timeline moves
 * the bead along the line and draws it up to the bead, and each step's card,
 * image and number arrive as the bead reaches it. Clicking a step scrolls the
 * page there.
 *
 * @param {string} [className=''] - Extra classes on the track
 * @param {Array<{num?: string, title: string, text: string, image?: string, alt?: string}>} [steps] - The steps, in order
 * @param {number} [scrub=0.6] - Scrub catch-up in seconds; 0 locks to the scroll
 * @param {number} [beadSize=10] - Bead diameter, px
 * @param {boolean} [sticky=true] - Hold the stage while the bead travels (desktop only)
 * @param {number} [stagger=0.08] - Seconds between a card brightening, its image and its number
 * @param {string} [disable=''] - Comma-separated viewports to disable on
 */
export default function ProcessRail({
  className = '',
  steps = DEFAULT_STEPS,
  scrub = 0.6,
  beadSize = 10,
  sticky = true,
  stagger = 0.08,
  disable = '',
}) {
  const containerRef = useRef(null);
  const railRef = useRef(null);
  const beadRef = useRef(null);
  const desktopPathRef = useRef(null);
  const desktopGhostRef = useRef(null);
  const mobilePathRef = useRef(null);
  const mobileGhostRef = useRef(null);
  const stepRefs = useRef([]);
  const btnRefs = useRef([]);
  const numRefs = useRef([]);
  const mediaRefs = useRef([]);
  const stripRefs = useRef([]);
  const scrollToRef = useRef(null);

  const columns = steps.map((step, i) => columnsFor(step.num, String(i + 1).padStart(2, '0')));

  useGSAP(() => {
    const container = containerRef.current;
    const rail = railRef.current;
    const bead = beadRef.current;
    const stepEls = stepRefs.current.filter(Boolean);
    const paths = [desktopPathRef.current, mobilePathRef.current].filter(Boolean);
    if (!container || !rail || !bead || !paths.length || !stepEls.length) return;

    CustomEase.create('annnimate', 'M0,0 C0.3,0.9 0.1,1 1,1');

    const scrubValue = scrub > 0 ? scrub : true;
    const disableList = String(disable).split(',').map((s) => s.trim()).filter(Boolean);
    const ghosts = new Map([
      [desktopPathRef.current, desktopGhostRef.current],
      [mobilePathRef.current, mobileGhostRef.current],
    ]);

    const stepState = stepEls.map((el, i) => {
      const digits = columns[i].filter((c) => c.glyphs);
      return {
        el,
        btn: btnRefs.current[i] || el,
        num: numRefs.current[i] || null,
        media: mediaRefs.current[i] || null,
        strips: (stripRefs.current[i] || []).filter(Boolean),
        hidden: digits.map((c) => c.hidden),
        targets: digits.map((c) => c.target),
      };
    });

    let tl = null;
    let current = null;
    let active = -1;
    let reduced = false;
    let resizeTimer = null;
    const mm = gsap.matchMedia();

    // Where each step sits on the line, as path progress. layout() measures it:
    // desktop, the middle of each step's column; mobile, each step's number.
    function anchorAt(i) {
      return current && current.anchors ? current.anchors[i] : 0;
    }

    function pathFor(isMobile) {
      return (isMobile ? mobilePathRef.current : desktopPathRef.current) || paths[0];
    }

    // Fits the line to the steps and measures where each step sits on it. The svg's
    // viewBox is the element's own pixel size, so path units are pixels.
    // Desktop: the steps are equal CSS grid columns, the line runs the rail's full
    // width (its left end is the first step's left edge) and a step's anchor is
    // the middle of its column. Mobile: the steps are equal-height rows, so every
    // step already holds the room its image needs, and the vertical line runs from
    // the first step's number to the last one's.
    function layout() {
      if (!current) return;
      const path = current.path;
      const svg = path.ownerSVGElement;
      const rr = rail.getBoundingClientRect();
      const sr = svg.getBoundingClientRect();
      const w = Math.max(1, Math.round(sr.width));
      const h = Math.max(1, Math.round(sr.height));
      const n = stepState.length;
      let d;
      if (current.isMobile) {
        const ys = stepState.map((s) => {
          const r = (s.num || s.el).getBoundingClientRect();
          return Math.round(r.top - sr.top + r.height / 2);
        });
        d = 'M ' + w / 2 + ' ' + ys[0] + ' L ' + w / 2 + ' ' + ys[n - 1];
        current.anchors = stepState.map((s, i) => (n > 1 ? i / (n - 1) : 0.5));
      } else {
        d = 'M 0 ' + h / 2 + ' L ' + w + ' ' + h / 2;
        current.anchors = stepState.map((s) => {
          const r = s.el.getBoundingClientRect();
          return gsap.utils.clamp(0, 1, (r.left + r.width / 2 - sr.left) / w);
        });
      }
      svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      if (path.getAttribute('d') !== d) {
        path.setAttribute('d', d);
        const ghost = ghosts.get(path);
        if (ghost) ghost.setAttribute('d', d);
      }
      const raw = MotionPathPlugin.getRawPath(path);
      MotionPathPlugin.cacheRawPathMeasurements(raw);
      const toRail = (pt) => ({ x: sr.left - rr.left + pt.x, y: sr.top - rr.top + pt.y });
      current.pts = stepState.map((s, i) => toRail(MotionPathPlugin.getPositionOnPath(raw, anchorAt(i))));
      current.start = toRail(MotionPathPlugin.getPositionOnPath(raw, 0));
      current.end = toRail(MotionPathPlugin.getPositionOnPath(raw, 1));
    }

    function stepIndexAt(progress) {
      // nothing is reached before the page has scrolled into the track, even where
      // the line starts exactly on the first step (mobile)
      if (!tl || progress <= 0) return -1;
      const t = progress * tl.duration();
      let idx = -1;
      stepState.forEach((s, i) => { if (t >= anchorAt(i) - 0.0001) idx = i; });
      return idx;
    }

    // The bead's position picks the active step; what a step does on arrival is a
    // normal tween, not scrubbed. Reached steps keep their number and image, and
    // scrolling back above a step plays its arrival back out.
    function setActive(i) {
      if (i === active) return;
      active = i;
      stepState.forEach((s, k) => {
        if (k === i) s.btn.setAttribute('aria-current', 'step');
        else s.btn.removeAttribute('aria-current');
        const reached = k <= i;
        setTier(s, k === i ? 1 : (reached ? VISITED : UPCOMING));
        showMedia(s, reached);
        rollNumber(s, reached);
      });
    }

    // Tear-down without playing anything back; the next build parks every step.
    function clearActive() {
      active = -1;
      stepState.forEach((s) => {
        s.btn.removeAttribute('aria-current');
        gsap.killTweensOf([s.el, s.media].concat(s.strips).filter(Boolean));
      });
    }

    function setTier(s, opacity) {
      if (s.tier === opacity) return;
      s.tier = opacity;
      if (reduced) {
        gsap.set(s.el, { opacity });
        return;
      }
      gsap.to(s.el, {
        opacity, duration: CARD_DUR, ease: EASE, overwrite: true,
        data: { label: 'Step card changes tier' },
      });
    }

    function showMedia(s, reached) {
      if (!s.media || s.shown === reached) return;
      s.shown = reached;
      const to = reached ? { opacity: 1, scale: 1 } : { opacity: 0, scale: MEDIA_FROM };
      if (reduced) {
        gsap.set(s.media, to);
        return;
      }
      gsap.to(s.media, Object.assign(to, {
        duration: reached ? MEDIA_DUR : MEDIA_DUR * 0.6,
        delay: reached ? stagger : 0,
        ease: EASE, overwrite: true, force3D: true,
        data: { label: 'Step image ' + (reached ? 'fades and scales in' : 'fades out') },
      }));
    }

    // Digits roll up into their slot when the step is reached and back down out
    // of it when the page scrolls above the step.
    function rollNumber(s, reached) {
      if (!s.strips.length || s.rolled === reached) return;
      s.rolled = reached;
      const to = (k) => (reached ? s.targets[k] : s.hidden[k]);
      if (reduced) {
        s.strips.forEach((strip, k) => gsap.set(strip, { yPercent: to(k) }));
        return;
      }
      gsap.to(s.strips, {
        yPercent: (k) => to(k),
        duration: ROLL_DUR,
        delay: reached ? stagger * 2 : 0,
        ease: EASE,
        stagger: reached ? ROLL_STAGGER : -ROLL_STAGGER,
        overwrite: true,
        force3D: true,
        data: { label: 'Step number rolls ' + (reached ? 'in' : 'out') },
      });
    }

    // The scrub stays the single source of truth: a click only moves the
    // page to the scroll position where that step has arrived.
    function scrollToStep(i) {
      if (!tl || !tl.scrollTrigger || i < 0 || i >= stepState.length) return;
      const st = tl.scrollTrigger;
      const t = Math.min(tl.duration(), anchorAt(i) + ARRIVE);
      const top = st.start + (st.end - st.start) * (t / tl.duration());
      const scroller = st.scroller && st.scroller !== window ? st.scroller : window;
      scroller.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
    }

    // No ScrollTrigger pin anywhere. Desktop (unless sticky is false): the root
    // is a tall track and the stage inside it is CSS position: sticky, so the
    // scrub simply runs from the track's top to its bottom. Phones never stick,
    // because four stacked steps with images are taller than the screen: the track
    // runs from the first step's number to the last crossing MOBILE_READ, clamped
    // to the page so a block near the top does not start part-way through.
    function makeTrigger() {
      const base = {
        scrub: scrubValue,
        invalidateOnRefresh: true,
        onRefreshInit: layout,
        onUpdate: (self) => setActive(stepIndexAt(self.progress)),
      };
      if (current.isMobile) {
        return Object.assign(base, {
          trigger: rail,
          start: () => 'clamp(top+=' + Math.round(current.pts[0].y) + ' ' + MOBILE_READ + ')',
          end: () => 'clamp(top+=' + Math.round(current.pts[current.pts.length - 1].y) + ' ' + MOBILE_READ + ')',
        });
      }
      if (sticky) {
        return Object.assign(base, { trigger: container, start: 'top top', end: 'bottom bottom' });
      }
      return Object.assign(base, { trigger: container, start: 'top 80%', end: 'bottom 20%' });
    }

    // Rest before the bead has reached a step: dim, empty number slot, image
    // hidden and scaled down.
    function parkRest() {
      stepState.forEach((s) => {
        gsap.killTweensOf([s.el, s.media].concat(s.strips).filter(Boolean));
        gsap.set(s.el, { opacity: UPCOMING });
        if (s.media) gsap.set(s.media, { opacity: 0, scale: MEDIA_FROM, force3D: true });
        s.strips.forEach((strip, k) => gsap.set(strip, { yPercent: s.hidden[k] }));
        s.tier = UPCOMING;
        s.shown = false;
        s.rolled = false;
      });
    }

    // Everything readable at once: the disabled-viewport state. The line is drawn
    // in full and the bead sits at its end.
    function showAll() {
      stepState.forEach((s) => {
        gsap.killTweensOf([s.el, s.media].concat(s.strips).filter(Boolean));
        gsap.set(s.el, { opacity: 1 });
        if (s.media) gsap.set(s.media, { opacity: 1, scale: 1 });
        s.strips.forEach((strip, k) => gsap.set(strip, { yPercent: s.targets[k] }));
        s.tier = 1;
        s.shown = true;
        s.rolled = true;
      });
      gsap.set(current.path, { drawSVG: '0% 100%' });
      gsap.set(bead, { x: current.end.x, y: current.end.y, xPercent: -50, yPercent: -50 });
    }

    // One scrubbed timeline. The bead's leg is a single explicit 0 -> 1 path
    // tween and the line draws 0% -> 100% over the same span, so the bead is
    // always the end of the line and each step's label sits exactly where the
    // bead reaches its anchor.
    function buildTimeline() {
      const path = current.path;
      const t = gsap.timeline({
        defaults: { ease: EASE, force3D: true },
        scrollTrigger: makeTrigger(),
      });

      t.to(bead, {
        motionPath: { path, align: path, alignOrigin: [0.5, 0.5], autoRotate: false, start: 0, end: 1 },
        ease: 'none',
        duration: 1,
        // render the start now, so the bead sits on the line before any scroll
        immediateRender: true,
        data: { label: 'Bead rides the line' },
      }, 0);

      t.fromTo(path,
        { drawSVG: '0% 0%' },
        {
          drawSVG: '0% 100%',
          ease: 'none',
          force3D: false,
          duration: 1,
          data: { label: 'Line draws up to the bead' },
        }, 0);

      // step arrivals are not on this timeline: onUpdate -> setActive plays them
      stepState.forEach((s, i) => {
        t.addLabel('step' + (i + 1), anchorAt(i));
      });

      return t;
    }

    // Reduced motion: no travel, no tweens. The scrub still jumps the bead to
    // the step it has reached with the line drawn up to it, and each step's
    // card, image and number switch without moving.
    function buildReduced() {
      const t = gsap.timeline({ scrollTrigger: makeTrigger() });
      stepState.forEach((s, i) => {
        const at = anchorAt(i);
        const when = i === 0 ? 0 : at;
        t.set(current.path, { drawSVG: '0% ' + at * 100 + '%' }, when);
        t.set(bead, {
          x: () => current.pts[i].x,
          y: () => current.pts[i].y,
          xPercent: -50, yPercent: -50,
        }, when);
      });
      return t;
    }

    function relayout() {
      layout();
      ScrollTrigger.refresh();
    }

    // Lay out again once ScrollTrigger's refresh is done (sizes are final then).
    function onRefreshed() {
      if (current) layout();
    }

    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(relayout, 150);
    }

    function onVisibility() {
      if (document.hidden) gsap.globalTimeline.pause();
      else gsap.globalTimeline.resume();
    }

    scrollToRef.current = scrollToStep;
    window.addEventListener('resize', onResize);
    ScrollTrigger.addEventListener('refresh', onRefreshed);
    document.addEventListener('visibilitychange', onVisibility);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);

    // Mobile/desktop, reduced-motion and the disable-viewport list are tiled
    // into ONE matchMedia call, so any change tears down the previous build
    // (GSAP reverts the last callback's return value) before rebuilding.
    const conditions = {
      isMobile: '(max-width: 767px)',
      isDesktop: '(min-width: 768px)',
      isReduced: '(prefers-reduced-motion: reduce)',
      isFull: '(prefers-reduced-motion: no-preference)',
    };
    const disableQuery = disableList.map((k) => BREAKPOINTS[k]).filter(Boolean).join(', ');
    if (disableQuery) conditions.isDisabledViewport = disableQuery;

    mm.add(conditions, (context) => {
      const isMobile = !!context.conditions.isMobile;
      const disabled = !!context.conditions.isDisabledViewport;
      reduced = !!context.conditions.isReduced;

      current = { isMobile, path: pathFor(isMobile), pts: [] };
      // the track only grows tall where the stage sticks
      container.style.setProperty('--prl-track', !isMobile && sticky ? (100 + TRACK_VH) + 'vh' : 'auto');
      layout();

      if (disabled) {
        showAll();
      } else if (reduced) {
        parkRest();
        tl = buildReduced();
      } else {
        parkRest();
        tl = buildTimeline();
      }

      return () => {
        if (tl) {
          if (tl.scrollTrigger) tl.scrollTrigger.kill(true);
          tl.kill();
          tl = null;
        }
        gsap.set(bead, { clearProps: 'transform' });
        paths.forEach((p) => gsap.set(p, { clearProps: 'strokeDasharray,strokeDashoffset' }));
        clearActive();
        current = null;
      };
    });

    return () => {
      clearTimeout(resizeTimer);
      scrollToRef.current = null;
      window.removeEventListener('resize', onResize);
      ScrollTrigger.removeEventListener('refresh', onRefreshed);
      document.removeEventListener('visibilitychange', onVisibility);
      mm.revert();
    };
  }, {
    scope: containerRef,
    revertOnUpdate: true,
    dependencies: [scrub, beadSize, sticky, stagger, disable, steps],
  });

  const handleStepClick = useCallback((i) => {
    scrollToRef.current?.(i);
  }, []);

  return (
    <section
      ref={containerRef}
      className={`prl_wrap ${className}`.trim()}
      style={{ '--prl-bead': beadSize + 'px' }}
      data-anm-process-rail
    >
      <div className="prl_stage">
        <div ref={railRef} className="prl_rail" data-anm-prl-rail>
          <svg className="prl_svg prl_svg_desktop" viewBox="0 0 1200 40" aria-hidden="true" focusable="false">
            <path ref={desktopGhostRef} className="prl_path_ghost" d="M 20 20 L 1180 20" />
            <path ref={desktopPathRef} className="prl_path" d="M 20 20 L 1180 20" data-anm-prl-path="desktop" />
          </svg>

          <svg className="prl_svg prl_svg_mobile" viewBox="0 0 80 560" aria-hidden="true" focusable="false">
            <path ref={mobileGhostRef} className="prl_path_ghost" d="M 40 16 L 40 544" />
            <path ref={mobilePathRef} className="prl_path" d="M 40 16 L 40 544" data-anm-prl-path="mobile" />
          </svg>

          <span ref={beadRef} className="prl_bead" data-anm-prl-bead />

          <ol className="prl_steps">
            {steps.map((step, i) => (
              <li
                key={i}
                ref={(el) => { stepRefs.current[i] = el; }}
                className="prl_step"
                data-anm-prl-step
              >
                <button
                  ref={(el) => { btnRefs.current[i] = el; }}
                  type="button"
                  className="prl_step_btn"
                  onClick={() => handleStepClick(i)}
                >
                  <span
                    ref={(el) => { numRefs.current[i] = el; }}
                    className="prl_step_num"
                    data-anm-prl-num
                    aria-hidden="true"
                  >
                    {columns[i].map((col, k) => (
                      col.glyphs ? (
                        <span key={k} className="prl_col">
                          <span
                            ref={(el) => {
                              if (!stripRefs.current[i]) stripRefs.current[i] = [];
                              stripRefs.current[i][k] = el;
                            }}
                            className="prl_strip"
                          >
                            {col.glyphs.map((g) => (
                              <span key={g} className="prl_glyph">{g}</span>
                            ))}
                          </span>
                        </span>
                      ) : (
                        <span key={k}>{col.ch}</span>
                      )
                    ))}
                  </span>
                  <span className="prl_step_title">{step.title}</span>
                  <span className="prl_step_text">{step.text}</span>
                  {step.image ? (
                    <span
                      ref={(el) => { mediaRefs.current[i] = el; }}
                      className="prl_step_media"
                      data-anm-prl-media
                    >
                      <img src={step.image} alt={step.alt || ''} loading="lazy" />
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
