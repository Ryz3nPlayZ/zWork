// Demo images are from Arqe (arqe.ai). They are placeholders: swap them for your own before going live. Using them in your own product needs your own Arqe plan.
'use client';

import { useRef, useCallback, useEffect } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { CustomEase } from 'gsap/CustomEase';
import './feature-dialog.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP, CustomEase);
  CustomEase.create('annnimate', 'M0,0 C0.3,0.9 0.1,1 1,1');
  CustomEase.create('annnimateInOut', 'M0,0 C0.7,0 0.16,1 1,1');
}

// Overlay tint endpoints. Element opacity stays 1 the whole time;
// the tint alpha is the animated value.
const OVERLAY_TINT = 'rgba(10, 10, 10, 0.2)';
const OVERLAY_TINT_OFF = 'rgba(10, 10, 10, 0)';
const OVERLAY_BLUR = '6px';
const ENTER_DISTANCE = 128;
// The exit is its own, quicker leg: half the travel, dropping away.
const EXIT_DISTANCE = 64;

const breakpoints = {
  mobile: '(max-width: 479px)',
  landscape: '(orientation: landscape) and (max-width: 767px)',
  tablet: '(max-width: 991px)',
  desktop: '(min-width: 992px)',
};

const DEFAULT_MEDIA_IMAGES = [
  {
    src: '/img/report.webp',
    alt: 'An aerial view of a turquoise river in a rust canyon',
  },
  {
    src: '/img/report.webp',
    alt: 'A wave rolling in across a slate sea at dusk',
  },
];

const DEFAULT_STATS = [
  { num: '430 g', label: 'Weighed to the gram' },
  { num: '68 cm', label: 'Circumference, size 5' },
  { num: '0.8 bar', label: 'Playing pressure' },
];

/**
 * FeatureDialog Component
 * A preview tile with an expand button that opens a tall bottom-anchored
 * dialog - the page dims behind it and the dialog rises in with a
 * fast fade. Focus, Escape and
 * the backdrop are all wired up.
 *
 * @param {string} [className=''] - Additional CSS classes for the wrapper
 * @param {number} [duration=0.55] - Duration of the sheet slide, seconds (the close leg runs faster automatically)
 * @param {string} [ease='annnimate'] - GSAP ease for the open leg (close always uses annnimateInOut)
 * @param {string} [disable=''] - Comma-separated viewports to disable on: desktop, tablet, landscape, mobile
 * @param {string} [label='Night ball, 01'] - Small meta label on the tile
 * @param {string} [title='Game leather'] - Tile headline
 * @param {{src: string, alt: string}} [tileImage] - Tile media image
 * @param {string} [sheetTitle='Broken in by hand'] - Dialog display heading, also the dialog aria-label
 * @param {string} [sheetText] - Dialog intro paragraph
 * @param {string} [actionLabel='Explore the story'] - Primary action button label
 * @param {{src: string, alt: string}[]} [mediaImages] - Two-up media row images
 * @param {{num: string, label: string}[]} [stats] - Stat blocks
 * @param {{src: string, alt: string}} [sheetImage] - Full-width media block image
 * @param {string} [outro] - Closing paragraph
 */
