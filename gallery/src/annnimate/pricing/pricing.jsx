'use client';

import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { CustomEase } from 'gsap/CustomEase';
import './pricing.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP, CustomEase);
  CustomEase.create('annnimate', 'M0,0 C0.3,0.9 0.1,1 1,1');
  CustomEase.create('annnimateInOut', 'M0,0 C0.7,0 0.16,1 1,1');
}

const DEFAULT_PLANS = [
  {
    name: 'Rider',
    nameClass: 'prc_name_silver',
    monthly: 20,
    yearly: 199,
    popular: false,
    features: ['Route access in every region', 'Weekly group rides', 'Member pricing on kit', 'Monthly route journal'],
    ctaLabel: 'Join Rider',
  },
  {
    name: 'Club',
    nameClass: 'prc_name_champagne',
    monthly: 55,
    yearly: 549,
    popular: true,
    features: ['Everything in Rider', 'Demo bikes at Ridge camp', 'Mechanic on every ride', 'Guided col days', 'Early access to drops'],
    ctaLabel: 'Join Club',
  },
  {
    name: 'Guide',
    nameClass: 'prc_name_ice',
    monthly: 119,
    yearly: 1199,
    popular: false,
    features: ['Everything in Club', 'A guide per six riders', 'Hut to Hut planning', 'Camp invites', 'Private storage in Vienna'],
    ctaLabel: 'Join Guide',
  },
];

const DEFAULT_LOGO_SRC = '/img/report.webp';

const BREAKPOINTS = {
  mobile: '(max-width: 479px)',
  landscape: '(orientation: landscape) and (max-width: 767px)',
  tablet: '(max-width: 991px)',
  desktop: '(min-width: 992px)',
};

/**
 * Pricing Component
 * A pricing section with a monthly/yearly switch. Flipping it rolls every
 * price digit by digit, smears the toggle knob across its travel, pops a
 * savings chip beside the toggle, and keeps a constant shimmer on each plan
 * name. Section-owned layout - no Webflow.
 *
 * @param {string} [className=''] - Additional CSS classes for the wrapper
 * @param {string} [title='Membership'] - Heading above the toggle
 * @param {string} [logoSrc] - Logo image src shown above the title
 * @param {string} [logoAlt='Vanta'] - Logo alt text
 * @param {Array} [plans] - Plan cards: { name, nameClass, monthly, yearly, popular, features, ctaLabel }
 * @param {number} [rollDuration=0.45] - Price digit roll duration (seconds)
 * @param {number} [digitStagger=0.04] - Delay between each digit column's roll, from the right
 * @param {number} [toggleDuration=0.28] - Knob travel duration across the toggle
 * @param {number} [shimmerDuration=2.4] - Plan name shimmer cycle duration
 * @param {string} [savingsLabel='Save 17%'] - Text shown in the savings chip on yearly
 * @param {string} [defaultPeriod='monthly'] - 'monthly' or 'yearly'
 * @param {string} [currency='EUR'] - Currency symbol or code shown before each price
 * @param {boolean} [showSavingsChip=true] - Whether the savings chip reveals on yearly
 * @param {string} [ease='annnimateInOut'] - GSAP easing for the knob travel and rolls
 * @param {string} [disable=''] - Comma-separated viewports to disable on (desktop,tablet,landscape,mobile)
 */
