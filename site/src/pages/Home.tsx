import { Hero } from "../sections/Hero";
import { Desktop } from "../sections/Desktop";
import { Capabilities, Statement } from "../sections/Story";
import { Outro } from "../sections/Outro";

export function Home() {
  return (
    <>
      <Desktop>
        <Hero />
      </Desktop>
      <Statement />
      <Capabilities />
      <Outro />
    </>
  );
}
