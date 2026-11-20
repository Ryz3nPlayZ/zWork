'use client';

import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { CustomEase } from 'gsap/CustomEase';
import './split-flap-board.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP, CustomEase);
  if (!CustomEase.get('annnimate')) CustomEase.create('annnimate', 'M0,0 C0.3,0.9 0.1,1 1,1');
  if (!CustomEase.get('annnimateInOut')) CustomEase.create('annnimateInOut', 'M0,0 C0.7,0 0.16,1 1,1');
}

// A tile riffles through the characters between its current and target
// glyph on its own drum (digits / uppercase / lowercase), so a letter never
// riffles past a number and the case of a word is kept. Text swaps live on
// timeline calls so a killed run never leaves a half-set tile - the next
// run re-seeds from whatever each tile last committed.
const FALL_FRAC = 0.4;
const LAND_FRAC = 0.18;
const BOUNCE_UP_FRAC = 0.16;
const BOUNCE_DOWN_FRAC = 0.2;
const FALL_EASE = 'power2.in';
const LAND_EASE = 'power1.in';
const GLINT_PEAK = 0.07;
const GAP_SHADE = 0.45;
const RIFFLE_SPEEDUP = 0.35;
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const ROW_STAGGER = 0.12;
const SHADE_PEAK = 0.55;
const ARROW_HOVER_DUR = 0.35;
const PERSPECTIVE = 320;

const BREAKPOINTS = {
  mobile: '(max-width: 479px)',
  landscape: '(orientation: landscape) and (max-width: 767px)',
  tablet: '(max-width: 991px)',
  desktop: '(min-width: 992px)',
};

function isDisabledOnViewport(disable) {
  if (!disable) return false;
  return String(disable).split(',').some((v) => {
    const q = BREAKPOINTS[v.trim()];
    return q && window.matchMedia(q).matches;
  });
}

// The drum a tile riffles on, decided by the glyph it is heading to (or the
// one it holds, when heading to a blank). Punctuation has no drum.
function drumFor(fromChar, toChar) {
  const ref = toChar !== ' ' ? toChar : fromChar;
  if (/[0-9]/.test(ref)) return ' ' + DIGITS;
  if (/[A-Z]/.test(ref)) return ' ' + UPPER;
  if (/[a-z]/.test(ref)) return ' ' + LOWER;
  return ' ' + ref;
}

const DEFAULT_SETS = [
  ['Canyon road', 'Guided ride', '06:10'],
  ['The col', 'Hut to hut', '07:40'],
  ['Coast', 'Swim club', '09:15'],
  ['Ridge camp', 'Gravel', '11:30'],
];

/**
 * SplitFlapBoard Component
 * A mechanical split-flap board. Click it, use the arrows, or press
 * left/right to flap every tile to the next result set - rows cascade left
 * to right, each tile landing on its own beat like a real drum. No autoplay.
 *
 * @param {string} [className=''] - Additional CSS classes for the wrapper
 * @param {number} [duration=0.36] - Period of the last flap of each tile, the one that lands on the target
 * @param {number} [stagger=0.015] - Delay between neighbouring tiles starting their riffle, left to right
 * @param {number} [cycles=2] - How many flaps a tile riffles through before the one that lands on its target
 * @param {number} [bounce=32] - Degrees a flap rebounds off the stack after landing; 0 is a dead stop
 * @param {number} [columns=0] - Fixed column count; 0 sizes the board to the longest line across all sets
 * @param {string} [disable=''] - Comma-separated viewports to disable on: desktop, tablet, landscape, mobile
 * @param {Array<Array<string>>} [sets] - Result sets, one entry per set, rows in reading order
 */
