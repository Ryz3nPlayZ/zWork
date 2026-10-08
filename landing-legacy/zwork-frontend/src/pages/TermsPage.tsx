import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { Link } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { Footer } from "../components/Footer";

export default function TermsPage() {
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
            Terms of Service
          </h1>
          <p className="text-[13px] text-[#a09e98] mb-10">Last updated: May 17, 2026</p>

          <div className="space-y-8 text-[15px] text-[#25241f] leading-relaxed">
            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">1. Acceptance of Terms</h2>
              <p>
                By accessing or using zWork ("the Service"), you agree to be bound by these Terms of Service. If you do not agree to these terms, do not use the Service. These terms apply to all visitors, users, and others who access or use the Service.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">2. Description of Service</h2>
              <p>
                zWork is a desktop AI assistant application that runs locally on your machine. The Service is available in two forms: a self-hosted open-source version and a cloud-connected version ("zWork Cloud"). The self-hosted version is provided free of charge. zWork Cloud is offered as a paid subscription.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">3. Accounts and Subscriptions</h2>
              <p>
                To use zWork Cloud, you must create an account and provide accurate, complete information. You are responsible for maintaining the security of your account credentials. Subscriptions are billed on a recurring monthly basis. You may cancel your subscription at any time through your account settings.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">4. Acceptable Use</h2>
              <p>You agree not to use the Service to:</p>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>Violate any applicable laws or regulations</li>
                <li>Infringe upon the intellectual property rights of others</li>
                <li>Distribute malware, spam, or harmful content</li>
                <li>Attempt to gain unauthorized access to any systems or networks</li>
                <li>Use the Service in any way that could damage, disable, or impair its operation</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">5. Intellectual Property</h2>
              <p>
                The self-hosted version of zWork is open-source software released under the MIT License. The zWork Cloud service, including its infrastructure and server-side components, is proprietary. You retain ownership of all content you process through the Service.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">6. Data and Privacy</h2>
              <p>
                In the self-hosted version, all data is processed and stored locally on your machine. For zWork Cloud, data handling is governed by our{" "}
                <Link to="/privacy" className="underline text-[#171716] hover:text-[#6b6a65] transition-colors">
                  Privacy Policy
                </Link>
                . We do not sell your data to third parties.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">7. Disclaimer of Warranties</h2>
              <p>
                The Service is provided "as is" and "as available" without warranties of any kind, either express or implied. We do not guarantee that the Service will be uninterrupted, secure, or error-free.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">8. Limitation of Liability</h2>
              <p>
                To the maximum extent permitted by law, zWork and its contributors shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising out of or related to your use of the Service.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">9. Modifications</h2>
              <p>
                We may update these Terms from time to time. We will notify users of material changes by posting the updated terms on this page with a revised "Last updated" date. Your continued use of the Service after any changes constitutes your acceptance of the new Terms.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-[#171716] mb-3">10. Contact</h2>
              <p>
                If you have questions about these Terms, contact us at{" "}
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
