'use client';

import { useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import './echo-headline.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP, ScrollTrigger);
}

// Camera distance as a multiple of the word's width, so a short word and
// a long one foreshorten the same way when they turn.
const PERSPECTIVE = 1.6;
// The vanishing point, in word heights above the word's centre: the
// echoes recede toward it, so the slab stacks out on top of the word.
const VANISH_LIFT = 1.2;
// Color mode: how far each end of the slab mixes toward the background,
// in percent. The far end nearly melts into the page.
const FADE_NEAR = 30;
const FADE_FAR = 90;
// Opacity mode: geometric, because overlapping see-through layers add up.
const OPACITY_NEAR = 0.35;
const OPACITY_FAR = 0.02;
const FALLBACK_GROUND = '#ffffff';
// A fully transparent computed colour: rgba(0, 0, 0, 0), color(... / 0).
const TRANSPARENT = /(?:,|\/)\s*0(?:\.0+)?\s*\)$|^transparent$/;
// Below this spread every echo sits inside the word's own outline.
const HIDE_BELOW = 0.002;
// onEnter: fires when the word's centre passes this line of the viewport.
const ENTER_START = 'center 65%';
const ENTER_DUR = 1.6;
const ENTER_EASE = 'expo.out';
const BUILT_CLASS = 'eh_is-built';
const SCRUB_CLASS = 'eh_is-scrub';
const ROOT_PROPS = ['--eh-perspective', '--eh-depth', '--eh-vanish', '--eh-shift', '--eh-ink', '--eh-ground', '--eh-rx', '--eh-ry', '--eh-rz', '--eh-reach'];
const BREAKPOINTS = {
  mobile: '(max-width: 479px)',
  landscape: '(orientation: landscape) and (max-width: 767px)',
  tablet: '(max-width: 991px)',
  desktop: '(min-width: 992px)',
};

function isDisabled(disable) {
  if (!disable) return false;
  return disable.split(',').some((v) => {
    const q = BREAKPOINTS[v.trim()];
    return q && window.matchMedia(q).matches;
  });
}

function em(v) {
  return v.toFixed(4) + 'em';
}

/**
 * EchoHeadline
 * A one-word headline that grows a 3D slab of its own copies as you scroll,
 * stacking out on top into a trail of echoes that fade with depth. Real CSS
 * 3D: the component only writes custom properties on the root, the CSS does
 * the transforms.
 *
 * The root is the track. In scrub mode it gets the tall sticky track; in
 * onEnter mode it keeps its normal height and plays once in view. The word
 * (children) must sit on one line; the echoes render as copies of it,
 * farthest first, behind it in the slab.
 * Props are read when the slab is built; a change rebuilds it.
 */
