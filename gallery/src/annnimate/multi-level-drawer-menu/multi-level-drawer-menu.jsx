// Demo images are from Arqe (arqe.ai). They are placeholders: swap them for your own before going live. Using them in your own product needs your own Arqe plan.
'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import './multi-level-drawer-menu.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP);
}

// ─── Constants (mirror vanilla JS) ─────────────────────────────────────────
const HOVER_DUR         = 0.4;
const HOVER_EASE        = 'back.out';
const DOT_GAP_PRIMARY   = 12;
const DOT_GAP_SUB       = 10;
const ICON_BURGER_OFFSET = 3;
const PANEL_RADIUS      = 8;
const CLOSE_PANEL2_DELAY = 200;
const CLIP_HIDDEN  = `inset(0% 100% 0% 0% round ${PANEL_RADIUS}px)`;
const CLIP_VISIBLE = `inset(0% 0% 0% 0% round ${PANEL_RADIUS}px)`;
const tok = (n) => (typeof window === 'undefined' ? '' : 'rgb(' + getComputedStyle(document.documentElement).getPropertyValue(n).trim().split(/\s+/).join(', ') + ')');
const TOGGLE_DARK = () => tok('--ink');
const TOGGLE_LIGHT = () => tok('--paper');

// ─── Default data ───────────────────────────────────────────────────────────
const DEFAULT_PRIMARIES = [
  { id: 'running', label: 'Rides' },
  { id: 'cycling', label: 'Objects' },
  { id: 'tennis',  label: 'Journal' },
  { id: 'track',   label: 'About'   },
];

const DEFAULT_SUBLISTS = {
  running: ['Gravel', 'Road', 'Coast', 'Alpine'],
  cycling: ['Wheels', 'Rackets', 'Flasks', 'Clips'],
  tennis:  ['Latest', 'Training', 'Care', 'Repairs'],
  track:   ['Workshop', 'Ridge camp', 'Clubs', 'Contact'],
};

const DEFAULT_SECONDARY_LINKS = [
  { label: 'Clubs',          href: '#' },
  { label: 'Contact',        href: '#' },
];

const DEFAULT_CARDS = [
  { src: '/img/report.webp', alt: 'A wave rolling in at dusk', label: 'The coast' },
  { src: '/img/report.webp', alt: 'White racket on a wooden bench', label: 'Linea Lite' },
];

