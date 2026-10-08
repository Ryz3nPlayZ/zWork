import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Check } from "lucide-react";
import { track } from "@vercel/analytics";

gsap.registerPlugin(ScrollTrigger);

const serif = { fontFamily: "var(--font-serif)" };

const tiers = [
  {
    name: "Free",
    price: "$0",
    subtitle: "Forever. No credit card.",
    features: [
      "An AI that reads your code but never your diary",
      "Local execution — your secrets stay in your basement",
      "BYOK: Bring Your Own Keys (and leftover pizza)",
      "All the skills, none of the talent required",
      "One device. Your mom's iPad is not invited.",
    ],
    cta: "Download",
    ctaLink: "/download",
  },
  {
    name: "Free+",
    price: "$0",
    subtitle: "Also forever. Seriously.",
    features: [
      "Everything in Free, plus extra existential dread",
      "Unlimited devices because you hoard electronics",
      "Custom skill marketplace (it's just you and a JSON file)",
      "Priority model access (3rd in line instead of 47th)",
      "Team workspace for up to 5 people you pretend to like",
    ],
    cta: "Download",
    ctaLink: "/download",
  },
  {
    name: "Free Super",
    price: "$0",
    subtitle: "We are not kidding.",
    features: [
      "Everything in Free+, plus a false sense of superiority",
      "Unlimited team members (good luck managing that)",
      "Self-hosted server option (for your inner sysadmin)",
      "Enterprise audit logs that no human will ever read",
      "Dedicated support channel (it's mostly memes)",
      "A holographic sticker (this is the real value prop)",
    ],
    cta: "Download",
    ctaLink: "/download",
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
            We could not think of a reason to charge you.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8 max-w-5xl mx-auto items-stretch">
          {tiers.map((tier, i) => (
            <div
              key={tier.name}
              ref={(el) => { cardsRef.current[i] = el; }}
              className="group relative border border-[#e6e3dc] bg-white p-10 md:p-12 text-center flex flex-col transition-all duration-300 ease-out hover:-translate-y-2 hover:scale-[1.02] hover:bg-[#171716] hover:border-[#171716] hover:shadow-2xl"
            >
              <h3
                className="text-3xl md:text-4xl font-semibold tracking-tight text-[#171716] mb-2 group-hover:text-[#f7f6f3] transition-colors duration-300"
                style={serif}
              >
                {tier.name}
              </h3>
              <div className="text-4xl font-semibold text-[#171716] mb-1 group-hover:text-[#f7f6f3] transition-colors duration-300">
                {tier.price}
              </div>
              <p className="text-[13px] text-[#a09e98] mb-6">{tier.subtitle}</p>

              <ul className="space-y-2 text-left mb-6 flex-1">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-3 text-[14px] text-[#171716] group-hover:text-[#f7f6f3] transition-colors duration-300">
                    <Check className="h-4 w-4 text-[#6b6a65] mt-0.5 shrink-0 group-hover:text-[#f7f6f3] transition-colors duration-300" strokeWidth={2} />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <a
                href={tier.ctaLink}
                onClick={() => track('pricing_cta_click', { tier: tier.name })}
                className="inline-flex items-center justify-center w-full px-6 py-3 text-[14px] font-semibold bg-[#171716] text-[#f7f6f3] hover:bg-[#f7f6f3] hover:text-[#171716] group-hover:bg-[#f7f6f3] group-hover:text-[#171716] transition-colors duration-300"
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