export default function EchoHeadline({
  className = '',
  children = 'Distance',
  copies = 8,
  depth = 1,
  rotateX = 20,
  rotateY = 20,
  rotateZ = 0,
  fade = 'opacity',
  trigger = 'scrub',
  scrub = 0.5,
  hold = 0.2,
  once = false,
  disable = '',
  ...rootProps
}) {
  const rootRef = useRef(null);
  const slabRef = useRef(null);
  const wordRef = useRef(null);
  const echoRefs = useRef([]);

  const copiesC = Math.min(20, Math.max(4, parseInt(copies, 10) || 8));
  // The farthest echo ends at 1 / (1 + depth) of the word's size.
  const depthC = Math.min(5, Math.max(0.5, parseFloat(depth) || 1));
  // Degrees the word turns into as you scroll, like CSS rotateX / rotateY /
  // rotate. Z turns the whole slab, trail included.
  const rotateXC = Math.min(80, Math.max(-80, parseFloat(rotateX ?? 20) || 0));
  const rotateYC = Math.min(80, Math.max(-80, parseFloat(rotateY ?? 20) || 0));
  const rotateZC = Math.min(180, Math.max(-180, parseFloat(rotateZ) || 0));
  const fadeC = fade === 'color' ? 'color' : 'opacity';
  const triggerC = trigger === 'onEnter' ? 'onEnter' : 'scrub';
  // 0 (or junk) means scrub: true, the slab follows the scrollbar exactly.
  const scrubC = Math.max(0, parseFloat(scrub ?? 0.5)) || true;
  const onceC = once === true || once === 'true';
  // Share of the track at the end where the finished slab stays on screen.
  const holdC = Math.min(0.6, Math.max(0, parseFloat(hold ?? 0.2) || 0));

  useGSAP(() => {
    const root = rootRef.current;
    const slab = slabRef.current;
    const word = wordRef.current;
    const echoes = echoRefs.current.slice(0, copiesC);
    if (!root || !slab || !word || echoes.some((el) => !el)) return undefined;

    const spread = { p: 0 };
    const rest = { p: 0 };
    let shown = false;
    let tl = null;
    let st = null;
    let geo = null;

    // All in em: the word never wraps, so its size in em holds at any width.
    function measure() {
      const fs = parseFloat(getComputedStyle(slab).fontSize);
      const hw = slab.offsetWidth / fs / 2;
      const hh = slab.offsetHeight / fs / 2;
      const p = PERSPECTIVE * hw * 2;
      geo = { hw: hw, hh: hh, p: p, d: depthC * p, vy: -VANISH_LIFT * hh * 2 };
      root.style.setProperty('--eh-perspective', em(p));
      root.style.setProperty('--eh-depth', em(geo.d));
      root.style.setProperty('--eh-vanish', '50% calc(50% + ' + em(geo.vy) + ')');
    }

    // Projects the word and the farthest echo at the current pose, the same
    // maths the browser runs, and shifts the slab so both sit centred. At rest
    // the shift is zero, so the word starts dead centre.
    function frame(s) {
      const { hw, hh, p, d, vy } = geo;
      const a = rotateXC * s * Math.PI / 180;
      const b = rotateYC * s * Math.PI / 180;
      const box = [Infinity, -Infinity, Infinity, -Infinity];
      [0, -d * s].forEach((z) => [-hw, hw].forEach((x) => [-hh, hh].forEach((y) => {
        const x1 = x * Math.cos(b) + z * Math.sin(b);
        const z1 = z * Math.cos(b) - x * Math.sin(b);
        const y2 = y * Math.cos(a) - z1 * Math.sin(a);
        const z2 = y * Math.sin(a) + z1 * Math.cos(a);
        const f = p / (p - z2);
        const sx = x1 * f;
        const sy = vy + (y2 - vy) * f;
        box[0] = Math.min(box[0], sx);
        box[1] = Math.max(box[1], sx);
        box[2] = Math.min(box[2], sy);
        box[3] = Math.max(box[3], sy);
      })));
      root.style.setProperty('--eh-shift', em(-(box[0] + box[1]) / 2) + ', ' + em(-(box[2] + box[3]) / 2));
    }

    // The first painted background behind the headline, whatever colour the
    // page uses; a light page fades the echoes lighter, a dark one darker.
    function findGround() {
      for (let el = slab; el; el = el.parentElement) {
        const bg = getComputedStyle(el).backgroundColor;
        if (!TRANSPARENT.test(bg)) return bg;
      }
      return FALLBACK_GROUND;
    }

    // The mix itself runs in CSS (color-mix in oklab), so any colour format
    // the page uses works and the steps look even to the eye.
    function setTones() {
      root.style.setProperty('--eh-ink', getComputedStyle(word).color);
      root.style.setProperty('--eh-ground', findGround());
    }

    // One progress drives the turn and the extrusion together; the browser
    // does the 3D, so the slab moves as one solid object, never a stagger.
    function render() {
      const s = spread.p;
      root.style.setProperty('--eh-rx', (rotateXC * s).toFixed(3) + 'deg');
      root.style.setProperty('--eh-ry', (rotateYC * s).toFixed(3) + 'deg');
      root.style.setProperty('--eh-rz', (rotateZC * s).toFixed(3) + 'deg');
      root.style.setProperty('--eh-reach', s.toFixed(4));
      frame(s);
      const show = s > HIDE_BELOW;
      if (show !== shown) {
        shown = show;
        gsap.set(echoes, { visibility: show ? 'visible' : 'hidden' });
      }
    }

    // Linear on purpose: perspective already eases the growth, fast at first
    // and slower as the far end nears the vanishing point.
    // The slab finishes `hold` before the end of the track and the rest of
    // the scroll is an empty stretch with the result on screen.
    function buildScrubTimeline() {
      const run = 1 - holdC;
      const t = gsap.timeline({ paused: true });
      t.fromTo(spread, { p: 0 }, {
        p: 0.5, duration: run / 2, ease: 'none', onUpdate: render,
        data: { label: 'Echoes peel out of the word' },
      }, 0);
      t.fromTo(spread, { p: 0.5 }, {
        p: 1, duration: run / 2, ease: 'none', onUpdate: render, immediateRender: false,
        data: { label: 'Slab stretches to full depth' },
      }, run / 2);
      if (holdC > 0) {
        t.fromTo(rest, { p: 0 }, {
          p: 1, duration: holdC, ease: 'none',
          data: { label: 'Finished slab holds on screen' },
        }, run);
      }
      return t;
    }

    function buildEnterTimeline() {
      const t = gsap.timeline({ paused: true });
      t.fromTo(spread, { p: 0 }, {
        p: 1, duration: ENTER_DUR, ease: ENTER_EASE, easeReverse: true, onUpdate: render,
        data: { label: 'Word turns, echoes peel out' },
      }, 0);
      return t;
    }

    function build() {
      measure();
      setTones();
      // A late webfont changes the word's width; measure again once it lands.
      document.fonts.ready.then(() => { if (tl) { measure(); frame(spread.p); } });
      render();
      if (triggerC === 'scrub') {
        tl = buildScrubTimeline();
        st = ScrollTrigger.create({ trigger: root, start: 'top top', end: 'bottom bottom', scrub: scrubC, animation: tl });
        // Killing the trigger leaves the timeline where it is: at the end.
        if (onceC) tl.eventCallback('onComplete', () => st.kill());
      } else {
        tl = buildEnterTimeline();
        st = ScrollTrigger.create({ trigger: root, start: ENTER_START, animation: tl, toggleActions: onceC ? 'play none none none' : 'play none none reverse' });
      }
    }

    // The echoes stay rendered; only the visibility render() set by hand
    // (outside the context) is cleared, so a rebuild starts hidden again.
    function teardown() {
      if (st) st.kill();
      if (tl) tl.kill();
      echoes.forEach((el) => { el.style.visibility = ''; });
      ROOT_PROPS.forEach((v) => root.style.removeProperty(v));
      spread.p = 0;
      rest.p = 0;
      geo = null;
      shown = false;
      st = null;
      tl = null;
    }

    // Reduced motion and disabled viewports never get here: without the
    // built class the word sits in the page as one plain headline.
    function enable() {
      if (isDisabled(disable)) return undefined;
      root.classList.add(BUILT_CLASS);
      // Only scrub mode gets the tall sticky track.
      if (triggerC === 'scrub') root.classList.add(SCRUB_CLASS);
      build();
      return () => {
        teardown();
        root.classList.remove(BUILT_CLASS, SCRUB_CLASS);
      };
    }

    function onVisibility() {
      if (document.hidden) gsap.globalTimeline.pause();
      else gsap.globalTimeline.resume();
    }

    // No resize handler: the geometry is all em and percent, nothing is
    // measured in px, and ScrollTrigger refreshes its own positions.
    document.addEventListener('visibilitychange', onVisibility);

    // Owned by the useGSAP context, which reverts it (and runs the enable
    // cleanup) on unmount or prop change.
    gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', enable);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      teardown();
      root.classList.remove(BUILT_CLASS, SCRUB_CLASS);
    };
  }, {
    scope: rootRef,
    dependencies: [
      copiesC, depthC, rotateXC, rotateYC, rotateZC, fadeC, triggerC, scrubC, holdC, onceC, disable, className,
      typeof children === 'string' ? children : '',
    ],
    revertOnUpdate: true,
  });

  // Echoes farthest first, so the nearest paints last and the word, after
  // them in the DOM, stays on top. Each knows its place in the slab; the CSS
  // turns that into its depth and tone.
  return (
    <div
      ref={rootRef}
      className={`eh_track ${className}`.trim()}
      data-anm-echo-headline=""
      {...rootProps}
    >
      <div className="eh_stage">
        <div ref={slabRef} className="eh_slab">
          {Array.from({ length: copiesC }, (_, k) => {
            const i = copiesC - k;
            const far = (i - 1) / (copiesC - 1);
            const tone = fadeC === 'opacity'
              ? { opacity: OPACITY_NEAR * Math.pow(OPACITY_FAR / OPACITY_NEAR, far) }
              : { '--eh-fade': (FADE_NEAR + (FADE_FAR - FADE_NEAR) * far).toFixed(1) + '%' };
            return (
              <div
                key={i}
                ref={(el) => { echoRefs.current[i - 1] = el; }}
                className="eh_echo"
                aria-hidden="true"
                style={{ '--eh-i': (i / copiesC).toFixed(4), ...tone }}
              >
                {children}
              </div>
            );
          })}
          <h2 ref={wordRef} className="eh_word" data-anm-eh-word="">
            {children}
          </h2>
        </div>
      </div>
    </div>
  );
}
