'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import './elastic-divider.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

const BREAKPOINTS = {
  mobile: '(max-width: 479px)',
  landscape: '(orientation: landscape) and (max-width: 767px)',
  tablet: '(max-width: 991px)',
  desktop: '(min-width: 992px)',
};

function isDisabledOnViewport(disable) {
  if (!disable) return false;
  return disable.split(',').some((v) => {
    const q = BREAKPOINTS[v.trim()];
    return q && window.matchMedia(q).matches;
  });
}

/**
 * ElasticDivider Component
 * A section divider strung as one quadratic curve, pinned at both ends. A
 * pointer crossing the line flicks it - a short attack tween pulls the
 * control point away, then an elastic ease rings it back to rest. A
 * sideways swipe flicks it once per gesture on touch; a vertical drag stays
 * with the page. Reduced motion gets one small bend, no ringing.
 *
 * @param {string} [className=''] - Additional CSS classes for the wrapper
 * @param {string} [color='#101010'] - Line colour
 * @param {number} [weight=1] - Line thickness in px (clamped 0.25-8)
 * @param {number} [frequency=2.6] - Swings per second while ringing (clamped 0.1-12)
 * @param {number} [damping=0.72] - Seconds for the ring to fall to about a third (clamped 0.05-6)
 * @param {number} [sensitivity=1] - Multiplier on how much a given pointer speed rings the line
 * @param {number} [maxAmplitude=38] - Furthest the line can swing from rest, px
 * @param {string} [disable=''] - Comma-separated viewports to disable on: desktop, tablet, landscape, mobile
 */
