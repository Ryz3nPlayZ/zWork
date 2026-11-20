'use client';

import { useRef, useState, forwardRef, useImperativeHandle } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { SplitText } from 'gsap/SplitText';
import './accordion.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(useGSAP);
  if (typeof SplitText !== 'undefined') {
    gsap.registerPlugin(SplitText);
  }
}

const AccordionItem = forwardRef(function AccordionItem({
  children,
  defaultOpen = false,
  duration = 0.5,
  ease = 'expo.inOut',
  iconMode = 'both',
  iconRotation = -180,
  enableStagger = false,
  staggerDuration = 0.4,
  staggerDelay = 0.08,
  staggerEase = 'expo.out',
  staggerYPercent = 110,
  staggerStartDelay = 200,
  onOpen,
  onClose,
}, ref) {
  const itemRef = useRef(null);
  const contentRef = useRef(null);
  const iconRef = useRef(null);
  const verticalBarRef = useRef(null);
  const tlRef = useRef(null);
  const splitInstanceRef = useRef(null);
  const textTlRef = useRef(null);
  const [isOpen, setIsOpen] = useState(defaultOpen);

  useImperativeHandle(ref, () => ({
    open: () => !isOpen && toggle(),
    close: () => isOpen && toggle(),
    toggle,
    isOpen: () => isOpen,
  }), [isOpen]);

  const { contextSafe } = useGSAP({ scope: itemRef });

  useGSAP(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!contentRef.current) return;

    gsap.set(contentRef.current, {
      height: 0,
      overflow: 'hidden',
      force3D: true,
      willChange: 'height',
    });

    tlRef.current = gsap.timeline({ paused: true, defaults: { duration, ease } });

    tlRef.current.to(contentRef.current, { height: 'auto', duration, ease }, 0);

    if (iconRef.current) {
      if (iconMode === 'rotate' || iconMode === 'both') {
        tlRef.current.to(iconRef.current, { rotation: iconRotation, duration, ease }, 0);
      }
      if ((iconMode === 'fade' || iconMode === 'both') && verticalBarRef.current) {
        tlRef.current.to(verticalBarRef.current, { opacity: 0, duration: duration * 0.5, ease: 'power2.inOut' }, duration * 0.25);
      }
    }

    if (defaultOpen) {
      tlRef.current.progress(1);
      if (enableStagger && typeof SplitText !== 'undefined') {
        document.fonts.ready.then(() => setTimeout(() => animateTextStagger(), 100));
      }
    }

    return () => {
      if (tlRef.current) tlRef.current.kill();
      if (textTlRef.current) textTlRef.current.kill();
      if (splitInstanceRef.current) splitInstanceRef.current.revert();
    };
  }, { scope: itemRef, dependencies: [duration, ease, iconMode, iconRotation, defaultOpen] });

  const animateTextStagger = contextSafe(() => {
    if (!enableStagger || typeof SplitText === 'undefined' || !contentRef.current) return;

    const textElements = contentRef.current.querySelectorAll('.accordion_text, p, span');
    if (!textElements.length) return;

    textElements.forEach((textElement) => {
      splitInstanceRef.current = SplitText.create(textElement, {
        type: 'lines',
        mask: 'lines',
        linesClass: 'accordion_split_line',
      });

      const lines = splitInstanceRef.current.lines;
      gsap.set(lines, { yPercent: staggerYPercent, force3D: true });

      textTlRef.current = gsap.to(lines, {
        yPercent: 0,
        duration: staggerDuration,
        stagger: staggerDelay,
        ease: staggerEase,
        force3D: true,
      });
    });
  });

  const resetTextStagger = contextSafe(() => {
    if (textTlRef.current) {
      textTlRef.current.kill();
      textTlRef.current = null;
    }
    if (splitInstanceRef.current) {
      splitInstanceRef.current.revert();
      splitInstanceRef.current = null;
    }
  });

  const toggle = contextSafe(() => {
    if (!tlRef.current) return;

    if (!isOpen) {
      tlRef.current.play();
      setIsOpen(true);
      onOpen?.();

      if (enableStagger) {
        setTimeout(() => {
          document.fonts.ready.then(animateTextStagger);
        }, staggerStartDelay);
      }
    } else {
      tlRef.current.reverse();
      setIsOpen(false);
      resetTextStagger();
      onClose?.();
    }
  });

  return (
    <div ref={itemRef} className="accordion_item" data-anm-accordion-item>
      {typeof children === 'function' ? children({ toggle, isOpen, contentRef, iconRef, verticalBarRef }) : children}
    </div>
  );
});

export default function Accordion({
  className = '',
  children,
  allowMultiple = false,
  duration = 0.5,
  ease = 'expo.inOut',
  iconMode = 'both',
  iconRotation = -180,
}) {
  const containerRef = useRef(null);
  const openItemsRef = useRef([]);

  const handleItemOpen = (itemRef) => {
    if (!allowMultiple) {
      openItemsRef.current.forEach((ref) => {
        if (ref !== itemRef && ref.current) {
          ref.current.close();
        }
      });
      openItemsRef.current = [itemRef];
    } else {
      if (!openItemsRef.current.includes(itemRef)) {
        openItemsRef.current.push(itemRef);
      }
    }
  };

  const handleItemClose = (itemRef) => {
    openItemsRef.current = openItemsRef.current.filter((ref) => ref !== itemRef);
  };

  return (
    <div ref={containerRef} className={`accordion_section ${className}`.trim()} data-anm-accordion>
      {children}
    </div>
  );
}

Accordion.Item = AccordionItem;
