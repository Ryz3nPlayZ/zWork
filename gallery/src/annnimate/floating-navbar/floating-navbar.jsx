'use client';

import { forwardRef, useImperativeHandle, useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { CustomEase } from 'gsap/CustomEase';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import './floating-navbar.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP, ScrollTrigger, CustomEase);
  if (!CustomEase.get('annnimate')) {
    CustomEase.create('annnimate', 'M0,0 C0.3,0.9 0.1,1 1,1');
  }
  if (!CustomEase.get('annnimateInOut')) {
    CustomEase.create('annnimateInOut', 'M0,0 C0.7,0 0.16,1 1,1');
  }
}

const HYSTERESIS = 24;
const SCRUB_SMOOTH = 0.5;
const CONTENT_LAG = 0.04;
// the row lifts a little faster than it travels, so each item bows into the pill
const LIFT_SCALE = 0.82;
// the wordmark tail is folded away before the walls arrive
const FOLD_SCALE = 0.74;
const PILL_PAD = 6;
// kept letters sit as far from the left wall as the CTA label sits from the right
const MARK_INSET = 22;
const GLASS_FILL = 0.56;
const GLASS_BLUR = 14;
const GLASS_SAT = 1.6;
const RM_FADE = 0.2;
const DEMO_HOLD = 0.9;
const RESIZE_DEBOUNCE = 150;
const MEASURE_CLASS = 'is-measuring';
const DOCKED_CLASS = 'is-docked';
const HIDDEN_CLASS = 'is-hidden';

const DEFAULT_LINKS = [
  { label: 'Objects', href: '#' },
  { label: 'Rides', href: '#' },
  { label: 'Clubs', href: '#' },
  { label: 'Journal', href: '#' },
];