const Pricing = forwardRef(function Pricing(
  {
    className = '',
    title = 'Membership',
    logoSrc = DEFAULT_LOGO_SRC,
    logoAlt = 'Vanta',
    plans = DEFAULT_PLANS,
    rollDuration = 0.45,
    digitStagger = 0.04,
    toggleDuration = 0.28,
    shimmerDuration = 2.4,
    savingsLabel = 'Save 17%',
    defaultPeriod = 'monthly',
    currency = 'EUR',
    showSavingsChip = true,
    ease = 'annnimateInOut',
    disable = '',
  },
  ref
) {
  const containerRef = useRef(null);
  const toggleRef = useRef(null);
  const knobRef = useRef(null);
  const chipRef = useRef(null);
  const chipInnerRef = useRef(null);
  const priceRefs = useRef([]);
  const periodRefs = useRef([]);
  const currencyRefs = useRef([]);
  const srRefs = useRef([]);
  const nameRefs = useRef([]);
  const cardsRef = useRef([]);
  const apiRef = useRef(null);

  useGSAP(
    (context, contextSafe) => {
      if (!toggleRef.current || !knobRef.current || !plans.length) return;

      const disableList = (disable || '').split(',').map((v) => v.trim()).filter(Boolean);
      const disabledHere = disableList.some((v) => {
        const q = BREAKPOINTS[v];
        return q && window.matchMedia(q).matches;
      });
      if (disabledHere) return;

      const KNOB_STRETCH_DUR = toggleDuration * 0.35;
      const KNOB_SETTLE_DUR = toggleDuration * 0.45;
      const KNOB_SMEAR_SCALE = 1.18;
      const CHIP_DUR = 0.28;
      const DIGIT_WIDTH = '0.6em';
      const PERIOD_ROLL_DUR = 0.4;

      const normalizedDefault = defaultPeriod === 'yearly' ? 'yearly' : 'monthly';
      let period = normalizedDefault;
      let reducedMotion = false;
      let activeTl = null;

      function digitsOf(value) {
        return String(Math.round(value)).split('');
      }

      function buildDigitColumn(digitChar) {
        const col = document.createElement('span');
        col.className = 'prc_digit_col';
        const roller = document.createElement('span');
        roller.className = 'prc_digit_roller';
        for (let d = 0; d <= 9; d++) {
          const face = document.createElement('span');
          face.className = 'prc_digit_face';
          face.textContent = String(d);
          roller.appendChild(face);
        }
        col.appendChild(roller);
        gsap.set(roller, { y: -parseInt(digitChar, 10) + 'em' });
        return col;
      }

      // Called when a toggle interrupts a running one: columns still clipping
      // out are removed now, columns still clipping in snap to full width, so
      // the next roll starts from a consistent column set.
      function settlePrice(priceEl) {
        Array.prototype.slice.call(priceEl.querySelectorAll('[data-dropping]')).forEach((col) => col.remove());
        gsap.set(priceEl.children, { clearProps: 'width' });
      }

      function setPriceValue(priceEl, value) {
        priceEl.innerHTML = '';
        digitsOf(value).forEach((ch) => priceEl.appendChild(buildDigitColumn(ch)));
      }

      // Rolls a price to a new value on the master timeline `tl`, at `pos`.
      // Digit count can change between plans (20 -> 199): columns the new
      // value no longer needs clip out and are removed on complete, columns
      // it gains clip in from zero width, and the overlapping right-aligned
      // columns just roll like a normal odometer, staggered from the right.
      function addPriceRoll(tl, priceEl, value, pos, label) {
        const newDigits = digitsOf(value);
        const cols = Array.prototype.slice.call(priceEl.children);
        const diff = newDigits.length - cols.length;

        if (diff > 0) {
          for (let i = 0; i < diff; i++) {
            const col = buildDigitColumn('0');
            gsap.set(col, { width: 0 });
            priceEl.insertBefore(col, priceEl.firstChild);
            tl.to(col, {
              width: DIGIT_WIDTH,
              duration: rollDuration,
              ease: 'expo.out',
              overwrite: true,
              data: { label: label + ' gains a digit' },
            }, pos);
          }
        } else if (diff < 0) {
          for (let i = 0; i < -diff; i++) {
            const col = cols[i];
            col.dataset.dropping = '1';
            tl.to(col, {
              width: 0,
              duration: rollDuration * 0.7,
              ease: 'expo.inOut',
              overwrite: true,
              data: { label: label + ' drops a digit' },
              onComplete: () => { col.remove(); },
            }, pos);
          }
        }

        const remaining = diff < 0 ? cols.slice(-diff) : Array.prototype.slice.call(priceEl.children);
        const alignDigits = newDigits;
        const rollers = remaining.map((col) => col.querySelector('.prc_digit_roller'));

        tl.to(rollers, {
          y: (i) => -parseInt(alignDigits[i], 10) + 'em',
          duration: rollDuration,
          ease: 'expo.out',
          stagger: { each: digitStagger, from: 'end' },
          force3D: true,
          overwrite: true,
          data: { label: label + ' rolls to the new value' },
        }, pos);
      }

      // A two-face masked roll for the /mo <-> /yr period label. Both faces
      // are written once at build time, so a toggle only ever tweens a y
      // offset - never a textContent write on animated markup.
      function buildSwap(el, textA, textB, startOnB) {
        el.innerHTML = '';
        const mask = document.createElement('span');
        mask.className = 'prc_swap';
        const a = document.createElement('span');
        a.className = 'prc_swap_face';
        a.textContent = textA;
        const b = document.createElement('span');
        b.className = 'prc_swap_face prc_swap_face_next';
        b.textContent = textB;
        mask.appendChild(a);
        mask.appendChild(b);
        el.appendChild(mask);
        const swap = { mask, a, b };
        gsap.set(mask, { yPercent: startOnB ? -100 : 0 });
        setSwapAria(swap, startOnB);
        return swap;
      }

      function setSwapAria(swap, toB) {
        swap.a.setAttribute('aria-hidden', toB ? 'true' : 'false');
        swap.b.setAttribute('aria-hidden', toB ? 'false' : 'true');
      }

      function updateSrPrice(card, toYearly) {
        if (!card.srEl) return;
        const value = toYearly ? card.yearly : card.monthly;
        card.srEl.textContent = currency + ' ' + value + ' per ' + (toYearly ? 'year' : 'month');
      }

      // The highlight band of each name gradient sweeps across the text on a
      // constant loop, offset per card so the three never sweep in unison.
      // The gradient is periodic (two bands over a 200% image), so one
      // linear pass from 100% to 0% shifts it by exactly one period and the
      // repeat is seamless. Each card starts a third of a cycle apart.
      function startShimmerLoop(nameEl, index) {
        if (!nameEl || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
        const t = gsap.fromTo(nameEl, { backgroundPosition: '100% 0%' }, {
          backgroundPosition: '0% 0%',
          duration: shimmerDuration,
          ease: 'none',
          repeat: -1,
          data: { label: 'Plan name shimmer loop' },
        });
        t.progress((index / 3) % 1);
        return t;
      }

      function buildCard(index) {
        const priceEl = priceRefs.current[index];
        const periodEl = periodRefs.current[index];
        const currencyEl = currencyRefs.current[index];
        const srEl = srRefs.current[index];
        const nameEl = nameRefs.current[index];
        const plan = plans[index];
        if (!priceEl || !periodEl) return null;

        priceEl.setAttribute('aria-hidden', 'true');
        periodEl.setAttribute('aria-hidden', 'true');
        if (currencyEl) currencyEl.textContent = currency;

        const startOnYearly = period === 'yearly';
        const periodSwap = buildSwap(periodEl, '/mo', '/yr', startOnYearly);
        setPriceValue(priceEl, startOnYearly ? plan.yearly : plan.monthly);

        const card = {
          monthly: plan.monthly,
          yearly: plan.yearly,
          priceEl,
          nameEl,
          periodSwap,
          srEl,
        };
        updateSrPrice(card, startOnYearly);
        return card;
      }

      function applyPeriod(newPeriod) {
        if (newPeriod === period) return null;
        if (activeTl) {
          activeTl.kill();
          activeTl = null;
          cardsRef.current.forEach((card) => settlePrice(card.priceEl));
        }
        const toYearly = newPeriod === 'yearly';
        period = newPeriod;
        toggleRef.current.setAttribute('aria-checked', String(toYearly));

        cardsRef.current.forEach((card) => updateSrPrice(card, toYearly));

        if (reducedMotion) {
          const originSide = toYearly ? 'left' : 'right';
          gsap.set(knobRef.current, { transformOrigin: originSide + ' center', x: toYearly ? '100%' : '0%', scaleX: 1 });
          cardsRef.current.forEach((card) => {
            setPriceValue(card.priceEl, toYearly ? card.yearly : card.monthly);
            gsap.set(card.periodSwap.mask, { yPercent: toYearly ? -100 : 0 });
            setSwapAria(card.periodSwap, toYearly);
          });
          if (chipRef.current) {
            const chipOn = showSavingsChip && toYearly;
            gsap.set(chipRef.current, { scale: chipOn ? 1 : 0, autoAlpha: chipOn ? 1 : 0 });
          }
          return null;
        }

        const originSide = toYearly ? 'left' : 'right';
        gsap.set(knobRef.current, { transformOrigin: originSide + ' center' });

        const tl = gsap.timeline({
          defaults: { force3D: true },
          onComplete: () => { activeTl = null; },
        });
        activeTl = tl;

        tl.to(knobRef.current, {
          x: toYearly ? '100%' : '0%',
          duration: toggleDuration,
          ease,
          data: { label: 'Toggle knob travels to the new position' },
        }, 0);
        tl.to(knobRef.current, {
          scaleX: KNOB_SMEAR_SCALE,
          duration: KNOB_STRETCH_DUR,
          ease: 'power2.out',
          data: { label: 'Toggle knob stretches along the travel axis' },
        }, 0);
        tl.to(knobRef.current, {
          scaleX: 1,
          duration: KNOB_SETTLE_DUR,
          ease: 'power2.inOut',
          data: { label: 'Toggle knob snaps back to shape' },
        }, KNOB_STRETCH_DUR);

        if (chipRef.current) {
          if (toYearly && showSavingsChip) {
            gsap.set(chipRef.current, { autoAlpha: 1 });
            tl.to(chipRef.current, {
              scale: 1,
              duration: CHIP_DUR,
              ease: 'back.out(1.7)',
              data: { label: 'Savings chip pops in' },
            }, 0.05);
          } else {
            tl.to(chipRef.current, {
              scale: 0,
              duration: CHIP_DUR * 0.8,
              ease: 'power3.out',
              data: { label: 'Savings chip shrinks out' },
              onComplete: () => { gsap.set(chipRef.current, { autoAlpha: 0 }); },
            }, 0);
          }
        }

        cardsRef.current.forEach((card, i) => {
          const label = 'Card ' + (i + 1) + ' price';
          addPriceRoll(tl, card.priceEl, toYearly ? card.yearly : card.monthly, 0, label);

          setSwapAria(card.periodSwap, toYearly);
          tl.to(card.periodSwap.mask, {
            yPercent: toYearly ? -100 : 0,
            duration: PERIOD_ROLL_DUR,
            ease: 'annnimate',
            data: { label: label + ' period label rolls' },
          }, 0.05);
        });

        return tl;
      }

      const safeApplyPeriod = contextSafe(applyPeriod);

      cardsRef.current = plans.map((_, i) => buildCard(i)).filter(Boolean);
      if (!cardsRef.current.length) return;

      function handleToggleClick() {
        safeApplyPeriod(period === 'monthly' ? 'yearly' : 'monthly');
      }
      toggleRef.current.addEventListener('click', handleToggleClick);

      // --- Initial DOM state ---
      containerRef.current.setAttribute('role', 'region');
      toggleRef.current.setAttribute('role', 'switch');
      toggleRef.current.setAttribute('aria-checked', String(period === 'yearly'));
      toggleRef.current.setAttribute('aria-label', 'Billing period');

      const startOnYearly = period === 'yearly';
      gsap.set(knobRef.current, {
        transformOrigin: (startOnYearly ? 'left' : 'right') + ' center',
        x: startOnYearly ? '100%' : '0%',
        scaleX: 1,
      });
      if (chipRef.current) {
        if (chipInnerRef.current) chipInnerRef.current.textContent = savingsLabel;
        const chipOn = showSavingsChip && startOnYearly;
        gsap.set(chipRef.current, {
          transformOrigin: 'center center',
          yPercent: -50,
          scale: chipOn ? 1 : 0,
          autoAlpha: chipOn ? 1 : 0,
        });
      }

      gsap.matchMedia().add('(prefers-reduced-motion: reduce)', () => {
        reducedMotion = true;
        return () => { reducedMotion = false; };
      });

      const shimmerLoops = cardsRef.current.map((card, i) => startShimmerLoop(card.nameEl, i)).filter(Boolean);

      function handleVisibility() {
        if (document.hidden) gsap.globalTimeline.pause();
        else gsap.globalTimeline.resume();
      }
      document.addEventListener('visibilitychange', handleVisibility);

      // Timeline inspector demo (ADR-0011): one full toggle to the opposite
      // period, then back to the default.
      apiRef.current = {
        getPeriod: () => period,
        setPeriod: (p) => safeApplyPeriod(p === 'yearly' ? 'yearly' : 'monthly'),
        demo: () => {
          const target = period === 'monthly' ? 'yearly' : 'monthly';
          const handle = safeApplyPeriod(target);
          setTimeout(() => {
            if (period !== normalizedDefault) safeApplyPeriod(normalizedDefault);
          }, (toggleDuration + rollDuration) * 1000 + 500);
          return handle;
        },
      };

      return () => {
        document.removeEventListener('visibilitychange', handleVisibility);
        toggleRef.current?.removeEventListener('click', handleToggleClick);
        shimmerLoops.forEach((t) => t.kill());
        if (activeTl) activeTl.kill();
        apiRef.current = null;
      };
    },
    {
      scope: containerRef,
      dependencies: [
        plans,
        rollDuration,
        digitStagger,
        toggleDuration,
        shimmerDuration,
        savingsLabel,
        defaultPeriod,
        currency,
        showSavingsChip,
        ease,
        disable,
      ],
    }
  );

  const getPeriod = useCallback(() => apiRef.current?.getPeriod?.() ?? defaultPeriod, [defaultPeriod]);

  useImperativeHandle(ref, () => ({
    refresh: () => {},
    setPeriod: (p) => apiRef.current?.setPeriod?.(p),
    demo: () => apiRef.current?.demo?.() ?? null,
    getPeriod,
  }), [getPeriod]);

  return (
    <section ref={containerRef} className={`prc_wrap ${className}`.trim()} data-anm-pricing>
      <div className="prc_head">
        {logoSrc ? <img className="prc_logo" src={logoSrc} alt={logoAlt} /> : null}
        <h2 className="prc_title">{title}</h2>
      </div>

      <div className="prc_toggle_row">
        <button type="button" className="prc_toggle" ref={toggleRef} data-anm-prc-toggle>
          <span className="prc_toggle_knob" ref={knobRef} data-anm-prc-knob aria-hidden="true" />
          <span className="prc_toggle_label">Monthly</span>
          <span className="prc_toggle_label">Yearly</span>
        </button>
        <span className="prc_chip" ref={chipRef} data-anm-prc-chip>
          <span ref={chipInnerRef} data-anm-prc-chip-inner />
        </span>
      </div>

      <div className="prc_cards">
        {plans.map((plan, i) => (
          <div
            key={plan.name}
            className={`prc_card${plan.popular ? ' prc_card_popular' : ''}`}
            data-anm-prc-card
            data-anm-monthly={plan.monthly}
            data-anm-yearly={plan.yearly}
            {...(plan.popular ? { 'data-anm-popular': true } : {})}
          >
            {plan.popular && <span className="prc_card_badge">Popular</span>}
            <div
              className={`prc_card_name ${plan.nameClass || ''}`.trim()}
              data-anm-prc-name
              ref={(el) => { nameRefs.current[i] = el; }}
            >
              {plan.name}
            </div>
            <div className="prc_card_price">
              <span
                className="prc_price_currency"
                data-anm-prc-currency
                ref={(el) => { currencyRefs.current[i] = el; }}
              />
              <span
                className="prc_price_value"
                data-anm-prc-price
                ref={(el) => { priceRefs.current[i] = el; }}
              />
              <span
                className="prc_price_period"
                data-anm-prc-period
                ref={(el) => { periodRefs.current[i] = el; }}
              />
              <span
                className="prc_price_sr"
                data-anm-prc-sr
                ref={(el) => { srRefs.current[i] = el; }}
              />
            </div>
            <ul className="prc_features">
              {plan.features.map((feature) => (
                <li key={feature} className="prc_feature" data-anm-prc-feature>
                  {feature}
                </li>
              ))}
            </ul>
            <button type="button" className={`prc_cta${plan.popular ? ' prc_cta_popular' : ''}`}>
              {plan.ctaLabel}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
});

export default Pricing;