export default function FeatureDialog({
  className = '',
  duration = 0.55,
  ease = 'annnimate',
  disable = '',
  label = 'Night ball, 01',
  title = 'Game leather',
  tileImage = {
    src: '/img/report.webp',
    alt: 'A dark leather football on a black studio ground',
  },
  sheetTitle = 'Broken in by hand',
  sheetText = 'Full-grain leather, worked in by hand before it ships, so the first touch feels like the hundredth.',
  actionLabel = 'Explore the story',
  mediaImages = DEFAULT_MEDIA_IMAGES,
  stats = DEFAULT_STATS,
  sheetImage = {
    src: '/img/report.webp',
    alt: 'A bird over a green valley',
  },
  outro = 'Made for the pitch behind the gym, in January, with cold hands.',
}) {
  const stageRef = useRef(null);
  const tileRef = useRef(null);
  const glyphTrRef = useRef(null);
  const glyphBlRef = useRef(null);
  const toggleRef = useRef(null);
  const overlayRef = useRef(null);
  const modalRef = useRef(null);
  const gradientRef = useRef(null);
  const sheetRef = useRef(null);
  const closeBtnRef = useRef(null);
  const titleInnerRef = useRef(null);

  const isOpenRef = useRef(false);
  const scrollLockedRef = useRef(false);
  const liveTlRef = useRef(null);

  const titleName = (sheetTitle || 'details').trim() || 'details';

  const isDisabled = useCallback(() => {
    if (!disable) return false;
    return disable.split(',').some((v) => {
      const q = breakpoints[v.trim()];
      return q && window.matchMedia(q).matches;
    });
  }, [disable]);

  const lockScroll = useCallback(() => {
    if (scrollLockedRef.current) return;
    scrollLockedRef.current = true;
    document.body.style.overflow = 'hidden';
  }, []);

  const unlockScroll = useCallback(() => {
    if (!scrollLockedRef.current) return;
    scrollLockedRef.current = false;
    document.body.style.overflow = '';
  }, []);

  const setOpenAria = useCallback((open) => {
    toggleRef.current?.setAttribute('aria-expanded', open ? 'true' : 'false');
    const sheet = sheetRef.current;
    if (!sheet) return;
    sheet.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) sheet.removeAttribute('inert');
    else sheet.setAttribute('inert', '');
  }, []);

  const { contextSafe } = useGSAP({ scope: stageRef });

  // Open and close are deliberately ASYMMETRIC (different travel and speed),
  // so they are paired builds rather than one reversed timeline. Every tween
  // is a .to() from the LIVE values, and killLive() stops whatever is in
  // flight first - that is what makes rapid open/close interruptible.
  const killLive = contextSafe(() => {
    if (liveTlRef.current) { liveTlRef.current.kill(); liveTlRef.current = null; }
    gsap.killTweensOf([overlayRef.current, modalRef.current, gradientRef.current].filter(Boolean));
  });

  const onOpenSettle = useCallback(() => {
    liveTlRef.current = null;
    if (document.hasFocus()) closeBtnRef.current?.focus();
  }, []);

  const onCloseSettle = useCallback(() => {
    liveTlRef.current = null;
    unlockScroll();
    stageRef.current?.classList.remove('is-open');
    // Re-park for the next enter while invisible: the exit only travelled
    // half the enter distance, so the enter start position is reset here.
    gsap.set(modalRef.current, { y: ENTER_DISTANCE });
    if (gradientRef.current) gsap.set(gradientRef.current, { yPercent: 30 });
    if (document.hasFocus()) toggleRef.current?.focus();
  }, [unlockScroll]);

  const openSheet = contextSafe(() => {
    if (isDisabled() || isOpenRef.current) return liveTlRef.current;
    isOpenRef.current = true;
    killLive();
    stageRef.current?.classList.add('is-open');
    setOpenAria(true);
    lockScroll();
    if (sheetRef.current) sheetRef.current.scrollTop = 0;

    const tl = gsap.timeline({
      defaults: { ease, force3D: true },
      onComplete: onOpenSettle,
    });
    tl.to(overlayRef.current, {
      '--fdg-blur': OVERLAY_BLUR, backgroundColor: OVERLAY_TINT,
      duration: duration * 0.6,
      data: { label: 'Page dims and blurs behind' },
    }, 0);
    tl.to(modalRef.current, {
      y: 0, duration,
      data: { label: 'Dialog rises into place' },
    }, 0);
    tl.to(modalRef.current, {
      autoAlpha: 1, duration: duration * 0.45,
      data: { label: 'Dialog fades in fast' },
    }, 0);
    if (gradientRef.current) {
      tl.to(gradientRef.current, {
        yPercent: 0, autoAlpha: 1, duration: duration * 0.9,
        data: { label: 'Gradient band drifts up and fades in' },
      }, 0.1);
    }
    liveTlRef.current = tl;
    return tl;
  });

  const closeSheet = contextSafe(() => {
    if (!isOpenRef.current) return liveTlRef.current;
    isOpenRef.current = false;
    killLive();
    setOpenAria(false);

    const tl = gsap.timeline({
      defaults: { ease: 'annnimateInOut', force3D: true },
      onComplete: onCloseSettle,
    });
    tl.to(modalRef.current, {
      y: EXIT_DISTANCE, duration: duration * 0.4,
      data: { label: 'Dialog drops away' },
    }, 0);
    tl.to(modalRef.current, {
      autoAlpha: 0, duration: duration * 0.32,
      data: { label: 'Dialog fades out' },
    }, 0);
    tl.to(overlayRef.current, {
      '--fdg-blur': '0px', backgroundColor: OVERLAY_TINT_OFF,
      duration: duration * 0.4,
      data: { label: 'Page sharpens again' },
    }, 0);
    if (gradientRef.current) {
      tl.to(gradientRef.current, {
        yPercent: 30, autoAlpha: 0, duration: duration * 0.35,
        data: { label: 'Gradient band sinks out' },
      }, 0);
    }
    liveTlRef.current = tl;
    return tl;
  });

  const handleTileClick = useCallback(() => {
    if (!isOpenRef.current) openSheet();
  }, [openSheet]);

  // Hover micro-move: the two corner arrows spread outward (SVG user units).
  const handleTileEnter = contextSafe(() => {
    if (!glyphTrRef.current || !glyphBlRef.current) return;
    gsap.to(glyphTrRef.current, { x: 1.75, y: -1.75, duration: 0.4, ease: 'annnimateInOut', overwrite: 'auto' });
    gsap.to(glyphBlRef.current, { x: -1.75, y: 1.75, duration: 0.4, ease: 'annnimateInOut', overwrite: 'auto' });
  });

  const handleTileLeave = contextSafe(() => {
    if (!glyphTrRef.current || !glyphBlRef.current) return;
    gsap.to([glyphTrRef.current, glyphBlRef.current], { x: 0, y: 0, duration: 0.4, ease: 'annnimateInOut', overwrite: 'auto' });
  });

  const handleTileKeyDown = useCallback((e) => {
    if (isOpenRef.current) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openSheet();
    }
  }, [openSheet]);

  const handleToggleClick = useCallback((e) => {
    e.stopPropagation();
    openSheet();
  }, [openSheet]);

  const handleCloseClick = useCallback(() => {
    closeSheet();
  }, [closeSheet]);

  const handleModalClick = useCallback((e) => {
    if (isOpenRef.current && sheetRef.current && !sheetRef.current.contains(e.target)) closeSheet();
  }, [closeSheet]);

  useGSAP(() => {
    if (isDisabled()) return;

    tileRef.current?.setAttribute('role', 'button');
    tileRef.current?.setAttribute('tabindex', '0');
    tileRef.current?.setAttribute('aria-haspopup', 'dialog');
    sheetRef.current?.setAttribute('role', 'dialog');
    sheetRef.current?.setAttribute('aria-modal', 'true');
    setOpenAria(false);

    gsap.set(overlayRef.current, { '--fdg-blur': '0px', backgroundColor: OVERLAY_TINT_OFF });
    gsap.set(modalRef.current, { y: ENTER_DISTANCE, autoAlpha: 0 });
    if (gradientRef.current) gsap.set(gradientRef.current, { yPercent: 30, autoAlpha: 0 });

    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: reduce)', () => {
      gsap.globalTimeline.timeScale(20);
    });

    return () => {
      mm.revert();
      if (liveTlRef.current) liveTlRef.current.kill();
    };
  }, { scope: stageRef, dependencies: [] });

  useEffect(() => {
    const onKeydown = (e) => {
      if (e.key === 'Escape' && isOpenRef.current) closeSheet();
      // Focus trap: while open the sheet is a modal dialog, so Tab cycles
      // within it instead of escaping to the page behind.
      if (e.key === 'Tab' && isOpenRef.current) {
        const sheet = sheetRef.current;
        if (!sheet) return;
        const focusables = sheet.querySelectorAll(
          'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        } else if (!sheet.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  }, [closeSheet]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) gsap.globalTimeline.pause();
      else gsap.globalTimeline.resume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Timeline inspector demo (ADR-0011): one open -> close pass, ending back
  // in the closed idle state. setTimeout, not gsap.delayedCall - reduced
  // motion timeScales the global timeline and would fire a delayedCall
  // almost immediately.
  const demo = useCallback(() => {
    if (isOpenRef.current) return null;
    const handle = openSheet();
    setTimeout(() => { closeSheet(); }, (duration + 0.9) * 1000);
    return handle;
  }, [openSheet, closeSheet, duration]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.Anm = window.Anm || {};
    window.Anm.FeatureDialog = {
      open: () => openSheet(),
      close: () => closeSheet(),
      demo: () => demo(),
    };
    return () => {
      if (window.Anm) delete window.Anm.FeatureDialog;
    };
  }, [openSheet, closeSheet, demo]);

  return (
    <div
      ref={stageRef}
      className={`fdg_stage ${className}`.trim()}
      data-anm-feature-dialog
      data-anm-duration={duration}
      data-anm-ease={ease}
      data-anm-disable={disable || undefined}
    >
      <div
        ref={tileRef}
        className="fdg_tile"
        data-anm-fdg-tile
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        onClick={handleTileClick}
        onKeyDown={handleTileKeyDown}
        onMouseEnter={handleTileEnter}
        onMouseLeave={handleTileLeave}
      >
        <div className="fdg_gradient fdg_tile_gradient" />
        <div className="fdg_tile_copy">
          <div className="fdg_tile_label">{label}</div>
          <h3 className="fdg_tile_title">{title}</h3>
        </div>
        <div className="fdg_tile_media" data-anm-fdg-tile-media>
          <img
            className="fdg_tile_img"
            src={tileImage.src}
            alt={tileImage.alt}
            loading="eager"
            decoding="async"
          />
        </div>
        <button
          ref={toggleRef}
          type="button"
          className="fdg_toggle"
          data-anm-fdg-toggle
          aria-expanded="false"
          onClick={handleToggleClick}
        >
          <svg className="fdg_glyph" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path ref={glyphTrRef} className="fdg_glyph_tr" d="M10 2H14V6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path ref={glyphBlRef} className="fdg_glyph_bl" d="M6 14H2V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div ref={overlayRef} className="fdg_overlay" data-anm-fdg-overlay />

      <div ref={modalRef} className="fdg_modal" data-anm-fdg-modal onClick={handleModalClick}>
        <div ref={gradientRef} className="fdg_gradient fdg_panel_gradient" data-anm-fdg-gradient />
        <div className="fdg_panel">
          <section
            ref={sheetRef}
            className="fdg_sheet"
            data-anm-fdg-sheet
            aria-label={titleName}
            aria-hidden="true"
            inert=""
          >
            <button
              ref={closeBtnRef}
              type="button"
              className="fdg_close"
              data-anm-fdg-close
              aria-label="Close dialog"
              onClick={handleCloseClick}
            >
              <svg className="fdg_glyph" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>

            <div className="fdg_sheet_inner">
              <div className="fdg_sheet_grid">
                <div className="fdg_sheet_main">
                  <div className="fdg_title_mask">
                    <h2 ref={titleInnerRef} className="fdg_sheet_title" data-anm-fdg-title>{sheetTitle}</h2>
                  </div>
                  <p className="fdg_sheet_text">{sheetText}</p>
                  <div className="fdg_actions">
                    <button type="button" className="fdg_btn fdg_btn_primary">{actionLabel}</button>
                  </div>
                </div>
              </div>
              <div className="fdg_media_row">
                {mediaImages.map((img) => (
                  <div key={img.src} className="fdg_media_cell">
                    <img className="fdg_sheet_img" src={img.src} alt={img.alt} loading="lazy" decoding="async" />
                  </div>
                ))}
              </div>

              <div className="fdg_stats">
                {stats.map((stat) => (
                  <div key={stat.label} className="fdg_stat">
                    <div className="fdg_stat_num">{stat.num}</div>
                    <div className="fdg_stat_label">{stat.label}</div>
                  </div>
                ))}
              </div>

              <div className="fdg_sheet_media">
                <img className="fdg_sheet_img" src={sheetImage.src} alt={sheetImage.alt} loading="lazy" decoding="async" />
              </div>

              <p className="fdg_outro">{outro}</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
