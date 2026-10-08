import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { TopBar } from "../components/TopBar";
import { Footer } from "../components/Footer";

export default function RefundPage() {
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.fromTo(
        pageRef.current,
        { y: 20, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.6, ease: "power2.out" }
      );
    });
    return () => ctx.revert();
  }, []);

  return (
    <div className="relative min-h-screen bg-[#f7f6f3]">
      <TopBar visible={true} />
      <div ref={pageRef} className="pt-28 pb-20 px-6">
        <div className="max-w-3xl mx-auto">
          <h1
            className="text-3xl md:text-4xl font-semibold tracking-tight text-[#171716] mb-2"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Refund and Cancellation Policy
          </h1>
          <p className="text-[13px] text-[#a09e98] mb-10">Last updated: May 17, 2026</p>

          <div className="space-y-8 text-[15px] text-[#25241f] leading-relaxed">
            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">Cancellation</h2>
              <p>
                You may cancel your zWork Cloud subscription at any time through your account settings or by contacting us. When you cancel:
              </p>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>Your subscription remains active until the end of the current billing period</li>
                <li>You will not be charged for the next billing cycle</li>
                <li>You can continue using zWork Cloud features until your current period expires</li>
                <li>After expiration, you can still use the free self-hosted version</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">Refund Policy</h2>
              <p>
                We offer a full refund within 14 days of your initial subscription purchase if you are not satisfied with the service. To request a refund:
              </p>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>Contact us at <a href="mailto:hello@zwork.ai" className="underline text-[#171716] hover:text-[#6b6a65] transition-colors">hello@zwork.ai</a> within 14 days of your first payment</li>
                <li>Include your account email and the reason for the request</li>
                <li>Refunds are processed within 5-10 business days to the original payment method</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">Renewal Refunds</h2>
              <p>
                For automatic renewal charges, we offer refunds if you contact us within 7 days of the charge and have not significantly used the service during the new billing period. We evaluate these on a case-by-case basis.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">No Refund Scenarios</h2>
              <p>Refunds are generally not available in the following cases:</p>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>More than 14 days have passed since the initial purchase (for first-time purchases)</li>
                <li>More than 7 days have passed since a renewal charge</li>
                <li>The account has been terminated due to violations of our Terms of Service</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">How to Cancel or Request a Refund</h2>
              <p>
                Email us at{" "}
                <a href="mailto:hello@zwork.ai" className="underline text-[#171716] hover:text-[#6b6a65] transition-colors">
                  hello@zwork.ai
                </a>{" "}
                with "Cancel" or "Refund" in the subject line. Include the email address associated with your account. We aim to respond within 2 business days.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">Free Version</h2>
              <p>
                The self-hosted version of zWork is free and open source. No payment is required, so no refund policy applies. You can use it indefinitely at no cost.
              </p>
            </section>
          </div>
        </div>
      </div>
      <Footer />
    </div>
  );
}
