import { Faq, Pricing } from "../sections/Closing";

export function PricingPage() {
  return (
    <div className="pt-12 sm:pt-16">
      <Pricing heading="h1" />
      <Faq />
    </div>
  );
}