const ElasticDivider = forwardRef(function ElasticDivider({
  className = '',
  color = '#101010',
  weight: weightProp = 1,
  frequency: frequencyProp = 2.6,
  damping: dampingProp = 0.72,
  sensitivity: sensitivityProp = 1,
  maxAmplitude: maxAmplitudeProp = 38,
  disable = '',
}, ref) {
  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const pathRef = useRef(null);
  const apiRef = useRef({});

  useImperativeHandle(ref, () => ({
    flick: (x, strength, direction) => apiRef.current.flick?.(x, strength, direction),
    demo: () => (apiRef.current.demo ? apiRef.current.demo() : null),
  }), []);

  useGSAP(
    (context, contextSafe) => {
      const container = containerRef.current;
      const svg = svgRef.current;
      const path = pathRef.current;
      if (!container || !svg || !path || isDisabledOnViewport(disable)) return;

      // --- Config ---
      const lineColor    = color;
      const weight       = clamp(weightProp, 0.25, 8);
      const frequency    = clamp(frequencyProp, 0.1, 12);
      const damping      = clamp(dampingProp, 0.05, 6);
      const sensitivity  = Math.max(0, sensitivityProp);
      const maxAmplitude = Math.max(0, maxAmplitudeProp);

      // --- Constants ---
      // Swing (px) the string gains per px/s of pointer speed. 800px/s, an ordinary sweep, gives about 11px.
      const SPEED_TO_AMP = 0.014;
      const AMP_MIN      = 3;
      // The string leaves fast and takes its time coming back. The ring lasts a few damping times,
      // and the elastic period is set so it swings at the configured frequency.
      const ATTACK_DUR   = 0.09;
      const ATTACK_EASE  = 'sine.out';
      const RING_TAUS    = 4.5;
      const RING_DUR     = damping * RING_TAUS;
      const RING_EASE    = 'elastic.out(1, ' + clamp(1 / (frequency * RING_DUR), 0.05, 1).toFixed(3) + ')';
      // The ends are pinned, so a flick right at an end would fold the line on itself.
      const FLICK_X_MIN  = 0.12;
      // A sideways swipe never crosses a horizontal line, so a finger close to it flicks it once per swipe.
      const TOUCH_REACH  = 26;
      const SWIPE_MIN    = 14;
      const SPEED_DT_MIN = 0.004;
      const RM_GAIN      = 0.4;
      const RM_DUR       = 0.6;
      const RESIZE_DEBOUNCE = 150;
      const DEMO_X       = 0.36;
      const DEMO_GAIN    = 0.7;

      // --- State ---
      // bend is the one thing that moves: where the string is held (x) and how far off its rest line (y).
      const bend = { x: 0, y: 0 };
      let width      = 0;
      let midY       = 0;
      let isReduced  = false;
      let liveTl     = null;
      let demoTl     = null;
      let prevX      = null;
      let prevY      = null;
      let prevT      = 0;
      let touchStart = null;
      let touchDone  = false;
      let resizeTimer = null;

      // --- Helpers ---
      // One quadratic curve, pinned at both ends. The curve passes halfway to its control point,
      // so the control point sits at twice the bend.
      function draw() {
        path.setAttribute('d', 'M0,' + midY + ' Q' + bend.x.toFixed(2) + ',' + (midY + bend.y * 2).toFixed(2) + ' ' + width + ',' + midY);
      }

      function measure() {
        width = container.clientWidth;
        const height = container.clientHeight;
        // Half-pixel centre, so an odd-width hairline lands on the pixel grid and stays sharp.
        midY = Math.round(height / 2) + (Math.round(weight) % 2 ? 0.5 : 0);
        svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
        bend.x = clamp(bend.x || width / 2, width * FLICK_X_MIN, width * (1 - FLICK_X_MIN));
        draw();
      }

      // --- Animation routines ---
      // Away fast, back on an elastic ease. Starting from wherever the string is right now means a
      // second flick while it still rings never snaps it.
      function buildFlick(x, amp, paused) {
        const tl = gsap.timeline({ paused: !!paused, onUpdate: draw });
        if (isReduced) {
          tl.to(bend, { x: x, y: amp * RM_GAIN, duration: ATTACK_DUR, ease: ATTACK_EASE, data: { label: 'String bends' } })
            .to(bend, { y: 0, duration: RM_DUR, ease: 'expo.out', data: { label: 'String settles' } });
          return tl;
        }
        tl.to(bend, { x: x, y: amp, duration: ATTACK_DUR, ease: ATTACK_EASE, data: { label: 'String pulled away' } })
          .to(bend, { y: 0, duration: RING_DUR, ease: RING_EASE, data: { label: 'String rings back to rest' } });
        return tl;
      }

      // x in px along the string, strength 0-1 of the max amplitude, direction +1 down / -1 up.
      const flick = contextSafe(function flick(x, strength, direction) {
        const at  = clamp(x === undefined ? width / 2 : x, width * FLICK_X_MIN, width * (1 - FLICK_X_MIN));
        const amp = clamp((strength === undefined ? 0.6 : strength) * maxAmplitude, 0, maxAmplitude) * (direction < 0 ? -1 : 1);
        if (demoTl) demoTl.pause();
        if (liveTl) liveTl.kill();
        liveTl = buildFlick(at, amp, false);
      });

      const buildDemo = contextSafe(function buildDemo() {
        if (demoTl) demoTl.kill();
        demoTl = buildFlick(width * DEMO_X, maxAmplitude * DEMO_GAIN, true);
      });

      // One pass for the Timeline inspector: pre-built and paused, never played on its own.
      function demo() {
        if (!demoTl || (liveTl && liveTl.isActive())) return null;
        if (liveTl) liveTl.kill();
        bend.y = 0;
        demoTl.restart(true, false);
        return demoTl;
      }

      function onPointerMove(e) {
        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const t = e.timeStamp / 1000;
        if (prevY !== null) {
          const dt    = Math.max(t - prevT, SPEED_DT_MIN);
          const speed = Math.hypot(x - prevX, y - prevY) / dt;
          const amp   = clamp(speed * SPEED_TO_AMP * sensitivity, AMP_MIN, maxAmplitude);
          const crossed = (prevY - midY) * (y - midY) < 0;
          if (crossed) {
            flick(x, amp / (maxAmplitude || 1), y > prevY ? 1 : -1);
          } else if (e.pointerType === 'touch' && !touchDone && touchStart !== null
            && Math.abs(y - midY) < TOUCH_REACH && Math.abs(x - touchStart) > SWIPE_MIN) {
            touchDone = true;
            flick(x, amp / (maxAmplitude || 1), y > midY ? -1 : 1);
          }
        } else if (e.pointerType === 'touch') {
          touchStart = x;
          touchDone = false;
        }
        prevX = x;
        prevY = y;
        prevT = t;
      }

      function onPointerEnd() {
        prevX = null;
        prevY = null;
        touchStart = null;
      }

      // --- Event listeners ---
      const ac = new AbortController();
      const listen = { signal: ac.signal };
      container.addEventListener('pointermove', onPointerMove, listen);
      container.addEventListener('pointerleave', onPointerEnd, listen);
      container.addEventListener('pointercancel', onPointerEnd, listen);
      container.addEventListener('pointerup', onPointerEnd, listen);

      function onResize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (liveTl) liveTl.kill();
          bend.y = 0;
          measure();
          buildDemo();
        }, RESIZE_DEBOUNCE);
      }
      const ro = new ResizeObserver(onResize);
      ro.observe(container);

      // A hidden tab should not keep a ring going; it picks up where it left off.
      document.addEventListener('visibilitychange', () => {
        if (!liveTl) return;
        if (document.hidden) liveTl.pause(); else liveTl.resume();
      }, listen);

      // --- Initial DOM state ---
      path.setAttribute('stroke', lineColor);
      path.setAttribute('stroke-width', weight);
      measure();

      // --- Reduced motion ---
      // One small bend, no ringing.
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: reduce)', () => {
        isReduced = true;
        buildDemo();
        return () => { isReduced = false; buildDemo(); };
      });
      buildDemo();

      // --- Public API ---
      apiRef.current = {
        flick: flick,
        demo: demo,
      };

      return () => {
        if (liveTl) liveTl.kill();
        if (demoTl) demoTl.kill();
        clearTimeout(resizeTimer);
        ac.abort();
        ro.disconnect();
        mm.revert();
      };
    },
    { scope: containerRef, dependencies: [color, weightProp, frequencyProp, dampingProp, sensitivityProp, maxAmplitudeProp, disable] }
  );

  // Timeline inspector contract (ADR-0011): mirrors the vanilla's
  // window.Anm.ElasticDivider so the sandbox bridge can find demo().
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.Anm = window.Anm || {};
    window.Anm.ElasticDivider = {
      flick: (x, strength, direction) => apiRef.current.flick?.(x, strength, direction),
      demo: () => (apiRef.current.demo ? apiRef.current.demo() : null),
    };
    return () => {
      if (window.Anm) delete window.Anm.ElasticDivider;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={'eldv_divider' + (className ? ' ' + className : '')}
      data-anm-elastic-divider
    >
      <svg
        ref={svgRef}
        className="eldv_svg"
        data-anm-elastic-divider-svg
        aria-hidden="true"
        focusable="false"
      >
        <path
          ref={pathRef}
          className="eldv_path"
          data-anm-elastic-divider-path
          fill="none"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
});

export default ElasticDivider;
