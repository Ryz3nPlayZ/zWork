// Demo images are from Arqe (arqe.ai). They are placeholders: swap them for your own before going live. Using them in your own product needs your own Arqe plan.
'use client';

import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { CustomEase } from 'gsap/CustomEase';
import './stacking-cards.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP, ScrollTrigger, CustomEase);
}

const ARQE = '/img/report.webp';

const DEFAULT_CARDS = [
  {
    label: 'Open water',
    src: ARQE + 'landscape_ocean-wave_02.jpg?width=1920&format=auto',
    alt: 'A calm hazy sea at dawn',
  },
  {
    label: 'Coast',
    src: ARQE + 'landscape_sailboat_01.jpg?width=1920&format=auto',
    alt: 'White sailboat framed by pines',
  },
  {
    label: 'Court',
    src: ARQE + 'product_tennis-racket_03.jpg?width=1920&format=auto',
    alt: 'A white racket on a wooden bench',
  },
  {
    label: 'Alpine',
    src: ARQE + 'landscape_alpine-tent_01.jpg?width=1920&format=auto',
    alt: 'An open tent door onto snowy peaks',
  },
  {
    label: 'Rest',
    src: ARQE + 'texture_grass_01.jpg?width=1920&format=auto',
    alt: 'Pale grass bending in the wind',
  },
];

// Share of a step the covered card's label takes to fade.
const LABEL_OUT = 0.1;
// The incoming label and the counter play on their own clock, not the scrub.
const LABEL_RISE_DUR = 0.8;
const LABEL_DROP_DUR = 0.4;
// clears the mask with the descender padding included
const LABEL_HIDE = 120;
const COUNT_DUR = 0.6;
// a click holds the counter on its target until the page arrives there
const CLICK_LOCK = 1.5;
const JUMP_DUR = 0.6;
const BREAKPOINTS = {
  mobile: '(max-width: 479px)',
  landscape: '(orientation: landscape) and (max-width: 767px)',
  tablet: '(max-width: 991px)',
  desktop: '(min-width: 992px)',
};

function readNum(value, fallback, min, max) {
  const v = parseFloat(value);
  return isNaN(v) ? fallback : Math.min(max, Math.max(min, v));
}

function pad2(i) {
  return (i < 10 ? '0' : '') + i;
}

function nameOf(card) {
  return card && card.label ? String(card.label).trim() : 'Card';
}

/**
 * StackingCards
 *
 * A stack of photo cards that holds the screen while you scroll. Each new card
 * slides up through a fixed frame and covers the last one, which shrinks back,
 * tilts and sinks out of the way underneath it. A small counter at the bottom
 * of the frame keeps your place, and a click on it jumps to any card. Reduced
 * motion and disabled viewports get the plain list of cards.
 *
 * Config props are read when the section builds; changing one tears the build
 * down and runs it again. shrink, shade and radius are CSS variables only.
 *
 * @param {string} [className=''] - Additional CSS classes for the root section
 * @param {Array} [cards=DEFAULT_CARDS] - Card data: {src, alt, label}. Later cards slide over earlier ones. Landscape photos around 8:5 fit best
 * @param {string} [ariaLabel='Product lines'] - Accessible name of the section
 * @param {number} [stepHeight=50] - Scroll distance per card, in vh (30-120)
 * @param {number} [scrub=0.5] - Seconds the cards take to catch up with the scroll, 0 ties them to the scrollbar (0-3)
 * @param {number} [tilt=2] - Degrees a covered card turns as it sinks; its photo turns the same again (0-6)
 * @param {number} [zoom=1.2] - How far the photo on a covered card zooms in (1-2)
 * @param {number} [drop=20] - How far a covered card sinks, in percent of its height (0-60)
 * @param {number} [drift=10] - How far the incoming photo trails its card, in percent (0-30)
 * @param {number} [shrink=1] - How much a covered card closes in from its edges (0-2)
 * @param {number} [shade=0.5] - How dark a covered card gets (0-1)
 * @param {number} [radius=4] - Corner radius of the frame and every card, in px (0-40)
 * @param {number} [labelDelay=60] - Percent of the slide-in before the incoming label rises (0-95)
 * @param {string} [disable=''] - Comma-separated viewports that show the plain list: desktop,tablet,landscape,mobile
 */
