import { MotionConfig } from "motion/react";
import { Nav, Hero } from "./components/Hero";
import { Gap } from "./components/Gap";
import { Proof } from "./components/Proof";
import { How } from "./components/How";
import { Schedules } from "./components/Schedules";
import { Capabilities } from "./components/Capabilities";
import { Apps } from "./components/Apps";
import { Power } from "./components/Power";
import { Private } from "./components/Private";
import { Pricing } from "./components/Pricing";
import { Faq } from "./components/Faq";
import { Footer, Install } from "./components/Footer";

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <Nav />
      <main>
        <Hero />
        <Gap />
        <Proof />
        <How />
        <Schedules />
        <Capabilities />
        <Apps />
        <Power />
        <Private />
        <Pricing />
        <Faq />
        <Install />
      </main>
      <Footer />
    </MotionConfig>
  );
}
