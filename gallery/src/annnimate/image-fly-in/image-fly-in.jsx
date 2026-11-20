// Demo images are from Arqe (arqe.ai). They are placeholders: swap them for your own before going live. Using them in your own product needs your own Arqe plan.
'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import { CustomEase } from 'gsap/CustomEase';
import './image-fly-in.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText, CustomEase);
  CustomEase.create('annnimate', 'M0,0 C0.3,0.9 0.1,1 1,1');
}

const DEFAULT_IMAGES = [
  { src: '/img/report.webp', alt: 'Padel racket on black', aspect: 'portrait_lg' },
  { src: '/img/report.webp', alt: 'Black tennis racket', aspect: 'portrait_md' },
  { src: '/img/report.webp', alt: 'Silver shield sunglasses', aspect: 'portrait_sm' },
  { src: '/img/report.webp', alt: 'Dark leather ball', aspect: 'portrait_lg', hideMobile: true },
  { src: '/img/report.webp', alt: 'Dark carbon bike frame and saddle', aspect: 'portrait_md' },
  { src: '/img/report.webp', alt: 'Snowboarder in goggles and a white jacket', aspect: 'portrait_sm', hideMobile: true },
  { src: '/img/report.webp', alt: 'Table tennis paddle edge on dark red', aspect: 'portrait_lg', hideMobile: true },
  { src: '/img/report.webp', alt: 'Leaf macro on black', aspect: 'landscape_lg' },
  { src: '/img/report.webp', alt: 'Cream surfboard nose on deep red', aspect: 'landscape_sm', hideMobile: true },
  { src: '/img/report.webp', alt: 'Padel racket face with holes, macro', aspect: 'square_lg' },
  { src: '/img/report.webp', alt: 'Red and violet helmet blur on black', aspect: 'square_sm', hideMobile: true },
  { src: '/img/report.webp', alt: 'Spoon of matcha on a white floor', aspect: 'square_sm' },
];

const EXIT_Z = 400;
const PLATEAU_Z_START = -200;
const PLATEAU_Z_END = -80;
const HOLE_X_MAX = 0.42;
const HOLE_Y_MAX = 0.35;
const HOLE_SOFT_EDGE = 80;
const VELOCITY_LERP = 0.06;
const VELOCITY_DIVISOR = 60;
const PAN_LERP_DUR = 1.2;
const PAN_Y_RATIO = 0.8;

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * ImageFlyIn
 *
 * Full-viewport dark 3D depth field. Imagery continuously flies in from deep
 * inside the page toward the viewer, fading in and out around the centre
 * content, with cursor pan parallax on the whole 3D stage. The content
 * element's rectangle is MEASURED and images never spawn inside it.
 *
 * @param {string}  [className='']       - Additional CSS classes for the root element
 * @param {Array}   [images]             - Array of { src, alt, aspect, hideMobile } - defaults to the 12 demo images
 * @param {string}  [headline]           - Manifesto headline text
 * @param {string}  [support]            - Support paragraph under the headline
 * @param {number}  [duration=10]        - Full fly-in cycle length in seconds at base speed
 * @param {number}  [depth=2000]         - Spawn depth in px
 * @param {number}  [speed=1]            - Base drift speed multiplier
 * @param {number}  [scrollBoost=3.5]    - Max scroll-velocity speed multiplier (0 disables)
 * @param {number}  [pan=40]             - Max cursor pan of the field in px (0 disables cursor parallax)
 * @param {number}  [holeBuffer=120]      - Extra px of clearance around the measured content zone
 */
