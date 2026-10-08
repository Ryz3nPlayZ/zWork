import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { PricingSection } from "../components/PricingSection";
import { TopBar } from "../components/TopBar";

export default function PricingPage() {
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.fromTo(
        pageRef.current,
        { y: 30, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.7, ease: "power2.out" }
      );
    });
    return () => ctx.revert();
  }, []);

  return (
    <div className="relative min-h-screen bg-[#f7f6f3]">
      <TopBar visible={true} />
      <div ref={pageRef} className="pt-20">
        <PricingSection />
      </div>
    </div>
  );
}