const SplitFlapBoard = forwardRef(function SplitFlapBoard({
  className = '',
  duration = 0.36,
  stagger = 0.015,
  cycles = 2,
  bounce = 32,
  columns = 0,
  disable = '',
  sets = DEFAULT_SETS,
}, ref) {
  const wrapRef = useRef(null);
  const boardRef = useRef(null);
  const prevBtnRef = useRef(null);
  const nextBtnRef = useRef(null);
  const prevIconRef = useRef(null);
  const nextIconRef = useRef(null);
  const liveRef = useRef(null);
  const halfTopCharRefs = useRef([]);
  const halfBottomCharRefs = useRef([]);
  const flapTopRefs = useRef([]);
  const flapTopCharRefs = useRef([]);
  const flapBottomRefs = useRef([]);
  const flapBottomCharRefs = useRef([]);
  const shadeRefs = useRef([]);
  const glintRefs = useRef([]);
  const apiRef = useRef({});

  const rowCount = useMemo(
    () => sets.reduce((m, s) => Math.max(m, s.length), 0),
    [sets],
  );
  const columnCount = useMemo(() => {
    if (columns > 0) return columns;
    return sets.reduce((m, s) => s.reduce((mm, line) => Math.max(mm, line.length), m), 1);
  }, [sets, columns]);

  useImperativeHandle(ref, () => ({
    next: () => (apiRef.current.next ? apiRef.current.next() : null),
    prev: () => (apiRef.current.prev ? apiRef.current.prev() : null),
    goTo: (i) => (apiRef.current.goTo ? apiRef.current.goTo(i) : null),
    demo: () => (apiRef.current.demo ? apiRef.current.demo() : null),
  }), []);

  useGSAP((context, contextSafe) => {
    const board = boardRef.current;
    const prevBtn = prevBtnRef.current;
    const nextBtn = nextBtnRef.current;
    const prevIcon = prevIconRef.current;
    const nextIcon = nextIconRef.current;
    if (!board || !prevBtn || !nextBtn || rowCount < 1 || columnCount < 1) return undefined;
    if (isDisabledOnViewport(disable)) return undefined;

    const COLUMNS = columnCount;
    const ROWS = rowCount;
    const CYCLES = Math.max(0, cycles);
    const BOUNCE = Math.max(0, bounce);
    const DURATION = duration;
    const STAGGER = stagger;

    // --- State ---
    const rows = [];
    for (let r = 0; r < ROWS; r += 1) {
      const tiles = [];
      for (let c = 0; c < COLUMNS; c += 1) {
        const i = r * COLUMNS + c;
        tiles.push({
          halfTopChar: halfTopCharRefs.current[i],
          halfBottomChar: halfBottomCharRefs.current[i],
          flapTop: flapTopRefs.current[i],
          flapTopChar: flapTopCharRefs.current[i],
          flapBottom: flapBottomRefs.current[i],
          flapBottomChar: flapBottomCharRefs.current[i],
          shade: shadeRefs.current[i],
          glint: glintRefs.current[i],
          current: ' ',
        });
      }
      rows.push(tiles);
    }
    if (rows.some((tiles) => tiles.some((t) => !t.halfTopChar || !t.flapTop || !t.flapBottom))) return undefined;

    let index = 0;
    let master = null;

    // --- Helpers ---
    function padLine(line) {
      return line.slice(0, COLUMNS).padEnd(COLUMNS, ' ');
    }

    function targetLines(i) {
      const s = sets[i] || [];
      const lines = [];
      for (let r = 0; r < ROWS; r += 1) lines.push(padLine(s[r] || ''));
      return lines;
    }

    // The characters a tile passes on its way from one glyph to the next,
    // walking the drum forward and wrapping, thinned evenly to `cycles`
    // intermediate flaps; always ends on the target.
    function riffleSequence(fromChar, toChar) {
      const drum = drumFor(fromChar, toChar);
      const n = drum.length;
      let i = Math.max(0, drum.indexOf(fromChar));
      const end = Math.max(0, drum.indexOf(toChar));
      if (fromChar === toChar) return [];
      if (i === end) return [toChar];
      const seq = [];
      while (i !== end) {
        i = (i + 1) % n;
        seq.push(drum[i]);
      }
      const steps = CYCLES + 1;
      if (seq.length <= steps) return seq;
      const last = seq.length - 1;
      const thinned = [];
      for (let s = 0; s < steps - 1; s += 1) {
        thinned.push(seq[Math.floor((s * last) / (steps - 1))]);
      }
      thinned.push(seq[last]);
      return thinned;
    }

    function setTileChar(t, ch) {
      t.halfTopChar.textContent = ch;
      t.halfBottomChar.textContent = ch;
      t.flapTopChar.textContent = ch;
      t.flapBottomChar.textContent = ch;
      t.current = ch;
    }

    function announce() {
      if (liveRef.current) liveRef.current.textContent = (sets[index] || []).join(', ');
    }

    // A killed run can leave a flap mid-fall. Every tile is put back to a
    // whole glyph (whatever it had last committed) before the next run.
    function normalizeTiles() {
      rows.forEach((tiles) => {
        tiles.forEach((t) => {
          gsap.killTweensOf([t.flapTop, t.flapBottom, t.shade, t.glint]);
          setTileChar(t, t.current);
          gsap.set([t.flapTop, t.flapBottom], { rotateX: 0 });
          gsap.set([t.shade, t.glint], { opacity: 0 });
        });
      });
    }

    // --- Animation routines ---
    // One flap: the top flap falls to edge-on showing the outgoing glyph
    // (the incoming one is already on the half behind it), the bottom flap
    // carries the same fall on to the stack, bounces, and rests.
    function addFlap(tl, t, outChar, inChar, at, period) {
      const fall = period * FALL_FRAC;
      const land = period * LAND_FRAC;
      const up = period * BOUNCE_UP_FRAC;
      const down = period * BOUNCE_DOWN_FRAC;
      tl.call(() => {
        t.flapTopChar.textContent = outChar;
        t.halfTopChar.textContent = inChar;
        t.flapBottomChar.textContent = inChar;
        gsap.set(t.flapTop, { rotateX: 0 });
        gsap.set(t.flapBottom, { rotateX: 90 });
      }, null, at);
      tl.to(t.flapTop, { rotateX: -90, duration: fall, ease: FALL_EASE, force3D: true }, at);
      tl.to(t.shade, { opacity: SHADE_PEAK, duration: fall, ease: 'power2.in' }, at);
      tl.call(() => {
        t.halfBottomChar.textContent = inChar;
        t.flapTopChar.textContent = inChar;
        gsap.set(t.flapTop, { rotateX: 0 });
        t.current = inChar;
      }, null, at + fall);
      tl.to(t.flapBottom, { rotateX: 0, duration: land, ease: LAND_EASE, force3D: true }, at + fall);
      if (BOUNCE > 0) {
        tl.to(t.flapBottom, { rotateX: BOUNCE, duration: up, ease: 'power1.out', force3D: true }, at + fall + land);
        tl.to(t.flapBottom, { rotateX: 0, duration: down, ease: 'power1.in', force3D: true }, at + fall + land + up);
        tl.to(t.glint, { opacity: GLINT_PEAK * Math.min(1, BOUNCE / 32), duration: up, ease: 'power1.out' }, at + fall + land);
        tl.to(t.glint, { opacity: 0, duration: down, ease: 'power1.in' }, at + fall + land + up);
        tl.to(t.shade, { opacity: 0, duration: land, ease: 'power2.out' }, at + fall);
        tl.to(t.shade, { opacity: GAP_SHADE * Math.min(1, BOUNCE / 32), duration: up, ease: 'power1.out' }, at + fall + land);
        tl.to(t.shade, { opacity: 0, duration: down, ease: 'power1.in' }, at + fall + land + up);
      } else {
        tl.to(t.shade, { opacity: 0, duration: land, ease: 'power2.out' }, at + fall);
      }
    }

    function flapPeriod(i, count) {
      const fast = DURATION / (1 + CYCLES * RIFFLE_SPEEDUP);
      if (count <= 1) return DURATION;
      return fast + (DURATION - fast) * (i / (count - 1));
    }

    function buildTileTimeline(t, toChar) {
      const seq = riffleSequence(t.current, toChar);
      const tl = gsap.timeline();
      let prev = t.current;
      let cursor = 0;
      seq.forEach((ch, i) => {
        const period = flapPeriod(i, seq.length);
        addFlap(tl, t, prev, ch, cursor, period);
        cursor += period;
        prev = ch;
      });
      return tl;
    }

    function flapTo(nextIndex) {
      const target = ((nextIndex % sets.length) + sets.length) % sets.length;
      if (target === index) return null;
      index = target;
      const lines = targetLines(index);

      if (master) { master.kill(); master = null; normalizeTiles(); }
      master = gsap.timeline({
        onComplete: () => { master = null; announce(); },
      });

      rows.forEach((tiles, r) => {
        const rowTl = gsap.timeline({
          data: { label: 'Row ' + (r + 1) + ' flaps to "' + lines[r].trim() + '"' },
        });
        let any = false;
        tiles.forEach((t, c) => {
          if (t.current === lines[r][c]) return;
          any = true;
          rowTl.add(buildTileTimeline(t, lines[r][c]), c * STAGGER);
        });
        if (any) master.add(rowTl, r * ROW_STAGGER);
      });

      return master;
    }

    function step(delta) {
      return flapTo(index + delta);
    }

    function demo() {
      if (master && master.isActive()) return null;
      return step(1);
    }

    // --- Event listeners ---
    const boardClick = contextSafe(() => { step(1); });
    board.addEventListener('click', boardClick);

    const prevClick = contextSafe(() => { step(-1); });
    const nextClick = contextSafe(() => { step(1); });
    prevBtn.addEventListener('click', prevClick);
    nextBtn.addEventListener('click', nextClick);

    const prevEnter = contextSafe(() => {
      gsap.to(prevIcon, { x: -3, duration: ARROW_HOVER_DUR, ease: 'back.out(2)', overwrite: 'auto', force3D: true });
    });
    const prevLeave = contextSafe(() => {
      gsap.to(prevIcon, { x: 0, duration: ARROW_HOVER_DUR, ease: 'expo.out', overwrite: 'auto', force3D: true });
    });
    const nextEnter = contextSafe(() => {
      gsap.to(nextIcon, { x: 3, duration: ARROW_HOVER_DUR, ease: 'back.out(2)', overwrite: 'auto', force3D: true });
    });
    const nextLeave = contextSafe(() => {
      gsap.to(nextIcon, { x: 0, duration: ARROW_HOVER_DUR, ease: 'expo.out', overwrite: 'auto', force3D: true });
    });
    prevBtn.addEventListener('mouseenter', prevEnter);
    prevBtn.addEventListener('mouseleave', prevLeave);
    nextBtn.addEventListener('mouseenter', nextEnter);
    nextBtn.addEventListener('mouseleave', nextLeave);

    function onKeydown(e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); step(1); }
    }
    board.addEventListener('keydown', onKeydown);

    const handleVisibility = () => {
      if (document.hidden) gsap.globalTimeline.pause();
      else gsap.globalTimeline.resume();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // --- Initial DOM state ---
    const first = targetLines(0);
    rows.forEach((tiles, r) => {
      tiles.forEach((t, c) => {
        setTileChar(t, first[r][c]);
        gsap.set([t.flapTop, t.flapBottom], { rotateX: 0, transformPerspective: PERSPECTIVE, force3D: true });
        gsap.set([t.shade, t.glint], { opacity: 0 });
      });
    });
    announce();

    // --- Reduced motion ---
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: reduce)', () => {
      gsap.globalTimeline.timeScale(20);
    });

    // --- Public API ---
    apiRef.current = {
      next: () => step(1),
      prev: () => step(-1),
      goTo: (i) => flapTo(i),
      demo,
    };

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      board.removeEventListener('keydown', onKeydown);
      board.removeEventListener('click', boardClick);
      prevBtn.removeEventListener('click', prevClick);
      nextBtn.removeEventListener('click', nextClick);
      prevBtn.removeEventListener('mouseenter', prevEnter);
      prevBtn.removeEventListener('mouseleave', prevLeave);
      nextBtn.removeEventListener('mouseenter', nextEnter);
      nextBtn.removeEventListener('mouseleave', nextLeave);
      if (master) master.kill();
      mm.revert();
      apiRef.current = {};
    };
  }, {
    scope: wrapRef,
    dependencies: [duration, stagger, cycles, bounce, columns, disable, sets, rowCount, columnCount],
  });

  return (
    <section
      ref={wrapRef}
      className={`sfb_wrap${className ? ' ' + className : ''}`}
      data-anm-split-flap-board
      data-anm-duration={duration}
      data-anm-stagger={stagger}
      data-anm-cycles={cycles}
      data-anm-bounce={bounce}
      data-anm-disable={disable || undefined}
    >
      <div className="sfb_stage">
        <div
          className="sfb_board"
          ref={boardRef}
          role="group"
          aria-label="Results board"
          tabIndex={0}
        >
          {Array.from({ length: rowCount }).map((_, r) => (
            <div className="sfb_row" key={r}>
              {Array.from({ length: columnCount }).map((_, c) => {
                const i = r * columnCount + c;
                return (
                  <div className="sfb_tile" aria-hidden="true" key={c}>
                    <div className="sfb_half sfb_half_top">
                      <span
                        className="sfb_char sfb_char_top"
                        ref={(el) => { halfTopCharRefs.current[i] = el; }}
                      > </span>
                    </div>
                    <div className="sfb_half sfb_half_bottom">
                      <span
                        className="sfb_char sfb_char_bottom"
                        ref={(el) => { halfBottomCharRefs.current[i] = el; }}
                      > </span>
                      <div className="sfb_shade" ref={(el) => { shadeRefs.current[i] = el; }} />
                    </div>
                    <div
                      className="sfb_flap sfb_flap_top"
                      ref={(el) => { flapTopRefs.current[i] = el; }}
                    >
                      <span
                        className="sfb_char sfb_char_top"
                        ref={(el) => { flapTopCharRefs.current[i] = el; }}
                      > </span>
                    </div>
                    <div
                      className="sfb_flap sfb_flap_bottom"
                      ref={(el) => { flapBottomRefs.current[i] = el; }}
                    >
                      <span
                        className="sfb_char sfb_char_bottom"
                        ref={(el) => { flapBottomCharRefs.current[i] = el; }}
                      > </span>
                      <div className="sfb_glint" ref={(el) => { glintRefs.current[i] = el; }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="sfb_pill" role="group" aria-label="Result controls">
          <button type="button" className="sfb_arrow" aria-label="Previous result" ref={prevBtnRef}>
            <svg className="sfb_arrow_icon" viewBox="0 0 16 16" fill="none" aria-hidden="true" ref={prevIconRef}>
              <path d="M10 3L5 8L10 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" className="sfb_arrow" aria-label="Next result" ref={nextBtnRef}>
            <svg className="sfb_arrow_icon" viewBox="0 0 16 16" fill="none" aria-hidden="true" ref={nextIconRef}>
              <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        <div className="sfb_live" aria-live="polite" ref={liveRef} />
      </div>
    </section>
  );
});

export default SplitFlapBoard;
