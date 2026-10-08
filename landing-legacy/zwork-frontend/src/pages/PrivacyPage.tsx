import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { TopBar } from "../components/TopBar";
import { Footer } from "../components/Footer";

export default function PrivacyPage() {
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
            Privacy Policy
          </h1>
          <p className="text-[13px] text-[#a09e98] mb-10">Last updated: May 17, 2026</p>

          <div className="space-y-8 text-[15px] text-[#25241f] leading-relaxed">
            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">1. Overview</h2>
              <p>
                zWork is built with privacy as a core principle. The self-hosted version processes everything locally on your machine — your files, conversations, and data never leave your device. This policy primarily covers data collected when you use zWork Cloud or interact with our website.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">2. Self-Hosted Version</h2>
              <p>
                When using the self-hosted (open-source) version of zWork, all data is processed and stored exclusively on your local machine. We do not collect, transmit, or have access to any of your data, files, or conversations. If you use your own API key ("BYOK"), communications go directly between your machine and the API provider — we are not a party to those transactions.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">3. Data We Collect (zWork Cloud)</h2>
              <p>When you use zWork Cloud, we collect:</p>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li><strong>Account information:</strong> email address, name (when provided)</li>
                <li><strong>Usage data:</strong> conversation history (stored to provide the service and persistent memory features)</li>
                <li><strong>Payment information:</strong> processed through Stripe; we do not store credit card numbers</li>
                <li><strong>Device information:</strong> operating system, app version (for compatibility and debugging)</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">4. Website Data</h2>
              <p>When visiting zwork.ai, we may collect:</p>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>Basic analytics (page views, referral source, browser type) to improve the site</li>
                <li>Cookies necessary for site functionality</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">5. How We Use Your Data</h2>
              <p>We use collected data to:</p>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>Provide and maintain the zWork Cloud service</li>
                <li>Process payments and manage subscriptions</li>
                <li>Improve the product through anonymized usage analysis</li>
                <li>Send service-related communications (account updates, billing)</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">6. Data Sharing</h2>
              <p>
                We do not sell, rent, or trade your personal data. We share data only with service providers necessary to operate zWork Cloud (e.g., Stripe for payment processing, cloud infrastructure providers). All third-party providers are bound by their own privacy obligations.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">7. Data Retention</h2>
              <p>
                Cloud conversation history is retained as long as your account is active to support the persistent memory feature. You can delete your data at any time by contacting us. Upon account deletion, all associated data is removed within 30 days.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">8. Your Rights</h2>
              <p>You have the right to:</p>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>Access the personal data we hold about you</li>
                <li>Request correction or deletion of your data</li>
                <li>Export your data in a portable format</li>
                <li>Opt out of any non-essential communications</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">9. Security</h2>
              <p>
                We implement reasonable technical and organizational measures to protect your data. However, no method of transmission over the internet or electronic storage is 100% secure. We encourage using the self-hosted version for maximum privacy.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">10. Children's Privacy</h2>
              <p>
                zWork is not intended for children under 13. We do not knowingly collect personal information from children under 13.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">11. Changes to This Policy</h2>
              <p>
                We may update this Privacy Policy from time to time. Material changes will be posted on this page with an updated revision date. Continued use of the Service after changes constitutes acceptance.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">12. Contact</h2>
              <p>
                For privacy-related inquiries or to exercise your data rights, contact us at{" "}
                <a href="mailto:hello@zwork.ai" className="underline text-[#171716] hover:text-[#6b6a65] transition-colors">
                  hello@zwork.ai
                </a>
                .
              </p>
            </section>
          </div>
        </div>
      </div>
      <Footer />
    </div>
  );
}
