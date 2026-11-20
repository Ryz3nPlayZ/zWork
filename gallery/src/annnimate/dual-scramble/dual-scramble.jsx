'use client';

import { useRef } from 'react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ScrambleTextPlugin } from 'gsap/ScrambleTextPlugin';
import './dual-scramble.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP, ScrollTrigger, ScrambleTextPlugin);
}

const ASCII_CHARS = " .'`^\",:;il!i><~+_-?][}{1)(|\\/tfjrxnuvczxyujclq0ozmwqpdbkhao*#mw&8%b@$";

export default function DualScramble({ className = '' }) {
  const containerRef = useRef(null);

  useGSAP(
    (context, contextSafe) => {
      const container = containerRef.current;
      if (!container) return;

      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      const defaults = {
        duration: 0.6,
        chars: ASCII_CHARS,
        trigger: 'scroll',
        color1: 'dual-scramble-color-1',
        color2: 'dual-scramble-color-2',
        stagger: 0.1,
        start: 'top 80%'
      };

      const getConfig = (el) => ({
        duration: parseFloat(el.dataset.anmDuration) || defaults.duration,
        chars:    el.dataset.anmChars   || defaults.chars,
        trigger:  el.dataset.anmTrigger || defaults.trigger,
        color1:   el.dataset.anmColor1  || defaults.color1,
        color2:   el.dataset.anmColor2  || defaults.color2
      });

      const isDisabled = (el) => {
        const disable = el.dataset.anmDisable;
        if (!disable) return false;
        const breakpoints = {
          mobile:    '(max-width: 479px)',
          tablet:    '(max-width: 991px)',
          landscape: '(orientation: landscape) and (max-width: 991px)',
          desktop:   '(min-width: 992px)'
        };
        return disable.split(',').some((v) => {
          const key = v.trim();
          return breakpoints[key] && window.matchMedia(breakpoints[key]).matches;
        });
      };

      const generateRandomChars = (text, chars) => {
        let result = '';
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (ch === ' ' || ch === '\n' || ch === '\r') {
            result += ch;
          } else {
            result += chars[Math.floor(Math.random() * chars.length)];
          }
        }
        return result;
      };

      const buildLayout = (el) => {
        if (el.dataset.anmDualScrambleReady === 'true') {
          return {
            wrapper: el,
            spacer: el.querySelector('[data-anm-dual-scramble-spacer]'),
            scrambleEl: el.querySelector('[data-anm-dual-scramble-layer]'),
            originalText: el.dataset.anmOriginalText || ''
          };
        }

        const originalText = el.textContent.trim();
        el.dataset.anmOriginalText = originalText;
        el.innerHTML = '';

        const srSpan = document.createElement('span');
        srSpan.className = 'dual_scramble_sr';
        srSpan.textContent = originalText;
        el.appendChild(srSpan);

        const spacer = document.createElement('span');
        spacer.setAttribute('aria-hidden', 'true');
        spacer.setAttribute('data-anm-dual-scramble-spacer', '');
        spacer.className = 'dual_scramble_spacer';
        spacer.textContent = originalText;
        el.appendChild(spacer);

        const scrambleEl = document.createElement('span');
        scrambleEl.setAttribute('aria-hidden', 'true');
        scrambleEl.setAttribute('data-anm-dual-scramble-layer', '');
        scrambleEl.className = 'dual_scramble_layer';
        el.appendChild(scrambleEl);

        el.dataset.anmDualScrambleReady = 'true';

        return { wrapper: el, spacer, scrambleEl, originalText };
      };

      const runScramble = (layout, config) => {
        const scrambleEl = layout.scrambleEl;
        const finalText = layout.originalText;
        const { duration, chars, color1, color2 } = config;

        if (reducedMotion) {
          scrambleEl.textContent = finalText;
          scrambleEl.className = 'dual_scramble_layer';
          return null;
        }

        gsap.killTweensOf(scrambleEl);

        const randomTarget = generateRandomChars(finalText, chars);
        const charCount = finalText.replace(/\s/g, '').length;
        const oneLetterDelay = charCount > 0 ? duration / charCount : 0;

        scrambleEl.textContent = finalText;

        const tl = gsap.timeline();

        tl.to(scrambleEl, {
          duration,
          scrambleText: { text: randomTarget, chars, speed: 1, revealDelay: 0.1, oldClass: color2, newClass: color1 },
          ease: 'none'
        });

        tl.to(scrambleEl, {
          duration,
          scrambleText: { text: finalText, chars, speed: 1, revealDelay: 0.1, oldClass: color1, newClass: color2 },
          ease: 'none'
        }, oneLetterDelay);

        return tl;
      };

      const hoverListeners = [];
      const clickListeners = [];

      const soloElements = Array.from(container.querySelectorAll('[data-anm-dual-scramble]')).filter(
        (el) => !el.closest('[data-anm-dual-scramble-group]')
      );

      soloElements.forEach((el) => {
        if (isDisabled(el)) return;

        const config = getConfig(el);
        const layout = buildLayout(el);
        layout.scrambleEl.textContent = layout.originalText;

        // A comma list ("scroll, hover") registers each trigger
        config.trigger.split(',').forEach((t) => {
          const trigger = t.trim();
          if (trigger === 'scroll') {
            ScrollTrigger.create({
              trigger: el,
              start: el.dataset.anmStart || defaults.start,
              once: true,
              onEnter: () => runScramble(layout, config)
            });
          } else if (trigger === 'hover') {
            const fn = contextSafe(() => runScramble(layout, config));
            el.addEventListener('mouseenter', fn);
            hoverListeners.push({ el, fn });
          } else if (trigger === 'click') {
            const fn = contextSafe(() => runScramble(layout, config));
            el.addEventListener('click', fn);
            clickListeners.push({ el, fn });
          } else if (trigger === 'load') {
            runScramble(layout, config);
          } else if (trigger === 'manual') {
            el.scrambleTrigger = contextSafe(() => runScramble(layout, config));
          }
        });
      });

      const groups = container.querySelectorAll('[data-anm-dual-scramble-group]');

      groups.forEach((group) => {
        if (isDisabled(group)) return;

        const stagger = parseFloat(group.dataset.anmStagger) || defaults.stagger;
        const startPos = group.dataset.anmStart || defaults.start;
        const groupTrigger = group.dataset.anmTrigger || defaults.trigger;

        const children = Array.from(group.querySelectorAll('[data-anm-dual-scramble]')).filter(
          (el) => !isDisabled(el)
        );
        if (!children.length) return;

        const items = children.map((el) => {
          const config = getConfig(el);
          const layout = buildLayout(el);
          layout.scrambleEl.textContent = layout.originalText;
          return { layout, config };
        });

        const fireGroup = contextSafe(() => {
          items.forEach((item, i) => {
            const delay = i * stagger;
            if (delay === 0) {
              runScramble(item.layout, item.config);
            } else {
              gsap.delayedCall(delay, () => runScramble(item.layout, item.config));
            }
          });
        });

        if (groupTrigger === 'scroll') {
          ScrollTrigger.create({
            trigger: group,
            start: startPos,
            once: true,
            onEnter: fireGroup
          });
        } else if (groupTrigger === 'hover') {
          group.addEventListener('mouseenter', fireGroup);
          hoverListeners.push({ el: group, fn: fireGroup });
        } else if (groupTrigger === 'click') {
          group.addEventListener('click', fireGroup);
          clickListeners.push({ el: group, fn: fireGroup });
        } else if (groupTrigger === 'load') {
          fireGroup();
        } else if (groupTrigger === 'manual') {
          group.scrambleTrigger = fireGroup;
        }
      });

      let resizeTimeout;
      const onResize = () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => ScrollTrigger.refresh(), 150);
      };
      window.addEventListener('resize', onResize);

      // Manual cleanup for non-GSAP DOM listeners only.
      // useGSAP's context auto-reverts all GSAP animations and ScrollTriggers
      // created inside this scope (and inside contextSafe-wrapped handlers).
      return () => {
        hoverListeners.forEach(({ el, fn }) => el.removeEventListener('mouseenter', fn));
        clickListeners.forEach(({ el, fn }) => el.removeEventListener('click', fn));
        window.removeEventListener('resize', onResize);
        clearTimeout(resizeTimeout);
      };
    },
    { scope: containerRef, dependencies: [] }
  );

  return (
    <div ref={containerRef} className={className || undefined}>
      <div className="dual_scramble_wrap">
        <h2
          className="dual_scramble_headline"
          data-anm-dual-scramble
          data-anm-trigger="scroll, hover"
          data-anm-duration="0.8"
          data-anm-start="top 80%"
        >
          Your weekly paperwork, done.
        </h2>
      </div>
    </div>
  );
}