const FloatingNavbar = forwardRef(function FloatingNavbar({
  className = '',
  threshold = 80,
  duration = 0.42,
  ease = 'annnimate',
  mode = 'toggle',
  offset = 12,
  mark = 'K',
  wordmark = 'Merid',
  links = DEFAULT_LINKS,
  ctaLabel = 'Contact',
  ctaHref = '#',
  hideStartRef = null,
  hideStart = null,
}, ref) {
  const headerRef = useRef(null);
  const bgRef = useRef(null);
  const navRef = useRef(null);
  const logoRef = useRef(null);
  const tailInnerRef = useRef(null);
  const linkRefs = useRef([]);
  const ctaRef = useRef(null);
  const apiRef = useRef(null);

  linkRefs.current = [];

  const keep = mark && wordmark.indexOf(mark) === 0 ? mark : wordmark.charAt(0);
  const rest = wordmark.slice(keep.length);

  useImperativeHandle(ref, () => ({
    dock: () => apiRef.current && apiRef.current.dock(),
    undock: () => apiRef.current && apiRef.current.undock(),
    refresh: () => apiRef.current && apiRef.current.refresh(),
    demo: () => (apiRef.current ? apiRef.current.demo() : null),
  }), []);

  useGSAP(
    () => {
      const header = headerRef.current;
      const bg = bgRef.current;
      const nav = navRef.current;
      const logo = logoRef.current;
      const cta = ctaRef.current;
      const tailInner = tailInnerRef.current;
      const linkEls = linkRefs.current.filter(Boolean);
      if (!header || !bg || !nav || !logo || !cta) return undefined;

      // logo first, CTA last - measure() reads the row's ends from these slots
      const items = [logo].concat(linkEls, [cta]);

      const RELEASE_AT = Math.max(1, threshold - HYSTERESIS);
      const SCRUB_SPAN = threshold * 2;

      let geo = null;
      let tl = null;
      let demoTl = null;
      let rmFade = null;
      let trigger = null;
      let isDocked = false;
      let scrubbing = false;
      let reducedMotion = false;
      let resizeTimer = null;
      let lastWidth = 0;
      let isReady = false;
      let disposed = false;
      let rafId = 0;

      function isShown(el) {
        return el.getClientRects().length > 0;
      }

      // Reads the top layout, then the docked layout (one synchronous class
      // swap, never painted), and turns the difference into transform deltas
      // plus the pill's clip geometry. Ratios of the real DOM, no typed px.
      function measure() {
        gsap.set(items.concat([nav]), { x: 0, y: 0 });
        const width = header.getBoundingClientRect().width;
        const barH = header.offsetHeight;
        const bgH = bg.offsetHeight;
        const tops = items.map((el) => el.getBoundingClientRect().left);

        header.classList.add(MEASURE_CLASS);
        const docks = items.map((el) => el.getBoundingClientRect());
        const ctaH = cta.offsetHeight;
        header.classList.remove(MEASURE_CLASS);

        const rowLeft = docks[0].left;
        const rowRight = docks[docks.length - 1].right;
        const pillW = rowRight - rowLeft + MARK_INSET + PILL_PAD;
        const pillH = ctaH + PILL_PAD * 2;
        const pillX = (width - pillW) / 2;
        const shift = pillX + MARK_INSET - rowLeft;

        return {
          dx: items.map((el, i) => (isShown(el) ? docks[i].left + shift - tops[i] : 0)),
          dy: offset + pillH / 2 - barH / 2,
          clipX: pillX,
          clipTop: offset,
          clipBottom: Math.max(0, bgH - offset - pillH),
          restBottom: Math.max(0, bgH - barH),
          radius: pillH / 2,
        };
      }

      function glassVars(p) {
        return {
          '--fnb-fill': GLASS_FILL * p,
          '--fnb-blur': GLASS_BLUR * p + 'px',
          '--fnb-sat': 1 + (GLASS_SAT - 1) * p,
        };
      }

      // One spec per visual event. The live timeline plays them forward; the
      // demo plays them forward, holds, then plays them back in reverse order.
      function dockSpecs() {
        const specs = [
          {
            target: bg, at: 0, dur: duration,
            label: 'Edges close into a pill', back: 'Edges open back to full width',
            from: { '--fnb-ct': '0px', '--fnb-cx': '0px', '--fnb-cb': geo.restBottom + 'px', '--fnb-cr': '0px' },
            to: { '--fnb-ct': geo.clipTop + 'px', '--fnb-cx': geo.clipX + 'px', '--fnb-cb': geo.clipBottom + 'px', '--fnb-cr': geo.radius + 'px' },
          },
          {
            target: bg, at: 0, dur: duration,
            label: 'Frosted glass fades in', back: 'Glass clears',
            from: glassVars(0), to: glassVars(1),
          },
          {
            target: logo, at: CONTENT_LAG, dur: duration,
            label: 'Wordmark rides the left edge', back: 'Wordmark rides back out',
            from: { x: 0 }, to: { x: geo.dx[0] },
          },
        ];
        if (tailInner) {
          specs.push({
            target: tailInner, at: CONTENT_LAG, dur: duration * FOLD_SCALE,
            label: 'Wordmark folds into its mark', back: 'Wordmark unfolds',
            from: { xPercent: 0, opacity: 1 }, to: { xPercent: -100, opacity: 0 },
          });
        }
        if (linkEls.length) {
          specs.push({
            target: linkEls, at: CONTENT_LAG, dur: duration,
            label: 'Links tighten toward the center', back: 'Links spread back out',
            from: { x: 0 }, to: { x: (i) => geo.dx[1 + i] },
          });
        }
        specs.push(
          {
            target: cta, at: CONTENT_LAG, dur: duration,
            label: 'Contact rides the right edge', back: 'Contact rides back out',
            from: { x: 0 }, to: { x: geo.dx[items.length - 1] },
          },
          {
            target: nav, at: CONTENT_LAG, dur: duration * LIFT_SCALE,
            label: 'Row lifts into the pill', back: 'Row settles back down',
            from: { y: 0 }, to: { y: geo.dy },
          }
        );
        return specs;
      }

      // easeReverse re-eases the way back with the same curve from wherever the
      // tween is, so undocking keeps the forward feel instead of an .in curve.
      // Scrub mode stays plain: there the position must follow the scroll 1:1.
      function addSpec(timeline, spec, at, back, reversible) {
        const vars = Object.assign({}, back ? spec.from : spec.to, {
          duration: spec.dur,
          ease,
          force3D: true,
          immediateRender: false,
          data: { label: back ? spec.back : spec.label },
        });
        if (reversible) vars.easeReverse = true;
        timeline.fromTo(spec.target, back ? spec.to : spec.from, vars, at);
      }

      // Both timelines are built PAUSED: the live one waits for the scroll,
      // the demo one waits for the inspector. Nothing plays on load.
      function buildTimelines() {
        const specs = dockSpecs();
        tl = gsap.timeline({ paused: true });
        specs.forEach((s) => addSpec(tl, s, s.at, false, !scrubbing));

        const len = tl.duration();
        const backStart = len + DEMO_HOLD;
        demoTl = gsap.timeline({ paused: true });
        specs.forEach((s) => addSpec(demoTl, s, s.at, false));
        specs.forEach((s) => addSpec(demoTl, s, backStart + len - (s.at + s.dur), true));
      }

      // A real scroll during a demo pass continues from about the demo's frame:
      // the way back runs in reverse order, so its time maps onto the live
      // timeline's progress.
      function takeOverFromDemo() {
        if (!demoTl) return;
        const dp = demoTl.progress();
        if (dp <= 0 || dp >= 1) return;
        const len = tl.duration();
        const t = demoTl.time();
        let p = 1;
        if (t < len) p = t / len;
        else if (t > len + DEMO_HOLD) p = 1 - (t - len - DEMO_HOLD) / len;
        demoTl.pause();
        tl.progress(Math.max(0, Math.min(1, p)));
      }

      function swapReduced(p) {
        tl.pause().progress(p);
        if (rmFade) rmFade.kill();
        rmFade = gsap.fromTo(bg, glassVars(1 - p), Object.assign(glassVars(p), {
          duration: RM_FADE,
          ease: 'power1.out',
        }));
      }

      function dock() {
        if (scrubbing || isDocked || !tl) return;
        isDocked = true;
        header.classList.add(DOCKED_CLASS);
        takeOverFromDemo();
        if (reducedMotion) swapReduced(1);
        else tl.play();
      }

      function undock() {
        if (scrubbing || !isDocked || !tl) return;
        isDocked = false;
        header.classList.remove(DOCKED_CLASS);
        takeOverFromDemo();
        if (reducedMotion) swapReduced(0);
        else tl.reverse();
      }

      function currentScroll() {
        return window.pageYOffset || document.documentElement.scrollTop || 0;
      }

      // Renders a fresh timeline to a progress without playing it (1 first so
      // every child, delayed ones included, has rendered once).
      function setProgress(p) {
        tl.progress(1, true);
        if (p < 1) tl.progress(p, true);
      }

      // Toggle mode: one passive trigger watches the scroll and flips state
      // with hysteresis, so jitter around the threshold never flickers it.
      function handleToggleScroll(self) {
        const y = self.scroll();
        if (!isDocked && y >= threshold) dock();
        else if (isDocked && y < RELEASE_AT) undock();
      }

      function handleScrubUpdate(self) {
        isDocked = self.progress >= 0.5;
        header.classList.toggle(DOCKED_CLASS, isDocked);
      }

      // The scroll source is rebuilt with the geometry, so it lives with setup.
      function wireScroll() {
        if (scrubbing) {
          trigger = ScrollTrigger.create({
            start: 0,
            end: SCRUB_SPAN,
            scrub: SCRUB_SMOOTH,
            animation: tl,
            onUpdate: handleScrubUpdate,
          });
        } else {
          trigger = ScrollTrigger.create({
            start: 0,
            end: 'max',
            onUpdate: handleToggleScroll,
          });
        }
      }

      // Measure -> build -> wire -> apply the state that matches the current
      // scroll instantly. Runs at init, on font load, on width changes and
      // when the motion preference flips.
      function setup() {
        if (disposed) return;
        if (trigger) trigger.kill(false, true);
        trigger = null;
        if (tl) tl.kill();
        if (demoTl) demoTl.kill();
        if (rmFade) rmFade.kill();

        scrubbing = mode === 'scrub' && !reducedMotion;
        geo = measure();
        buildTimelines();
        lastWidth = header.getBoundingClientRect().width;

        const y = currentScroll();
        if (scrubbing) {
          isDocked = y >= threshold;
          setProgress(Math.min(1, y / SCRUB_SPAN));
        } else {
          isDocked = isDocked ? y >= RELEASE_AT : y >= threshold;
          setProgress(isDocked ? 1 : 0);
        }
        header.classList.toggle(DOCKED_CLASS, isDocked);
        wireScroll();
      }

      function handleResize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          // height-only resizes (mobile URL bar) leave the geometry untouched
          if (header.getBoundingClientRect().width === lastWidth) return;
          setup();
        }, RESIZE_DEBOUNCE);
      }
      window.addEventListener('resize', handleResize);

      function handleVisibility() {
        if (document.hidden) gsap.globalTimeline.pause();
        else gsap.globalTimeline.resume();
      }
      document.addEventListener('visibilitychange', handleVisibility);

      // the browser can restore a scrolled position after init - re-apply the
      // matching state instantly rather than animating into it
      function handleLoad() {
        if (isReady) setup();
      }
      if (document.readyState !== 'complete') {
        window.addEventListener('load', handleLoad, { once: true });
      }

      // Reduced motion swaps state instantly and only crossfades the glass.
      // The rebuild is deferred a frame so the trigger is not owned (and later
      // reverted) by the matchMedia context.
      const mm = gsap.matchMedia();
      mm.add({
        reduce: '(prefers-reduced-motion: reduce)',
        motion: '(prefers-reduced-motion: no-preference)',
      }, (ctx) => {
        reducedMotion = !!ctx.conditions.reduce;
        if (isReady) rafId = requestAnimationFrame(setup);
      });

      // first build once the motion preference is known
      setup();
      isReady = true;
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => { setup(); });
      }

      apiRef.current = {
        dock,
        undock,
        refresh: setup,
        // Timeline inspector demo (ADR-0011): one dock pass, a short hold,
        // then the way back - ends in the open top state. Pre-built
        // paused at setup, so it never autoplays.
        demo: () => {
          if (!demoTl || isDocked || tl.progress() > 0 || demoTl.isActive()) return null;
          demoTl.restart(true, false);
          return demoTl;
        },
      };

      return () => {
        disposed = true;
        apiRef.current = null;
        cancelAnimationFrame(rafId);
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('load', handleLoad);
        document.removeEventListener('visibilitychange', handleVisibility);
        clearTimeout(resizeTimer);
        mm.revert();
        if (trigger) trigger.kill(false, true);
        if (tl) tl.kill();
        if (demoTl) demoTl.kill();
        if (rmFade) rmFade.kill();
        gsap.set([bg, nav, tailInner].concat(items).filter(Boolean), { clearProps: 'all' });
        header.classList.remove(DOCKED_CLASS, HIDDEN_CLASS);
      };
    },
    {
      scope: headerRef,
      dependencies: [threshold, duration, ease, mode, offset, mark, wordmark, links.length],
      revertOnUpdate: true,
    }
  );

  // Past the hide-start section the header hides on scroll down and comes
  // back on scroll up; the CSS class owns the slide.
  useGSAP(
    () => {
      const header = headerRef.current;
      const section = hideStart || (hideStartRef && hideStartRef.current);
      if (!header || !section) return undefined;

      const hideTrigger = ScrollTrigger.create({
        trigger: section,
        start: 'top top',
        end: 'max',
        onUpdate: (self) => { header.classList.toggle(HIDDEN_CLASS, self.direction === 1); },
        onLeaveBack: () => { header.classList.remove(HIDDEN_CLASS); },
      });

      return () => {
        hideTrigger.kill();
        header.classList.remove(HIDDEN_CLASS);
      };
    },
    { scope: headerRef, dependencies: [hideStart, hideStartRef], revertOnUpdate: true }
  );

  return (
    <header
      ref={headerRef}
      className={`fnb_wrap${className ? ' ' + className : ''}`}
      data-anm-floating-navbar
      data-anm-dock-threshold={threshold}
      data-anm-dock-duration={duration}
      data-anm-dock-ease={ease}
      data-anm-dock-mode={mode}
      data-anm-dock-offset={offset}
      data-anm-dock-mark={mark}
    >
      <div ref={bgRef} className="fnb_bg" data-anm-fnb-bg aria-hidden="true" />

      <nav ref={navRef} className="fnb_nav" data-anm-fnb-nav aria-label="Main">
        <a ref={logoRef} className="fnb_logo" data-anm-fnb-logo href="#" aria-label={wordmark}>
          <span className="fnb_logo_text" data-anm-fnb-logo-text aria-hidden="true">
            <span className="fnb_logo_mark">{keep}</span>
            {rest ? (
              <span className="fnb_logo_tail">
                <span ref={tailInnerRef} className="fnb_logo_tail_inner">{rest}</span>
              </span>
            ) : null}
          </span>
        </a>

        <ul className="fnb_links">
          {links.map((link, i) => (
            <li key={link.label} className="fnb_links_item">
              <a
                ref={(el) => { linkRefs.current[i] = el; }}
                className="fnb_link"
                data-anm-fnb-link
                href={link.href || '#'}
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <a ref={ctaRef} className="fnb_cta" data-anm-fnb-cta href={ctaHref}>{ctaLabel}</a>
      </nav>
    </header>
  );
});

export default FloatingNavbar;