const StackingCards = forwardRef(function StackingCards({
  className = '',
  cards = DEFAULT_CARDS,
  ariaLabel = 'Product lines',
  stepHeight = 50,
  scrub = 0.5,
  tilt = 2,
  zoom = 1.2,
  drop = 20,
  drift = 10,
  shrink = 1,
  shade = 0.5,
  radius = 4,
  labelDelay = 60,
  disable = '',
}, ref) {
  const containerRef = useRef(null);
  const cardRefs = useRef([]);
  const clipRefs = useRef([]);
  const figRefs = useRef([]);
  const imgRefs = useRef([]);
  const labelRefs = useRef([]);
  const textRefs = useRef([]);
  const numRefs = useRef([]);
  const tickRefs = useRef([]);
  const apiRef = useRef(null);
  const [buildId, setBuildId] = useState(0);

  // refresh() rebuilds the section, like window.Anm.StackingCards.refresh()
  useImperativeHandle(ref, () => ({
    refresh: () => setBuildId((id) => id + 1),
  }), []);

  useGSAP((context, contextSafe) => {
    const root = containerRef.current;
    // captured once: the cleanup must restore THESE nodes, even after React
    // has detached the refs of a removed card
    const items = cards.map((card, i) => ({
      card: cardRefs.current[i],
      clip: clipRefs.current[i],
      fig: figRefs.current[i],
      img: imgRefs.current[i],
      label: labelRefs.current[i],
      text: textRefs.current[i],
      name: nameOf(card),
    }));
    if (!root || items.length < 2 || items.some((c) => !c.clip || !c.fig || !c.card)) return;
    const nums = items.map((_, i) => numRefs.current[i]).filter(Boolean);
    const ticks = items.map((_, i) => tickRefs.current[i]).filter(Boolean);

    // The covered card sinks `drop` percent and its photo zooms to `zoom`,
    // which with the shared tilt turns the photo inside its shrinking frame.
    // The incoming photo trails its card by `drift` percent, and its label
    // rises once the card is `labelDelay` of the way in.
    const cfg = {
      stepHeight: readNum(stepHeight, 50, 20, 150),
      tilt: readNum(tilt, 2, -10, 10),
      zoom: readNum(zoom, 1.2, 1, 2),
      drop: readNum(drop, 20, 0, 60),
      drift: readNum(drift, 10, 0, 30),
      labelDelay: readNum(labelDelay, 60, 0, 95) / 100,
      scrub: readNum(scrub, 0.5, 0, 3),
      disable: disable || '',
    };

    CustomEase.create('annnimate', 'M0,0 C0.3,0.9 0.1,1 1,1');

    const n = items.length;
    const risen = [];
    let tl = null;
    let active = -1;
    let lockTo = -1;
    let lockUntil = 0;
    let lastY = null;

    function isDisabled(conditions) {
      if (!cfg.disable) return false;
      return cfg.disable.split(',').some((v) => conditions[v.trim()]);
    }

    function scrollToY(y) {
      if (window.lenis) {
        window.lenis.scrollTo(y, { duration: JUMP_DUR, easing: (t) => 1 - Math.pow(1 - t, 3) });
        return;
      }
      // the host page's own scroller, when it has one - not an element this section owns
      const scroller = document.querySelector('[data-transition-content]');
      if (scroller && scroller.scrollHeight > scroller.clientHeight) scroller.scrollTo({ top: y, behavior: 'smooth' });
      else window.scrollTo({ top: y, behavior: 'smooth' });
    }

    // One step per card after the first: it slides up through the frame with
    // its photo trailing inside it, while the card under it shrinks back,
    // tilts and sinks. The scale lets the trailing photo still cover the card.
    function buildStep(out, inc, i) {
      const step = gsap.timeline({ data: { label: inc.name + ' slides over ' + out.name } });
      step.fromTo(inc.card, { yPercent: 101, y: 0 }, { yPercent: 0, y: 0, duration: 1, ease: 'none', force3D: true }, 0);
      if (cfg.drift && inc.img) {
        step.fromTo(inc.img, { yPercent: -cfg.drift, y: 0, scale: 1 + cfg.drift / 50 }, {
          yPercent: 0, y: 0, scale: 1, duration: 1, ease: 'none', force3D: true,
        }, 0);
      }
      step.fromTo(out.clip, { rotation: 0, yPercent: 0, y: 0, '--stk-c': 0 }, {
        rotation: cfg.tilt, yPercent: cfg.drop, y: 0, '--stk-c': 1, duration: 1, ease: 'none', force3D: true,
      }, 0);
      step.fromTo(out.fig, { scale: 1, rotation: 0 }, {
        scale: cfg.zoom, rotation: cfg.tilt, duration: 1, ease: 'none', force3D: true,
      }, 0);
      if (out.label) step.fromTo(out.label, { opacity: 1 }, { opacity: 0, duration: LABEL_OUT, ease: 'none' }, 0);
      if (ticks[i]) step.fromTo(ticks[i], { '--stk-f': 0 }, { '--stk-f': 1, duration: 1, ease: 'none' }, 0);
      return step;
    }

    function setLabel(i, up, now) {
      const text = items[i].text;
      if (!text || risen[i] === up) return;
      risen[i] = up;
      const yPercent = up ? 0 : LABEL_HIDE;
      if (now) gsap.set(text, { yPercent: yPercent, y: 0, overwrite: true });
      else gsap.to(text, { yPercent: yPercent, y: 0, duration: up ? LABEL_RISE_DUR : LABEL_DROP_DUR, ease: 'annnimate', overwrite: true });
    }

    // The old number leaves the way the scroll is going and the new one
    // follows it in; a change mid-roll carries on from where it is.
    function setActive(i, now) {
      if (i === active) return;
      const prev = active;
      const dir = i > prev ? 1 : -1;
      active = i;
      ticks.forEach((t, k) => {
        if (k === i) t.setAttribute('aria-current', 'true');
        else t.removeAttribute('aria-current');
      });
      if (!nums.length) return;
      if (now || prev < 0) {
        nums.forEach((d, k) => gsap.set(d, { yPercent: k === i ? 0 : 100, y: 0, overwrite: true }));
        return;
      }
      gsap.to(nums[prev], { yPercent: -100 * dir, y: 0, duration: COUNT_DUR, ease: 'annnimate', overwrite: true });
      gsap.fromTo(nums[i], { yPercent: 100 * dir, y: 0 }, { yPercent: 0, y: 0, duration: COUNT_DUR, ease: 'annnimate', overwrite: true });
    }

    // A scroll plays the changes; a refresh at the same scroll position only
    // sets them, so nothing plays without input.
    function sync(self) {
      const y = self.scroll();
      const now = lastY === null || y === lastY;
      lastY = y;
      const pos = self.progress * (n - 1);
      for (let i = 1; i < n; i++) setLabel(i, pos >= i - 1 + cfg.labelDelay, now);
      if (lockTo >= 0) {
        if (Math.round(pos) !== lockTo && performance.now() < lockUntil) return;
        lockTo = -1;
      }
      setActive(Math.round(pos), now);
    }

    function scrollToCard(i) {
      const st = tl && tl.scrollTrigger;
      if (!st || i < 0) return;
      lockTo = i;
      lockUntil = performance.now() + CLICK_LOCK * 1000;
      setActive(i, false);
      scrollToY(st.start + (st.end - st.start) * (i / (n - 1)));
    }

    // The track is one screen plus one step per card after the first, so the
    // stage sticks exactly while the steps run, back to back.
    function build() {
      root.classList.remove('stk_is-static');
      root.style.setProperty('--stk-n', n);
      root.style.setProperty('--stk-step', cfg.stepHeight);
      tl = gsap.timeline({
        scrollTrigger: { trigger: root, start: 'top top', end: 'bottom bottom', scrub: cfg.scrub || true, onUpdate: sync },
      });
      for (let i = 1; i < n; i++) tl.add(buildStep(items[i - 1], items[i], i), i - 1);
      risen.length = 0;
      active = -1;
      lastY = null;
      sync(tl.scrollTrigger);
    }

    function teardown() {
      root.style.removeProperty('--stk-n');
      root.style.removeProperty('--stk-step');
      const rolled = nums.concat(items.map((c) => c.text).filter(Boolean));
      gsap.killTweensOf(rolled);
      gsap.set(rolled, { clearProps: 'transform' });
      ticks.forEach((t) => t.removeAttribute('aria-current'));
      tl = null;
    }

    function onVisibility() {
      if (document.hidden) gsap.globalTimeline.pause();
      else gsap.globalTimeline.resume();
    }

    apiRef.current = { scrollToCard: contextSafe(scrollToCard) };
    document.addEventListener('visibilitychange', onVisibility);

    // Reduced motion and disabled viewports get the plain list of cards.
    const mm = gsap.matchMedia();
    mm.add(Object.assign({
      motion: '(prefers-reduced-motion: no-preference)',
      reduce: '(prefers-reduced-motion: reduce)',
    }, BREAKPOINTS), (ctx) => {
      if (ctx.conditions.reduce || isDisabled(ctx.conditions)) {
        root.classList.add('stk_is-static');
        return undefined;
      }
      build();
      return teardown;
    });

    return () => {
      apiRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      mm.revert();
      root.classList.remove('stk_is-static');
    };
  }, {
    scope: containerRef,
    // className is here because a new className prop rewrites the root's class
    // attribute and drops the stk_is-static flag the build manages
    dependencies: [cards, stepHeight, scrub, tilt, zoom, drop, drift, labelDelay, disable, className, buildId],
    revertOnUpdate: true,
  });

  const handleTick = useCallback((i) => {
    if (apiRef.current) apiRef.current.scrollToCard(i);
  }, []);

  // The look-only settings are CSS variables, so they never rebuild the stack.
  const style = {
    '--stk-shrink': readNum(shrink, 1, 0, 2),
    '--stk-shade': readNum(shade, 0.5, 0, 1),
    '--stk-radius': readNum(radius, 4, 0, 40) + 'px',
  };

  return (
    <section
      ref={containerRef}
      className={'stk_section' + (className ? ' ' + className : '')}
      data-anm-stacking-cards
      aria-label={ariaLabel}
      style={style}
    >
      <div className="stk_stage">
        <div className="stk_view">
          <ol className="stk_frame">
            {cards.map((card, i) => (
              <li
                key={i}
                ref={(el) => { cardRefs.current[i] = el; }}
                className="stk_card"
                data-anm-stk-card
              >
                <div
                  ref={(el) => { clipRefs.current[i] = el; }}
                  className="stk_clip"
                  data-anm-stk-clip
                >
                  <figure
                    ref={(el) => { figRefs.current[i] = el; }}
                    className="stk_fig"
                    data-anm-stk-fig
                  >
                    <img
                      ref={(el) => { imgRefs.current[i] = el; }}
                      className="stk_img"
                      src={card.src}
                      alt={card.alt}
                    />
                    {card.label ? (
                      <figcaption
                        ref={(el) => { labelRefs.current[i] = el; }}
                        className="stk_label"
                        data-anm-stk-label
                      >
                        <span
                          ref={(el) => { textRefs.current[i] = el; }}
                          className="stk_label_text"
                        >
                          {card.label}
                        </span>
                      </figcaption>
                    ) : null}
                    <span className="stk_card_index" aria-hidden="true">{pad2(i + 1)}</span>
                  </figure>
                </div>
              </li>
            ))}
          </ol>
          <nav className="stk_index" data-anm-stk-index aria-label="Card index">
            {cards.length >= 2 ? (
              <>
                <span className="stk_count" aria-hidden="true">
                  <span className="stk_num">
                    {cards.map((_, i) => (
                      <span key={i} ref={(el) => { numRefs.current[i] = el; }}>{pad2(i + 1)}</span>
                    ))}
                  </span>
                  <span className="stk_total">{'/ ' + pad2(cards.length)}</span>
                </span>
                <span className="stk_ticks">
                  {cards.map((card, i) => (
                    <button
                      key={i}
                      ref={(el) => { tickRefs.current[i] = el; }}
                      type="button"
                      className="stk_tick"
                      aria-label={nameOf(card)}
                      onClick={() => handleTick(i)}
                    />
                  ))}
                </span>
              </>
            ) : null}
          </nav>
        </div>
      </div>
    </section>
  );
});

export default StackingCards;
