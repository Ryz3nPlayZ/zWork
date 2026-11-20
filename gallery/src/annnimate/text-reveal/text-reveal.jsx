'use client';

import { useRef, useState, useEffect } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import './text-reveal.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText);
}

/**
 * TextReveal Component
 * Professional text reveal animation using GSAP SplitText with line masking. Text slides up from
 * behind masks as you scroll, creating a clean, editorial reveal effect.
 *
 * @param {string} [className=''] - Additional CSS classes
 * @param {React.ReactNode} children - Text content to animate
 * @param {string} [type='words'] - Split type ('lines', 'words', 'chars')
 * @param {string} [start='top 80%'] - ScrollTrigger start position
 * @param {string} [end=''] - ScrollTrigger end position (for scrub)
 * @param {boolean|number} [scrub=false] - Link animation to scroll (false, true, or smoothness number)
 * @param {number} [duration=0.8] - Animation duration (seconds)
 * @param {number} [stagger=0.08] - Stagger delay between elements
 * @param {string} [ease='expo.out'] - GSAP easing function
 * @param {number} [yPercent=110] - Initial Y offset percentage
 * @param {boolean} [markers=false] - Show ScrollTrigger debug markers
 * @param {function} [onComplete] - Callback when animation completes
 */
export default function TextReveal({
  className = '',
  children,
  type = 'words',
  start = 'top 80%',
  end = '',
  scrub = false,
  duration = 0.8,
  stagger = 0.08,
  ease = 'expo.out',
  yPercent = 110,
  markers = false,
  onComplete,
}) {
  const containerRef = useRef(null);
  const textRef = useRef(null);
  const splitRef = useRef(null);
  const [fontsLoaded, setFontsLoaded] = useState(false);

  // Wait for fonts before SplitText
  useEffect(() => {
    if (typeof window !== 'undefined') {
      document.fonts.ready.then(() => setFontsLoaded(true));
    }
  }, []);

  useGSAP(
    () => {
      if (!fontsLoaded || !textRef.current) return;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

      // Determine split types
      const typesToSplit =
        type === 'lines'
          ? 'lines'
          : type === 'words'
            ? 'lines,words'
            : 'lines,words,chars';

      // Split text with masking
      splitRef.current = new SplitText(textRef.current, {
        type: typesToSplit,
        linesClass: 'split-line',
        wordsClass: 'split-word',
        charsClass: 'split-char',
      });

      // Get animation targets based on type
      const targets = splitRef.current[type];

      // CRITICAL: Set initial position BEFORE making visible to prevent FOUC
      gsap.set(targets, {
        yPercent,
        force3D: true,
        willChange: 'transform',
      });
      gsap.set(textRef.current, { autoAlpha: 1 });

      // Parse scrub value
      const scrubValue =
        scrub === 'true' || scrub === true
          ? true
          : typeof scrub === 'number' || !isNaN(parseFloat(scrub))
            ? parseFloat(scrub)
            : false;

      // Animate text reveal
      gsap.to(targets, {
        yPercent: 0,
        duration,
        stagger,
        ease,
        force3D: true,
        scrollTrigger: {
          trigger: containerRef.current,
          start,
          end: end || undefined,
          scrub: scrubValue,
          once: !scrubValue,
          markers,
        },
        onComplete: () => {
          // Clear willChange after animation
          gsap.set(targets, { willChange: 'auto' });
          onComplete?.();
        },
      });

      // Cleanup
      return () => {
        if (splitRef.current) {
          splitRef.current.revert();
        }
        ScrollTrigger.getAll().forEach((st) => st.kill());
        if (targets) {
          gsap.killTweensOf(targets);
        }
      };
    },
    {
      scope: containerRef,
      dependencies: [fontsLoaded, type, start, end, scrub, duration, stagger, ease, yPercent, markers],
    }
  );

  return (
    <div ref={containerRef} className={`text_reveal_wrap ${className}`.trim()}>
      <div
        ref={textRef} data-anm-scroll-text-reveal className="text_reveal_text"
        style={{ visibility: 'hidden' }}
      >
        {children}
      </div>
    </div>
  );
}