export default function MultiLevelDrawerMenu({
  className      = '',
  duration       = 0.9,
  ease           = 'expo.out',
  stagger        = 0.06,
  panelBg        = '#ececec',
  logo           = 'Merid',
  primaries      = DEFAULT_PRIMARIES,
  sublists       = DEFAULT_SUBLISTS,
  secondaryLinks = DEFAULT_SECONDARY_LINKS,
  cards          = DEFAULT_CARDS,
  heroEyebrow    = 'Spring routes / 03',
  heroHeading    = 'The shape of distance.',
  heroSub        = 'Objects and routes for the long way home.',
  heroImage      = '/img/report.webp',
}) {
  // ─── Refs ─────────────────────────────────────────────────────────────────
  const containerRef   = useRef(null);
  const overlayRef     = useRef(null);
  const scrimRef       = useRef(null);
  const panel1Ref      = useRef(null);
  const panel2Ref      = useRef(null);
  const primaryNavRef  = useRef(null);
  const toggleRef      = useRef(null);
  const labelTrackRef  = useRef(null);
  const labelOpenRef   = useRef(null);
  const iconTopRef     = useRef(null);
  const iconBottomRef  = useRef(null);
  const logoRef        = useRef(null);
  const backBtnRef     = useRef(null);

  // Arrays of refs — one per primary item
  const primaryBtnRefs  = useRef([]);  // the button elements
  const primaryDotRefs  = useRef([]);  // .mldm_primary_dot spans
  const primaryLblRefs  = useRef([]);  // .mldm_primary_label spans

  // Refs keyed by primary id
  const sublistRefs       = useRef({});  // the .mldm_sublist divs
  const sublistLabelRefs  = useRef({});  // arrays of .mldm_sublink_label spans per sublist
  const sublinkDotRefs    = useRef({});  // arrays of .mldm_sublink_dot spans per sublist

  // Panel-1 bottom-row extras (explore, cards, footer links)
  const exploreRef      = useRef(null);
  const cardRefs        = useRef([]);
  const footerLinkRefs  = useRef([]);

  // Timeline refs
  const openTlRef   = useRef(null);
  const closeTlRef  = useRef(null);
  const mmRef       = useRef(null);

  // Mutable state refs (no re-renders needed)
  const isOpenRef        = useRef(false);
  const panel2OpenRef    = useRef(false);
  const activeSubIdRef   = useRef(null);
  const closeTimerRef    = useRef(null);

  // React state for aria-expanded on toggle only
  const [isOpen, setIsOpen] = useState(false);

  // ─── isMobile helper ──────────────────────────────────────────────────────
  const isMobile = useCallback(() => {
    return window.matchMedia('(max-width: 767px)').matches;
  }, []);

  // ─── setPanel2InitialState ────────────────────────────────────────────────
  const setPanel2InitialState = useCallback(() => {
    const panel2 = panel2Ref.current;
    if (!panel2) return;
    if (isMobile()) {
      gsap.set(panel2, { clipPath: CLIP_VISIBLE, xPercent: 0, x: '100vw' });
    } else {
      gsap.set(panel2, { clipPath: CLIP_HIDDEN, xPercent: 0, x: 0 });
    }
  }, [isMobile]);

  // ─── Sublist helpers ──────────────────────────────────────────────────────
  const setActiveSublist = useCallback((id) => {
    primaries.forEach((p) => {
      const sl = sublistRefs.current[p.id];
      if (!sl) return;
      const isMatch = p.id === id;
      sl.classList.toggle('mldm_sublist_active', isMatch);
      sl.setAttribute('aria-hidden', String(!isMatch));
      sl.style.visibility    = isMatch ? 'visible' : 'hidden';
      sl.style.pointerEvents = isMatch ? 'auto'    : 'none';
    });
    activeSubIdRef.current = id;
    primaryBtnRefs.current.forEach((btn, i) => {
      if (!btn) return;
      btn.setAttribute('aria-expanded', String(primaries[i]?.id === id));
    });
  }, [primaries]);

  const resetSubLinkVisuals = useCallback((id) => {
    const lbls = sublistLabelRefs.current[id] || [];
    const dots = sublinkDotRefs.current[id]   || [];
    lbls.forEach((lbl) => { if (lbl) gsap.set(lbl, { x: 0, opacity: 0 }); });
    dots.forEach((dot) => { if (dot) gsap.set(dot, { scale: 0 }); });
  }, []);

  // ─── Panel-2 close timer ──────────────────────────────────────────────────
  const cancelPanel2CloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  // ─── contextSafe from useGSAP — setup initial state ──────────────────────
  const { contextSafe } = useGSAP(
    () => {
      const panel1    = panel1Ref.current;
      const panel2    = panel2Ref.current;
      const overlay   = overlayRef.current;
      const scrim     = scrimRef.current;
      const toggle    = toggleRef.current;
      const logoEl    = logoRef.current;
      const labelTrack = labelTrackRef.current;
      const iconTop   = iconTopRef.current;
      const iconBottom = iconBottomRef.current;

      if (!panel1 || !overlay || !toggle) return;

      // Apply panelBg
      if (panel1) panel1.style.backgroundColor = panelBg;
      if (panel2) panel2.style.backgroundColor = panelBg;

      // Initial closed state
      overlay.setAttribute('inert', '');
      overlay.setAttribute('aria-hidden', 'true');
      gsap.set(panel1, { clipPath: CLIP_HIDDEN });
      setPanel2InitialState();
      gsap.set(scrim,      { opacity: 0 });
      gsap.set(toggle,     { color: TOGGLE_DARK() });
      if (logoEl)     gsap.set(logoEl,     { color: TOGGLE_DARK() });
      if (labelTrack) gsap.set(labelTrack, { y: 0 });
      if (iconTop)    gsap.set(iconTop,    { y: -ICON_BURGER_OFFSET, rotation: 0 });
      if (iconBottom) gsap.set(iconBottom, { y:  ICON_BURGER_OFFSET, rotation: 0 });

      // Hide all sublists initially
      primaries.forEach((p) => {
        const sl = sublistRefs.current[p.id];
        if (!sl) return;
        sl.classList.remove('mldm_sublist_active');
        sl.setAttribute('aria-hidden', 'true');
        sl.style.visibility    = 'hidden';
        sl.style.pointerEvents = 'none';
      });

      // Reduced motion
      mmRef.current = gsap.matchMedia();
      mmRef.current.add('(prefers-reduced-motion: reduce)', () => {
        gsap.globalTimeline.timeScale(20);
      });

      return () => {
        if (openTlRef.current)  openTlRef.current.kill();
        if (closeTlRef.current) closeTlRef.current.kill();
        if (mmRef.current)      mmRef.current.revert();
        cancelPanel2CloseTimer();
      };
    },
    { scope: containerRef, dependencies: [panelBg] }
  );

  // ─── buildTimelines ───────────────────────────────────────────────────────
  const buildTimelines = contextSafe(() => {
    const panel1     = panel1Ref.current;
    const panel2     = panel2Ref.current;
    const overlay    = overlayRef.current;
    const scrim      = scrimRef.current;
    const toggle     = toggleRef.current;
    const logoEl     = logoRef.current;
    const labelTrack = labelTrackRef.current;
    const labelOpen  = labelOpenRef.current;
    const iconTop    = iconTopRef.current;
    const iconBottom = iconBottomRef.current;

    if (!panel1 || !overlay || !toggle) return;

    if (openTlRef.current)  openTlRef.current.kill();
    if (closeTlRef.current) closeTlRef.current.kill();

    // Collect primary labels
    const primaryLabels = primaryLblRefs.current.filter(Boolean);

    // Bottom-row extras
    const p1Extras = [];
    if (exploreRef.current) p1Extras.push(exploreRef.current);
    cardRefs.current.forEach((c) => { if (c) p1Extras.push(c); });
    footerLinkRefs.current.forEach((f) => { if (f) p1Extras.push(f); });

    const navAll = [...primaryLabels, ...p1Extras];

    const labelHeight = labelOpen ? labelOpen.offsetHeight : 16;
    const trackOpenY  = -(labelHeight + 2);

    // ── OPEN TIMELINE ────────────────────────────────────────────────────────
    openTlRef.current = gsap.timeline({
      paused: true,
      defaults: { ease, easeReverse: true, force3D: true },
      onStart: () => {
        overlay.removeAttribute('inert');
        overlay.setAttribute('aria-hidden', 'false');
        containerRef.current?.dispatchEvent(
          new CustomEvent('anm-mldm-open', { bubbles: true, detail: { container: containerRef.current } })
        );
      },
    });

    const tl = openTlRef.current;

    // Lock starting state
    tl.set(panel1,     { clipPath: CLIP_HIDDEN });
    tl.set(scrim,      { opacity: 0 });
    tl.set(toggle,     { color: TOGGLE_DARK() });
    if (logoEl)     tl.set(logoEl,     { color: TOGGLE_DARK() });
    tl.set(labelTrack, { y: 0 });
    tl.set(iconTop,    { y: -ICON_BURGER_OFFSET, rotation: 0 });
    tl.set(iconBottom, { y:  ICON_BURGER_OFFSET, rotation: 0 });
    primaryDotRefs.current.forEach((dot) => { if (dot) tl.set(dot, { scale: 0 }); });
    tl.set(navAll, { opacity: 0, x: -16 });

    // Scrim fades in
    tl.to(scrim,  { opacity: 1, duration: duration * 0.75 }, 0);
    // Panel 1 clip-path L→R reveal
    tl.to(panel1, { clipPath: CLIP_VISIBLE, duration }, 0.05);
    // Toggle + logo shift to light
    tl.to(toggle, { color: TOGGLE_LIGHT(), duration: duration * 0.6 }, duration * 0.2);
    if (logoEl) tl.to(logoEl, { color: TOGGLE_LIGHT(), duration: duration * 0.6 }, duration * 0.2);
    // Label track slides (Menu → Close)
    tl.to(labelTrack, { y: trackOpenY, duration: duration * 0.55 }, duration * 0.2);
    // Burger → X icon morph
    tl.to(iconTop,    { y: 0, rotation: 45,  duration: duration * 0.6 }, duration * 0.2);
    tl.to(iconBottom, { y: 0, rotation: -45, duration: duration * 0.6 }, duration * 0.2);
    // Primary labels stagger opacity + x
    tl.to(primaryLabels, { opacity: 1, x: 0, duration: 0.55, stagger }, duration * 0.35);
    // Bottom-row extras
    if (p1Extras.length) {
      tl.to(p1Extras, { opacity: 1, x: 0, duration: 0.55, stagger: stagger * 0.7 }, duration * 0.45);
    }

    // ── CLOSE TIMELINE ───────────────────────────────────────────────────────
    const closeDur = duration * 0.55;
    closeTlRef.current = gsap.timeline({
      paused: true,
      defaults: { ease: 'expo.out', force3D: true },
      onComplete: () => {
        overlay.setAttribute('inert', '');
        overlay.setAttribute('aria-hidden', 'true');
        containerRef.current?.dispatchEvent(
          new CustomEvent('anm-mldm-close', { bubbles: true, detail: { container: containerRef.current } })
        );
      },
    });

    const cl = closeTlRef.current;

    // Nav fades out fast (opacity only, no x reverse)
    cl.to(navAll, { opacity: 0, duration: 0.15, stagger: stagger * 0.3 }, 0);
    // Panel 1 clip back to hidden
    cl.to(panel1, { clipPath: CLIP_HIDDEN, duration: closeDur }, 0.05);
    // Scrim fades out
    cl.to(scrim,  { opacity: 0, duration: closeDur * 0.8 }, 0.1);
    // Toggle + logo back to dark
    cl.to(toggle, { color: TOGGLE_DARK(), duration: closeDur * 0.6 }, 0.05);
    if (logoEl) cl.to(logoEl, { color: TOGGLE_DARK(), duration: closeDur * 0.6 }, 0.05);
    // Label track + icon morph back
    cl.to(labelTrack, { y: 0, duration: closeDur * 0.55 }, 0.05);
    cl.to(iconTop,    { y: -ICON_BURGER_OFFSET, rotation: 0, duration: closeDur * 0.6 }, 0.05);
    cl.to(iconBottom, { y:  ICON_BURGER_OFFSET, rotation: 0, duration: closeDur * 0.6 }, 0.05);
  });

  // ─── Panel 2: open ────────────────────────────────────────────────────────
  const openPanel2 = contextSafe((targetId) => {
    cancelPanel2CloseTimer();
    const hasSublist = !!(sublists[targetId] && sublists[targetId].length);
    if (!hasSublist) { closePanel2(); return; }

    if (panel2OpenRef.current && activeSubIdRef.current === targetId) return;

    if (panel2OpenRef.current && activeSubIdRef.current !== targetId) {
      swapSublistContent(targetId);
      return;
    }

    panel2OpenRef.current = true;
    setActiveSublist(targetId);
    resetSubLinkVisuals(targetId);

    const panel2 = panel2Ref.current;
    if (!panel2) return;

    if (isMobile()) {
      gsap.to(panel2, { x: 0, duration: 0.5, ease: 'expo.out', easeReverse: true, force3D: true, overwrite: 'auto' });
    } else {
      gsap.to(panel2, { clipPath: CLIP_VISIBLE, duration: 0.6, ease: 'expo.out', easeReverse: true, force3D: true, overwrite: 'auto' });
    }

    const lbls = sublistLabelRefs.current[targetId] || [];
    if (lbls.length) {
      gsap.fromTo(
        lbls,
        { opacity: 0, x: -16 },
        { opacity: 1, x: 0, duration: 0.5, stagger, ease: 'expo.out', easeReverse: true, force3D: true, overwrite: 'auto', delay: 0.1 }
      );
    }
  });

  // ─── Panel 2: close ───────────────────────────────────────────────────────
  const closePanel2 = contextSafe(() => {
    cancelPanel2CloseTimer();
    if (!panel2OpenRef.current) return;
    panel2OpenRef.current = false;
    const panel2 = panel2Ref.current;
    if (!panel2) return;
    if (isMobile()) {
      gsap.to(panel2, { x: '100vw', duration: 0.4, ease: 'expo.out', force3D: true, overwrite: 'auto' });
    } else {
      gsap.to(panel2, { clipPath: CLIP_HIDDEN, duration: 0.45, ease: 'expo.out', force3D: true, overwrite: 'auto' });
    }
  });

  // ─── Panel 2: swap content ────────────────────────────────────────────────
  const swapSublistContent = contextSafe((newId) => {
    const oldId = activeSubIdRef.current;
    const oldLbls = sublistLabelRefs.current[oldId] || [];
    const newLbls = sublistLabelRefs.current[newId] || [];

    function showNew() {
      setActiveSublist(newId);
      resetSubLinkVisuals(newId);
      if (newLbls.length) {
        gsap.fromTo(
          newLbls,
          { opacity: 0, x: -16 },
          { opacity: 1, x: 0, duration: 0.45, ease: 'expo.out', easeReverse: true, stagger, force3D: true, overwrite: 'auto' }
        );
      }
    }

    if (oldLbls.length) {
      gsap.to(oldLbls, {
        opacity: 0, x: -8, duration: 0.18, ease: 'expo.out', stagger: stagger * 0.3,
        overwrite: 'auto', onComplete: showNew,
      });
    } else {
      showNew();
    }
  });

  // ─── Schedule panel-2 close ───────────────────────────────────────────────
  const schedulePanel2Close = useCallback(() => {
    cancelPanel2CloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      closePanel2();
    }, CLOSE_PANEL2_DELAY);
  }, [cancelPanel2CloseTimer, closePanel2]);

  // ─── Open / Close drawer ──────────────────────────────────────────────────
  const openMenu = contextSafe(() => {
    if (isOpenRef.current) return;
    isOpenRef.current = true;
    setIsOpen(true);
    toggleRef.current?.setAttribute('aria-expanded', 'true');
    toggleRef.current?.setAttribute('aria-label', 'Close navigation menu');
    panel2OpenRef.current = false;
    activeSubIdRef.current = null;
    setPanel2InitialState();
    buildTimelines();
    if (closeTlRef.current) closeTlRef.current.pause(0);
    openTlRef.current?.restart();
  });

  const closeMenu = contextSafe(() => {
    if (!isOpenRef.current) return;
    isOpenRef.current = false;
    setIsOpen(false);
    closePanel2();
    toggleRef.current?.setAttribute('aria-expanded', 'false');
    toggleRef.current?.setAttribute('aria-label', 'Open navigation menu');
    toggleRef.current?.focus();
    if (openTlRef.current)  openTlRef.current.pause();
    if (closeTlRef.current) closeTlRef.current.restart();
  });

  const handleToggle = useCallback(() => {
    isOpenRef.current ? closeMenu() : openMenu();
  }, [openMenu, closeMenu]);

  // ─── Primary button handlers ──────────────────────────────────────────────
  const handlePrimaryMouseEnter = contextSafe((index) => {
    if (!isOpenRef.current || isMobile()) return;
    cancelPanel2CloseTimer();
    const targetId = primaries[index]?.id;
    if (targetId && sublists[targetId]?.length) {
      openPanel2(targetId);
    } else {
      schedulePanel2Close();
    }

    // Dot + label hover
    const dot = primaryDotRefs.current[index];
    const lbl = primaryLblRefs.current[index];
    if (!dot || !lbl) return;
    const offset = dot.offsetWidth + DOT_GAP_PRIMARY;
    gsap.to(dot, { scale: 1,  duration: HOVER_DUR, ease: HOVER_EASE, overwrite: 'auto', force3D: true });
    gsap.to(lbl, { x: offset, duration: HOVER_DUR, ease: HOVER_EASE, overwrite: 'auto', force3D: true });
  });

  const handlePrimaryMouseLeave = contextSafe((index) => {
    const dot = primaryDotRefs.current[index];
    const lbl = primaryLblRefs.current[index];
    if (!dot || !lbl) return;
    gsap.to(dot, { scale: 0, duration: HOVER_DUR, ease: HOVER_EASE, overwrite: 'auto', force3D: true });
    gsap.to(lbl, { x: 0,     duration: HOVER_DUR, ease: HOVER_EASE, overwrite: 'auto', force3D: true });
  });

  const handlePrimaryClick = contextSafe((index) => {
    if (!isOpenRef.current) return;
    cancelPanel2CloseTimer();
    const targetId = primaries[index]?.id;
    if (targetId && sublists[targetId]?.length) {
      openPanel2(targetId);
    } else {
      closePanel2();
    }
  });

  // ─── Primary nav mouseleave → schedule panel-2 close (desktop only) ───────
  const handlePrimaryNavMouseLeave = useCallback((e) => {
    if (!isOpenRef.current || isMobile()) return;
    const panel2 = panel2Ref.current;
    if (panel2 && panel2.contains(e.relatedTarget)) return;
    schedulePanel2Close();
  }, [isMobile, schedulePanel2Close]);

  // ─── Panel-2 mouseenter / mouseleave ──────────────────────────────────────
  const handlePanel2MouseEnter = useCallback(() => {
    if (isMobile()) return;
    cancelPanel2CloseTimer();
  }, [isMobile, cancelPanel2CloseTimer]);

  const handlePanel2MouseLeave = useCallback((e) => {
    if (!isOpenRef.current || isMobile()) return;
    const primaryNav = primaryNavRef.current;
    if (primaryNav && primaryNav.contains(e.relatedTarget)) return;
    schedulePanel2Close();
  }, [isMobile, schedulePanel2Close]);

  // ─── Sub-link hover ───────────────────────────────────────────────────────
  const handleSubLinkEnter = contextSafe((primaryId, itemIndex) => {
    const dot = (sublinkDotRefs.current[primaryId] || [])[itemIndex];
    const lbl = (sublistLabelRefs.current[primaryId] || [])[itemIndex];
    if (!dot || !lbl) return;
    const offset = dot.offsetWidth + DOT_GAP_SUB;
    gsap.to(dot, { scale: 1,  duration: HOVER_DUR, ease: HOVER_EASE, overwrite: 'auto', force3D: true });
    gsap.to(lbl, { x: offset, duration: HOVER_DUR, ease: HOVER_EASE, overwrite: 'auto', force3D: true });
  });

  const handleSubLinkLeave = contextSafe((primaryId, itemIndex) => {
    const dot = (sublinkDotRefs.current[primaryId] || [])[itemIndex];
    const lbl = (sublistLabelRefs.current[primaryId] || [])[itemIndex];
    if (!dot || !lbl) return;
    gsap.to(dot, { scale: 0, duration: HOVER_DUR, ease: HOVER_EASE, overwrite: 'auto', force3D: true });
    gsap.to(lbl, { x: 0,     duration: HOVER_DUR, ease: HOVER_EASE, overwrite: 'auto', force3D: true });
  });

  // ─── Keyboard + resize ────────────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape' && isOpenRef.current) closeMenu(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [closeMenu]);

  useEffect(() => {
    let timer;
    const handleResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        setPanel2InitialState();
      }, 150);
    };
    window.addEventListener('resize', handleResize);
    return () => { clearTimeout(timer); window.removeEventListener('resize', handleResize); };
  }, [setPanel2InitialState]);

  // ─── Public API ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.Anm = window.Anm || {};
    window.Anm.MultiLevelDrawerMenu = {
      open:    () => openMenu(),
      close:   () => closeMenu(),
      refresh: () => {
        if (openTlRef.current)  openTlRef.current.kill();
        if (closeTlRef.current) closeTlRef.current.kill();
        buildTimelines();
      },
    };
    return () => {
      if (window.Anm) delete window.Anm.MultiLevelDrawerMenu;
    };
  }, [openMenu, closeMenu, buildTimelines]);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className={`mldm_wrap${className ? ' ' + className : ''}`}
      data-anm-multi-level-drawer-menu
    >
      {/* Page content — sits below the overlay */}
      <div className="mldm_page" data-anm-mldm-page>
        <section className="mldm_page_hero">
          <div className="mldm_page_inner">
            <div className="mldm_page_text">
              <p className="mldm_page_eyebrow">{heroEyebrow}</p>
              <h2 className="mldm_page_heading">
                <span className="mldm_page_heading_line">{heroHeading.split(' ').slice(0, Math.ceil(heroHeading.split(' ').length / 2)).join(' ')}</span>{' '}
                <span className="mldm_page_heading_line mldm_page_heading_dim">{heroHeading.split(' ').slice(Math.ceil(heroHeading.split(' ').length / 2)).join(' ')}</span>
              </h2>
              <p className="mldm_page_sub">{heroSub}</p>
            </div>
            <div className="mldm_page_poster">
              <img className="mldm_page_poster_img" src={heroImage} alt="Misty golden hills under a pale sky" />
            </div>
          </div>
        </section>
      </div>

      {/* Logo — sits below the overlay */}
      <span ref={logoRef} className="mldm_logo" data-anm-mldm-logo>
        {logo}
      </span>

      {/* Toggle — sits above the overlay */}
      <button
        ref={toggleRef}
        className="mldm_toggle"
        data-anm-mldm-toggle
        aria-expanded={isOpen}
        aria-controls="mldm_overlay"
        aria-label="Open navigation menu"
        onClick={handleToggle}
      >
        <span className="mldm_toggle_label_wrap">
          <span ref={labelTrackRef} className="mldm_toggle_label_track" data-anm-mldm-label-track>
            <span ref={labelOpenRef} className="mldm_toggle_label mldm_toggle_label_open" data-anm-mldm-label-open>Menu</span>
            <span className="mldm_toggle_label mldm_toggle_label_close">Close</span>
          </span>
        </span>
        <span className="mldm_toggle_icon" aria-hidden="true">
          <span ref={iconTopRef}    className="mldm_toggle_line mldm_toggle_line_top"    data-anm-mldm-icon-top />
          <span ref={iconBottomRef} className="mldm_toggle_line mldm_toggle_line_bottom" data-anm-mldm-icon-bottom />
        </span>
      </button>

      {/* Overlay */}
      <div
        ref={overlayRef}
        className="mldm_overlay"
        id="mldm_overlay"
        data-anm-mldm-overlay
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        aria-hidden="true"
        inert
      >
        {/* Scrim */}
        <button
          ref={scrimRef}
          className="mldm_scrim"
          data-anm-mldm-scrim
          aria-label="Close menu"
          tabIndex={-1}
          onClick={closeMenu}
        />

        {/* Panel 1 — primary categories */}
        <aside
          ref={panel1Ref}
          className="mldm_panel mldm_panel_primary"
          data-anm-mldm-panel
          data-anm-mldm-panel-level="1"
        >
          <div className="mldm_panel_inner">
            <nav
              ref={primaryNavRef}
              className="mldm_primary_nav"
              aria-label="Primary categories"
              onMouseLeave={handlePrimaryNavMouseLeave}
            >
              <ul className="mldm_list">
                {primaries.map((primary, i) => (
                  <li key={primary.id} className="mldm_item">
                    <button
                      ref={(el) => { primaryBtnRefs.current[i] = el; }}
                      className="mldm_primary"
                      data-anm-mldm-primary
                      data-anm-mldm-target={primary.id}
                      aria-expanded="false"
                      onMouseEnter={() => handlePrimaryMouseEnter(i)}
                      onMouseLeave={() => handlePrimaryMouseLeave(i)}
                      onClick={() => handlePrimaryClick(i)}
                    >
                      <span
                        ref={(el) => { primaryDotRefs.current[i] = el; }}
                        className="mldm_primary_dot"
                        aria-hidden="true"
                      />
                      <span
                        ref={(el) => { primaryLblRefs.current[i] = el; }}
                        className="mldm_primary_label"
                      >
                        {primary.label}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              <a ref={exploreRef} className="mldm_explore" data-anm-mldm-secondary href="#">
                Explore all
              </a>
            </nav>

            <div className="mldm_cards">
              {cards.map((card, i) => (
                <a
                  key={card.label}
                  ref={(el) => { cardRefs.current[i] = el; }}
                  className="mldm_card"
                  data-anm-mldm-secondary
                  href="#"
                >
                  <span className="mldm_card_media">
                    <img className="mldm_card_img" src={card.src} alt={card.alt || ''} />
                  </span>
                  <span className="mldm_card_label">{card.label}</span>
                </a>
              ))}
            </div>

            <nav className="mldm_footer_nav" aria-label="Secondary">
              {secondaryLinks.map((link, i) => (
                <a
                  key={link.label}
                  ref={(el) => { footerLinkRefs.current[i] = el; }}
                  className="mldm_footer_link"
                  data-anm-mldm-secondary
                  href={link.href}
                >
                  {link.label}
                </a>
              ))}
            </nav>
          </div>
        </aside>

        {/* Panel 2 — subcategories */}
        <aside
          ref={panel2Ref}
          className="mldm_panel mldm_panel_secondary"
          data-anm-mldm-panel
          data-anm-mldm-panel-level="2"
          onMouseEnter={handlePanel2MouseEnter}
          onMouseLeave={handlePanel2MouseLeave}
        >
          <button
            ref={backBtnRef}
            className="mldm_back"
            data-anm-mldm-back
            aria-label="Back to primary categories"
            onClick={closePanel2}
          >
            <span className="mldm_back_icon" aria-hidden="true" />
            <span className="mldm_back_label">Back</span>
          </button>

          <div className="mldm_panel_inner">
            <div className="mldm_sublist_stack" data-anm-mldm-sublist-stack>
              {primaries.map((primary) => {
                const items = sublists[primary.id] || [];
                // Initialise ref arrays for this primary
                if (!sublistLabelRefs.current[primary.id]) sublistLabelRefs.current[primary.id] = [];
                if (!sublinkDotRefs.current[primary.id])   sublinkDotRefs.current[primary.id]   = [];

                return (
                  <div
                    key={primary.id}
                    ref={(el) => { sublistRefs.current[primary.id] = el; }}
                    className={`mldm_sublist${primary.id === primaries[0]?.id ? ' mldm_sublist_active' : ''}`}
                    data-anm-mldm-sublist
                    data-anm-mldm-sublist-for={primary.id}
                    aria-hidden={primary.id !== primaries[0]?.id}
                  >
                    <ul className="mldm_list">
                      {items.map((item, j) => (
                        <li key={item} className="mldm_item">
                          <button
                            className="mldm_sublink"
                            data-anm-mldm-secondary-link
                            onMouseEnter={() => handleSubLinkEnter(primary.id, j)}
                            onMouseLeave={() => handleSubLinkLeave(primary.id, j)}
                          >
                            <span
                              ref={(el) => { sublinkDotRefs.current[primary.id][j] = el; }}
                              className="mldm_sublink_dot"
                              aria-hidden="true"
                            />
                            <span
                              ref={(el) => { sublistLabelRefs.current[primary.id][j] = el; }}
                              className="mldm_sublink_label"
                            >
                              {item}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>

            <a className="mldm_sub_explore" data-anm-mldm-secondary href="#">Explore all</a>
          </div>
        </aside>
      </div>
    </div>
  );
}