export default function ImageFlyIn({
  className = '',
  images = DEFAULT_IMAGES,
  headline = 'Everything else is noise.',
  support = 'What is left when the season strips away the rest.',
  duration = 10,
  depth = 2000,
  speed = 1,
  scrollBoost = 3.5,
  pan = 40,
  holeBuffer = 120,
}) {
  const rootRef = useRef(null);
  const stageRef = useRef(null);
  const contentRef = useRef(null);
  const headlineRef = useRef(null);
  const supportRef = useRef(null);
  const cardRefs = useRef([]);
  cardRefs.current = [];

  const [fontsLoaded, setFontsLoaded] = useState(false);

  useEffect(() => {
    const p = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    p.then(() => setFontsLoaded(true));
  }, []);

  const addCardRef = useCallback((el) => {
    if (el && !cardRefs.current.includes(el)) cardRefs.current.push(el);
  }, []);

  useGSAP(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    const content = contentRef.current;
    const headlineEl = headlineRef.current;
    const supportEl = supportRef.current;
    const cards = cardRefs.current;

    if (!root || !stage || !cards.length) return;

    const reducedMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
    const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
    let reduced = reducedMQ.matches;

    let viewportW = window.innerWidth;
    let viewportH = window.innerHeight;
    let velocityMultiplier = 1;
    let lastScrollY = window.scrollY || window.pageYOffset || 0;
    let running = false;

    const cardStates = [];
    const setters = [];

    let holeXHalfPx = 0;
    let holeYHalfPx = 0;
    const perspectivePx = parseFloat(getComputedStyle(root).perspective) || 1200;
    const cardHalfW = [];
    const cardHalfH = [];

    // Measure the centre content element and derive the spawn-free zone from
    // its actual rectangle plus the buffer. No content = no exclusion.
    function measureHole() {
      holeXHalfPx = 0;
      holeYHalfPx = 0;
      if (!content) return;
      const rect = content.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      holeXHalfPx = Math.min(rect.width / 2 + holeBuffer, viewportW * HOLE_X_MAX);
      holeYHalfPx = Math.min(rect.height / 2 + holeBuffer, viewportH * HOLE_Y_MAX);
    }

    // The spawn test and the per-frame zone fade need the card EDGES, not
    // just its centre.
    function measureCards() {
      cards.forEach((card, i) => {
        cardHalfW[i] = card.offsetWidth / 2;
        cardHalfH[i] = card.offsetHeight / 2;
      });
    }

    function randomScatterPosition(halfW, halfH) {
      let x, y, attempts = 0;
      do {
        x = Math.random() - 0.5;
        y = Math.random() - 0.5;
        attempts += 1;
      } while (
        Math.abs(x) * viewportW < holeXHalfPx + halfW &&
        Math.abs(y) * viewportH < holeYHalfPx + halfH &&
        attempts < 12
      );
      return { xFrac: x, yFrac: y };
    }

    function spawnCard(state, delayIntoCycle, i) {
      const pos = randomScatterPosition(cardHalfW[i] || 0, cardHalfH[i] || 0);
      state.xFrac = pos.xFrac;
      state.yFrac = pos.yFrac;
      state.progress = delayIntoCycle || 0;
    }

    // Per-frame dim so a card never reads on top of the content zone. Works
    // in PROJECTED screen space: the perspective divide pulls far cards
    // toward the centre and the cursor pan shifts the whole field, so a
    // spawn-time test alone cannot keep the zone clear.
    function holeFadeFactor(i, z, panX, panY) {
      if (!holeXHalfPx && !holeYHalfPx) return 1;
      const s = perspectivePx / (perspectivePx - z);
      const state = cardStates[i];
      const projX = (state.xFrac * viewportW + panX) * s;
      const projY = (state.yFrac * viewportH + panY) * s;
      const sepX = Math.abs(projX) - (holeXHalfPx + (cardHalfW[i] || 0) * s);
      const sepY = Math.abs(projY) - (holeYHalfPx + (cardHalfH[i] || 0) * s);
      return smoothstep(clamp01(Math.max(sepX, sepY) / HOLE_SOFT_EDGE));
    }

    function opacityForZ(z) {
      if (z <= -depth) return 0;
      if (z < PLATEAU_Z_START) {
        const t = (z + depth) / (PLATEAU_Z_START + depth);
        return smoothstep(clamp01(t));
      }
      if (z <= PLATEAU_Z_END) return 1;
      if (z < EXIT_Z) {
        const t = (z - PLATEAU_Z_END) / (EXIT_Z - PLATEAU_Z_END);
        return 1 - smoothstep(clamp01(t));
      }
      return 0;
    }

    function buildCardStates() {
      cardStates.length = 0;
      setters.length = 0;
      cards.forEach((card, i) => {
        const state = { xFrac: 0, yFrac: 0, progress: i / cards.length };
        cardStates.push(state);
        spawnCard(state, i / cards.length, i);
        setters.push({
          x: gsap.quickSetter(card, 'x', 'px'),
          y: gsap.quickSetter(card, 'y', 'px'),
          z: gsap.quickSetter(card, 'z', 'px'),
          opacity: gsap.quickSetter(card, 'opacity'),
        });
      });
    }

    function tick() {
      if (!running) return;
      const dt = gsap.ticker.deltaRatio(60) / 60;
      const rate = (speed * velocityMultiplier) / duration;
      velocityMultiplier += (1 - velocityMultiplier) * VELOCITY_LERP;
      const totalTravel = EXIT_Z - -depth;

      const panX = quickPanX ? Number(gsap.getProperty(stage, 'x')) || 0 : 0;
      const panY = quickPanY ? Number(gsap.getProperty(stage, 'y')) || 0 : 0;

      for (let i = 0; i < cardStates.length; i++) {
        const state = cardStates[i];
        state.progress += rate * dt;
        if (state.progress >= 1) spawnCard(state, state.progress - 1, i);

        const z = -depth + state.progress * totalTravel;
        const opacity = opacityForZ(z) * holeFadeFactor(i, z, panX, panY);
        setters[i].x(state.xFrac * viewportW);
        setters[i].y(state.yFrac * viewportH);
        setters[i].z(z);
        setters[i].opacity(opacity);
      }
    }

    function startTicker() {
      if (running) return;
      running = true;
      gsap.ticker.add(tick);
    }

    function stopTicker() {
      running = false;
      gsap.ticker.remove(tick);
    }

    // Cursor pan (no rotation): the field slides WITH the pointer - cursor
    // left moves the field further left. Perspective makes near cards shift
    // more than far ones, so depth parallax comes for free. Long quickTo
    // duration keeps it fluid rather than responsive.
    let quickPanX, quickPanY;

    function onPointerMove(e) {
      const rect = root.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
      quickPanX(nx * pan);
      quickPanY(ny * pan * PAN_Y_RATIO);
    }

    function onPointerLeave() {
      quickPanX(0);
      quickPanY(0);
    }

    if (!isCoarsePointer && !reduced && pan > 0) {
      quickPanX = gsap.quickTo(stage, 'x', { duration: PAN_LERP_DUR, ease: 'power3.out' });
      quickPanY = gsap.quickTo(stage, 'y', { duration: PAN_LERP_DUR, ease: 'power3.out' });
      root.addEventListener('pointermove', onPointerMove);
      root.addEventListener('pointerleave', onPointerLeave);
    }

    function onScroll() {
      const y = window.scrollY || window.pageYOffset || 0;
      const dlt = Math.abs(y - lastScrollY);
      lastScrollY = y;
      if (scrollBoost > 0) {
        const boost = 1 + Math.min(dlt / VELOCITY_DIVISOR, 1) * (scrollBoost - 1);
        velocityMultiplier = Math.max(velocityMultiplier, boost);
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true });

    let resizeTimer;
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        viewportW = window.innerWidth;
        viewportH = window.innerHeight;
        measureHole();
        measureCards();
        ScrollTrigger.refresh();
      }, 150);
    }
    window.addEventListener('resize', onResize);

    let isIntersecting = true;
    let io = null;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          isIntersecting = entry.isIntersecting;
          if (isIntersecting && !document.hidden) startTicker();
          else stopTicker();
        });
      }, { threshold: 0 });
      io.observe(root);
    }

    function onVisibilityChange() {
      if (document.hidden) {
        stopTicker();
        gsap.globalTimeline.pause();
      } else {
        gsap.globalTimeline.resume();
        if (isIntersecting) startTicker();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    // --- Headline reveal (ordinary scroll-enter, SplitText line masks) ---
    let split = null;
    let supportSplit = null;
    let revealTl = null;
    let revealSt = null;

    if (fontsLoaded && headlineEl) {
      split = SplitText.create(headlineEl, { type: 'lines', mask: 'lines', linesClass: 'ifi_headline_line' });
      if (supportEl) supportSplit = SplitText.create(supportEl, { type: 'lines', mask: 'lines', linesClass: 'ifi_support_line' });

      const headlineLines = split.lines;
      const supportLines = supportSplit ? supportSplit.lines : [];

      gsap.set(headlineLines, { yPercent: 110, y: 0 });
      if (supportLines.length) gsap.set(supportLines, { yPercent: 110, y: 0 });

      revealTl = gsap.timeline({ paused: true, defaults: { ease: 'annnimate', force3D: true } });
      revealTl.fromTo(headlineLines, { yPercent: 110, y: 0 }, { yPercent: 0, y: 0, duration: 1.1, stagger: 0.08 });
      if (supportLines.length) {
        revealTl.fromTo(supportLines, { yPercent: 110, y: 0 }, { yPercent: 0, y: 0, duration: 0.9, stagger: 0.05 }, '-=0.6');
      }

      function inFirstViewport() {
        const r = root.getBoundingClientRect();
        return r.top < window.innerHeight && r.bottom > 0;
      }

      requestAnimationFrame(() => {
        if (inFirstViewport()) {
          revealTl.restart();
        } else {
          revealSt = ScrollTrigger.create({
            trigger: root,
            start: 'top 80%',
            once: true,
            onEnter: () => revealTl.restart(),
          });
        }
        ScrollTrigger.refresh();
      });
    }

    // --- Init ---
    gsap.set(cards, { force3D: true, willChange: 'transform, opacity' });
    gsap.set(stage, { force3D: true });
    if (content) gsap.set(content, { force3D: true });
    measureHole();
    measureCards();
    buildCardStates();

    if (reduced) {
      cards.forEach((card, i) => {
        const state = cardStates[i];
        gsap.set(card, { x: state.xFrac * viewportW, y: state.yFrac * viewportH, z: -200, opacity: 0.9 });
      });
      if (revealTl) revealTl.timeScale(20);
    } else {
      startTicker();
    }

    return () => {
      stopTicker();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (io) io.disconnect();
      if (revealTl) revealTl.kill();
      if (revealSt) revealSt.kill();
      if (split) split.revert();
      if (supportSplit) supportSplit.revert();
    };
  }, {
    scope: rootRef,
    dependencies: [fontsLoaded, images, headline, support, duration, depth, speed, scrollBoost, pan, holeBuffer],
  });

  return (
    <section
      ref={rootRef}
      className={`ifi_section${className ? ' ' + className : ''}`}
      data-anm-image-fly-in
    >
      <div ref={stageRef} className="ifi_stage" data-anm-ifi-stage>
        {images.map((img, i) => (
          <div
            key={img.src + i}
            ref={addCardRef}
            className={`ifi_card ifi_card_${img.aspect}${img.hideMobile ? ' ifi_card_hide_mobile' : ''}`}
            data-anm-ifi-card
          >
            <img className="ifi_card_img" src={img.src} alt={img.alt || ''} />
          </div>
        ))}
      </div>

      <div ref={contentRef} className="ifi_content" data-anm-ifi-content>
        <h2 ref={headlineRef} className="ifi_headline" data-anm-ifi-headline>{headline}</h2>
        {support ? (
          <p ref={supportRef} className="ifi_support" data-anm-ifi-support>{support}</p>
        ) : null}
      </div>
    </section>
  );
}
