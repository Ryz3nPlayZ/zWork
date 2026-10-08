import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Check } from "lucide-react";

gsap.registerPlugin(ScrollTrigger);

const serif = { fontFamily: "var(--font-serif)" };

const tiers = [
  {
    name: "Free",
    price: "$0",
    period: "forever · self-hosted",
    features: [
      "Full agent capabilities",
      "Bring your own API key",
      "All integrations included",
      "Private, runs locally on your machine",
      "Community support",
    ],
    cta: "Download",
    ctaLink: "/download",
    highlight: false,
  },
  {
    name: "Pro",
    price: "$12",
    period: "per month",
    features: [
      "Everything in Free",
      "No API key needed",
      "Cloud sync across devices",
      "Persistent memory",
      "Priority support",
    ],
    cta: "Join the waitlist",
    ctaLink: "#",
    highlight: true,
  },
  {
    name: "Team",
    price: "$40",
    period: "per month · per seat",
    features: [
      "Everything in Pro",
      "Team workspace & sharing",
      "Admin controls & roles",
      "Usage analytics dashboard",
      "Dedicated support channel",
    ],
    cta: "Contact us",
    ctaLink: "mailto:hello@zwork.ai",
    highlight: false,
  },
];

export function PricingSection() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const ctx = gsap.context(() => {
      cardsRef.current.forEach((card, i) => {
        if (!card) return;
        gsap.fromTo(
          card,
          { y: 50, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.7,
            ease: "power2.out",
            scrollTrigger: {
              trigger: card,
              start: "top 85%",
              toggleActions: "play none none none",
            },
            delay: i * 0.12,
          }
        );
      });
    }, sectionRef);
    return () => ctx.revert();
  }, []);

  return (
    <section
      id="pricing"
      ref={sectionRef}
      className="relative z-50 bg-[#f7f6f3] py-12 md:py-16 px-6"
    >
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-8 md:mb-10">
          <h2
            className="text-4xl md:text-5xl lg:text-6xl font-semibold tracking-tight text-[#171716]"
            style={serif}
          >
            Pricing
          </h2>
          <p className="mt-5 text-lg md:text-xl text-[#6b6a65] max-w-xl mx-auto">
            Start free with your own API key, or upgrade to Cloud for a managed experience.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8 max-w-5xl mx-auto items-stretch">
          {tiers.map((tier, i) => (
            <div
              key={tier.name}
              ref={(el) => { cardsRef.current[i] = el; }}
              className={`group relative p-10 md:p-12 text-center flex flex-col ${
                tier.highlight
                  ? "border-2 border-[#171716] bg-[#171716] text-[#f7f6f3]"
                  : "border border-[#e6e3dc] bg-white text-[#171716]"
              }`}
            >
              {tier.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#f7f6f3] text-[#171716] text-[10px] font-semibold uppercase tracking-[0.15em] px-3 py-1 rounded-full">
                  Most popular
                </div>
              )}
              <h3
                className={`text-3xl md:text-4xl font-semibold tracking-tight mb-2 ${
                  tier.highlight ? "text-[#f7f6f3]" : "text-[#171716]"
                }`}
                style={serif}
              >
                {tier.name}
              </h3>
              <div className={`text-4xl font-semibold mb-1 ${tier.highlight ? "text-[#f7f6f3]" : "text-[#171716]"}`}>
                {tier.price}
              </div>
              <p className="text-[13px] text-[#a09e98] mb-6">{tier.period}</p>

              <ul className="space-y-2 text-left mb-6 flex-1">
                {tier.features.map((f) => (
                  <li
                    key={f}
                    className={`flex items-start gap-3 text-[14px] ${
                      tier.highlight ? "text-[#f7f6f3]" : "text-[#171716]"
                    }`}
                  >
                    <Check
                      className={`h-4 w-4 mt-0.5 shrink-0 ${
                        tier.highlight ? "text-emerald-400" : "text-[#6b6a65]"
                      }`}
                      strokeWidth={2}
                    />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <a
                href={tier.ctaLink}
                className={`inline-flex items-center justify-center w-full px-6 py-3 text-[14px] font-semibold transition-colors ${
                  tier.highlight
                    ? "bg-[#f7f6f3] text-[#171716] hover:bg-white"
                    : "bg-[#171716] text-[#f7f6f3] hover:bg-[#25241f]"
                }`}
              >
                {tier.cta}
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
