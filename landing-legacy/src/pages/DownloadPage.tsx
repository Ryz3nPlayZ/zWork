import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { DownloadSection } from "../components/DownloadSection";
import { TopBar } from "../components/TopBar";

export default function DownloadPage() {
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
    <div className="relative min-h-screen bg-[#171716]">
      <TopBar visible={true} />
      <div ref={pageRef} className="pt-20">
        <DownloadSection />
      </div>
    </div>
  );
}
