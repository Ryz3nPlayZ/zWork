import { lazy, useRef, type ComponentType, type ReactNode } from "react";

const lazyDemo = (loader: () => Promise<{ default: ComponentType<any> }>) => lazy(loader);

const Accordion = Object.assign(lazyDemo(() => import("./annnimate/accordion/accordion.jsx")), {
  Item: lazyDemo(async () => {
    const { default: Component } = await import("./annnimate/accordion/accordion.jsx");
    return { default: Component.Item };
  }),
});
const AsciiOverlay = lazyDemo(() => import("./annnimate/ascii-overlay/ascii-overlay.jsx"));
const CurtainSlider = lazyDemo(() => import("./annnimate/curtain-slider/curtain-slider.jsx"));
const DiagonalGallery = lazyDemo(() => import("./annnimate/diagonal-gallery/diagonal-gallery.jsx"));
const DualScramble = lazyDemo(() => import("./annnimate/dual-scramble/dual-scramble.jsx"));
const EchoHeadline = lazyDemo(() => import("./annnimate/echo-headline/echo-headline.jsx"));
const ElasticDivider = lazyDemo(() => import("./annnimate/elastic-divider/elastic-divider.jsx"));
const FeatureDialog = lazyDemo(() => import("./annnimate/feature-dialog/feature-dialog.jsx"));
const FloatingNavbar = lazyDemo(() => import("./annnimate/floating-navbar/floating-navbar.jsx"));
const HoverIndex = lazyDemo(() => import("./annnimate/hover-index/hover-index.jsx"));
const ImageFlyIn = lazyDemo(() => import("./annnimate/image-fly-in/image-fly-in.jsx"));
const MagneticTagCloud = lazyDemo(() => import("./annnimate/magnetic-tag-cloud/magnetic-tag-cloud.jsx"));
const MultiLevelDrawerMenu = lazyDemo(() => import("./annnimate/multi-level-drawer-menu/multi-level-drawer-menu.jsx"));
const Pricing = lazyDemo(() => import("./annnimate/pricing/pricing.jsx"));
const ProcessRail = lazyDemo(() => import("./annnimate/process-rail/process-rail.jsx"));
const RotatingWords = lazyDemo(() => import("./annnimate/rotating-words/rotating-words.jsx"));
const ScaleSlider = lazyDemo(() => import("./annnimate/scale-slider/scale-slider.jsx"));
const SplitFlapBoard = lazyDemo(() => import("./annnimate/split-flap-board/split-flap-board.jsx"));
const StackingCards = lazyDemo(() => import("./annnimate/stacking-cards/stacking-cards.jsx"));
const TextReveal = lazyDemo(() => import("./annnimate/text-reveal/text-reveal.jsx"));

/**
 * Every component in the gallery: what it does, where zWork would use it,
 * and a demo built from zWork's own story (the Friday expense report from
 * the launch video). Images are stills from that video in public/img; the
 * -sq and -p versions are square and portrait cuts of the same frames.
 */

export type Group = "Landing page" | "Navigation" | "Pricing and help" | "In the app";
export const GROUPS: Group[] = ["Landing page", "Navigation", "Pricing and help", "In the app"];

export type Entry = {
  slug: string;
  name: string;
  group: Group;
  /** What the component does, in a line. */
  does: string;
  /** Where zWork would put it, and why it fits there. */
  use: string;
  /** Wrap the demo in a centred stage; full-screen demos size themselves. */
  fit?: boolean;
  Demo: () => ReactNode;
};

const img = (name: string) => `/img/${name}.webp`;

const SITE = "https://tryzwork.app";

/* ---------- Demos ---------- */

const FAQ = [
  {
    q: "Can I use zWork for free?",
    a: "Yes. Free has every tool, skill and connector, on zWork's shared models or your own key, with up to three schedules.",
  },
  {
    q: "What does Pro add?",
    a: "200 messages every five hours and 1,000 a week on hosted models, up to five tasks at once and unlimited schedules, for $12 a month.",
  },
  {
    q: "Does zWork send anything without asking?",
    a: "No. Before an email or a file leaves your computer, zWork shows you what it is and who it's for, and waits until you allow it.",
  },
  {
    q: "What do I get back?",
    a: "Real files: an Excel sheet with working formulas, a Word document, a drafted email. They open in the apps you already use.",
  },
  {
    q: "Which computers does it run on?",
    a: "Mac, Windows and Linux. There's also a version in the browser to try it first.",
  },
];

function AccordionDemo() {
  return (
    <div className="accordion_demo_wrap">
      <h2 className="accordion_demo_title">
        Questions <span className="accordion_demo_title_grey">before you start</span>
      </h2>
      <div className="accordion_demo_content">
        <Accordion allowMultiple={false} duration={0.8} ease="expo.inOut" iconMode="both" iconRotation={-180}>
          {FAQ.map((item, i) => (
            <Accordion.Item
              key={item.q}
              defaultOpen={i === 0}
              duration={0.8}
              ease="expo.inOut"
              iconMode="both"
              iconRotation={-180}
              enableStagger={i < 3}
              staggerDuration={0.6}
              staggerDelay={0.15}
              staggerEase="expo.out"
              staggerYPercent={110}
              staggerStartDelay={200}
            >
              {({ toggle, contentRef, iconRef, verticalBarRef }: AccordionSlot) => (
                <>
                  <button type="button" onClick={toggle} className="accordion_trigger">
                    <span className="accordion_title">{item.q}</span>
                    <svg ref={iconRef} className="accordion_icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path ref={verticalBarRef} d="M8 1V15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      <path d="M1 8H15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                  <div ref={contentRef} className="accordion_content">
                    <p className="accordion_text">{item.a}</p>
                  </div>
                </>
              )}
            </Accordion.Item>
          ))}
        </Accordion>
      </div>
    </div>
  );
}
type AccordionSlot = {
  toggle: () => void;
  contentRef: React.Ref<HTMLDivElement>;
  iconRef: React.Ref<SVGSVGElement>;
  verticalBarRef: React.Ref<SVGPathElement>;
};

const STORY = [
  {
    title: "4:47 PM",
    text: "The bank export lands: <b>87 rows</b>, four date formats.",
    image: img("export-sq"),
    alt: "A bank export in a spreadsheet with mixed date formats and vendor names",
  },
  {
    title: "4:48 PM",
    text: "You ask for the Q3 expense report <b>in one sentence</b>.",
    image: img("prompt-sq"),
    alt: "The zWork message box with the export attached and the request typed",
  },
  {
    title: "4:50 PM",
    text: "zWork fixes the dates, merges vendors and <b>sorts every line</b>.",
    image: img("report-sq"),
    alt: "A checklist of what zWork did, with a Q3 total of $43,687.78",
  },
  {
    title: "4:52 PM",
    text: "A real Excel file, with <b>totals by category</b>.",
    image: img("sheet-sq"),
    alt: "The finished q3_expenses.xlsx with a bar chart by category",
  },
  {
    title: "4:53 PM",
    text: "It asks before emailing Priya, <b>and waits for you</b>.",
    image: img("ask-sq"),
    alt: "A prompt asking whether to send the report to Priya, with Deny and Allow",
  },
  {
    title: "Next Friday",
    text: "Set to repeat, it starts <b>at 4:00 PM on its own</b>.",
    image: img("schedule-sq"),
    alt: "A grid of Fridays, each marked sent to Priya",
  },
];

const RAIL = [
  {
    num: "01",
    title: "Drop in the file",
    text: "The export, the timesheet, last week's report: whatever you start from.",
    image: img("export-p"),
    alt: "A bank export with 87 rows",
  },
  {
    num: "02",
    title: "Say what you want",
    text: "In your own words, the way you'd ask a colleague.",
    image: img("prompt-p"),
    alt: "A request typed into zWork: turn this into the Q3 expense report",
  },
  {
    num: "03",
    title: "Check what it made",
    text: "A real spreadsheet or document, opened in the app you already use.",
    image: img("sheet-p"),
    alt: "The finished expense spreadsheet with totals by category",
  },
  {
    num: "04",
    title: "Let it repeat",
    text: "Pick a day and a time. zWork still asks before it sends.",
    image: img("schedule-p"),
    alt: "A schedule set for every Friday at 4:00 PM",
  },
];

const FLY = [
  { src: img("report-p"), alt: "Q3 expense report checklist", aspect: "portrait_lg" },
  { src: img("ask-p"), alt: "zWork asking before it sends", aspect: "portrait_md" },
  { src: img("friday-p"), alt: "Friday, 4:47 PM", aspect: "portrait_sm" },
  { src: img("sheet-p"), alt: "Expense spreadsheet", aspect: "portrait_lg", hideMobile: true },
  { src: img("sent-p"), alt: "Sent to Priya", aspect: "portrait_md" },
  { src: img("prompt-p"), alt: "A request typed into zWork", aspect: "portrait_sm", hideMobile: true },
  { src: img("schedule-p"), alt: "Every Friday, sent", aspect: "portrait_lg", hideMobile: true },
  { src: img("sheet"), alt: "Spreadsheet with a chart by category", aspect: "landscape_lg" },
  { src: img("export"), alt: "Messy bank export", aspect: "landscape_sm", hideMobile: true },
  { src: img("report-sq"), alt: "Q3 total, $43,687.78", aspect: "square_lg" },
  { src: img("toggle"), alt: "Repeat every Friday", aspect: "square_sm", hideMobile: true },
  { src: img("ask-sq"), alt: "Allow or deny", aspect: "square_sm" },
];

function EchoDemo() {
  return (
    <div className="eh_page">
      <EchoHeadline copies={8} depth={1} rotateX={20} rotateY={20} rotateZ={0} fade="opacity" trigger="scrub" scrub={0.5} hold={0.2} once={false}>
        Friday
      </EchoHeadline>
      <div className="eh_cover" />
    </div>
  );
}

function DividerDemo() {
  return (
    <section className="eldv_stage">
      <div className="eldv_container">
        <div className="eldv_block">
          <span className="eldv_label">
            <span className="eldv_idx">Every week</span> The same exports
          </span>
          <p className="eldv_text">Bank files, timesheets and sales numbers, rebuilt by hand.</p>
        </div>
        <ElasticDivider color="currentColor" />
        <div className="eldv_block">
          <span className="eldv_label">
            <span className="eldv_idx">With zWork</span> Done by four
          </span>
          <p className="eldv_text">The report is built, checked and waiting for your OK.</p>
        </div>
      </div>
    </section>
  );
}

function NavbarDemo() {
  const bodyRef = useRef<HTMLElement>(null);
  return (
    <div className="fnb_page">
      <FloatingNavbar
        threshold={80}
        duration={0.42}
        ease="annnimate"
        mode="toggle"
        offset={12}
        mark="z"
        wordmark="zWork"
        links={[
          { label: "Features", href: "#" },
          { label: "Pricing", href: "#" },
          { label: "Open source", href: "#" },
          { label: "Changelog", href: "#" },
        ]}
        ctaLabel="Download"
        ctaHref="#"
        hideStartRef={bodyRef}
      />
      <section className="fnb_hero">
        <img className="fnb_hero_img" src={img("friday")} alt="Friday, 4:47 PM: your weekly payroll" decoding="async" />
        <div className="fnb_hero_scrim" aria-hidden="true" />
        <h2 className="fnb_hero_title">
          <span className="fnb_hero_title_line">Your weekly paperwork,</span>{" "}
          <span className="fnb_hero_title_line fnb_hero_title_dim">done.</span>
        </h2>
      </section>
      <section ref={bodyRef} className="fnb_body" data-anm-fnb-hide-start>
        <p className="fnb_text">
          zWork does the reports, spreadsheets and emails you redo every week, <b>and asks before anything is sent</b>.
        </p>
        <figure className="fnb_media fnb_media_wide">
          <img className="fnb_media_img" src={img("sheet")} alt="The finished expense spreadsheet" decoding="async" />
        </figure>
        <figure className="fnb_media fnb_media_tall">
          <img className="fnb_media_img" src={img("ask-p")} alt="zWork asking before it sends the report" decoding="async" />
        </figure>
      </section>
    </div>
  );
}

function RotatingDemo() {
  return (
    <div className="rw_page">
      <div className="rw_track" data-anm-rw-track="">
        <section className="rw_stage">
          <RotatingWords
            words={["Expenses", "Invoices", "Timesheets", "Payroll", "Receipts", "Reports", "Sales sheets", "Status emails"]}
            scrub
            spin={2.4}
            settle={0.15}
            step={18}
            hold={0}
            snap={false}
            snapDelay={0.1}
            start="top 75%"
            once={false}
            nav
            blur={8}
          />
        </section>
      </div>
    </div>
  );
}

/* ---------- The list ---------- */

export const ENTRIES: Entry[] = [
  // Landing page
  {
    slug: "image-fly-in",
    name: "Image fly-in",
    group: "Landing page",
    does: "Pictures drift toward you out of the page around a short headline; scrolling speeds them up.",
    use: "The landing page hero. Every picture is a real moment from a Friday with zWork, so the first screen shows the product working instead of describing it.",
    Demo: () => (
      <ImageFlyIn
        images={FLY}
        headline="The rest of the week is yours."
        support="zWork does the reports, spreadsheets and emails you redo every week, on your own files."
      />
    ),
  },
  {
    slug: "dual-scramble",
    name: "Dual scramble",
    group: "Landing page",
    does: "A headline that scrambles into place when it scrolls in, and again from wherever you point at it.",
    use: "The closing line of the landing page, right above the download button. It rewards a hover without slowing down anyone reading.",
    Demo: () => <DualScramble />,
  },
  {
    slug: "text-reveal",
    name: "Text reveal",
    group: "Landing page",
    does: "A paragraph that fills in word by word as you scroll through it.",
    use: "The short statement under the hero. Revealing it at reading pace makes people read the one paragraph that explains what zWork is for.",
    fit: true,
    Demo: () => (
      <div style={{ maxWidth: 980, width: "100%" }}>
        <TextReveal type="words" start="top 75%" stagger={0.1}>
          Every Friday it's the same exports, the same spreadsheet and the same email. zWork does <strong>the part that repeats</strong>, on the
          files on your computer, and <strong>asks before anything leaves it</strong>.
        </TextReveal>
      </div>
    ),
  },
  {
    slug: "rotating-words",
    name: "Rotating words",
    group: "Landing page",
    does: "A wheel of words that turns as you scroll, settling on one at a time.",
    use: "The \"what can it do\" moment: each word is a kind of paperwork people already send us. It names the jobs faster than a feature grid.",
    Demo: RotatingDemo,
  },
  {
    slug: "echo-headline",
    name: "Echo headline",
    group: "Landing page",
    does: "One big word with copies trailing behind it in depth, pulled apart as you scroll.",
    use: "A single word between sections. \"Friday\" carries the whole story of the launch video: the day the same report comes due.",
    Demo: EchoDemo,
  },
  {
    slug: "diagonal-gallery",
    name: "Diagonal gallery",
    group: "Landing page",
    does: "A stack of pictures on a diagonal; each step brings the next one forward with its caption.",
    use: "One Friday afternoon, minute by minute. The time stamps make the point that the whole report takes six minutes.",
    fit: true,
    Demo: () => (
      <div className="demo-container">
        <DiagonalGallery step={110} duration={0.9} thumb={22} photos={STORY} />
      </div>
    ),
  },
  {
    slug: "process-rail",
    name: "Process rail",
    group: "Landing page",
    does: "Numbered steps on a rail, with a bead that travels down as you scroll.",
    use: "How it works, in four steps. It's a real sequence, so the numbers and the rail mean something.",
    Demo: () => <ProcessRail steps={RAIL} scrub={0.6} beadSize={10} sticky stagger={0.08} />,
  },
  {
    slug: "curtain-slider",
    name: "Curtain slider",
    group: "Landing page",
    does: "Full-width slides that change with a curtain of vertical strips; drag or wait.",
    use: "A walkthrough of one job from start to finish, for visitors who'd rather watch than read.",
    Demo: () => (
      <CurtainSlider
        images={[
          { src: img("export"), alt: "A messy bank export", title: "The export", label: "Friday, 4:47 PM" },
          { src: img("report"), alt: "Q3 expense report checklist", title: "The report", label: "87 rows sorted" },
          { src: img("ask"), alt: "zWork asking before it sends", title: "Asks first", label: "Before anything is sent" },
          { src: img("schedule"), alt: "A grid of Fridays, all sent", title: "Every Friday", label: "On a schedule" },
        ]}
      />
    ),
  },
  {
    slug: "stacking-cards",
    name: "Stacking cards",
    group: "Landing page",
    does: "Full-screen cards that pile onto each other as you scroll.",
    use: "The steps of a job, each one landing on the last, so the finished pile reads as the whole week's work.",
    Demo: () => (
      <StackingCards
        ariaLabel="One expense report, step by step"
        cards={[
          { label: "Read the export", src: img("export"), alt: "A messy bank export" },
          { label: "Build the sheet", src: img("sheet"), alt: "The finished expense spreadsheet" },
          { label: "Ask first", src: img("ask"), alt: "zWork asking before it sends" },
          { label: "Send it", src: img("sent"), alt: "Sent to Priya" },
          { label: "Every Friday", src: img("schedule"), alt: "A grid of Fridays, all sent" },
        ]}
      />
    ),
  },
  {
    slug: "scale-slider",
    name: "Scale slider",
    group: "Landing page",
    does: "A strip of cards that grow from small to large across the screen and drift on their own; drag to move it.",
    use: "A quiet strip of screens from the app under the features section. It shows breadth without asking anyone to click.",
    Demo: () => (
      <div style={{ width: "100%", height: "100svh", background: "rgb(var(--paper-raised))" }}>
        <ScaleSlider
          images={["report-p", "sheet-p", "ask-p", "sent-p", "schedule-p", "prompt-p", "export-p", "friday-p"].map(img)}
          radius={12}
        />
      </div>
    ),
  },
  {
    slug: "ascii-overlay",
    name: "ASCII overlay",
    group: "Landing page",
    does: "A picture redrawn in characters, which clear away to show the real image underneath.",
    use: "The open source section. The spreadsheet appears as text first, a nod to the code anyone can read, then resolves into the file zWork made.",
    Demo: () => (
      <div style={{ position: "relative", width: "100%", height: "min(900px, 100svh)" }}>
        <AsciiOverlay image={img("sheet")} />
      </div>
    ),
  },
  {
    slug: "magnetic-tag-cloud",
    name: "Magnetic tag cloud",
    group: "Landing page",
    does: "Tags that sit in rows and get knocked about by the pointer, then spring back.",
    use: "The kinds of paperwork zWork handles. Playing with it is a small reason to stay on the page long enough to find your own.",
    fit: true,
    Demo: () => (
      <MagneticTagCloud
        tags={[
          { label: "Expense reports", color: "ink" },
          { label: "Invoices", color: "outline" },
          { label: "Timesheets", color: "outline" },
          { label: "Payroll", color: "outline" },
          { label: "Receipts", color: "ink" },
          { label: "Client updates", color: "outline" },
          { label: "Meeting notes", color: "outline" },
          { label: "Sales sheets", color: "outline" },
          { label: "Bank exports", color: "outline" },
          { label: "Status emails", color: "ink" },
        ]}
      />
    ),
  },
  {
    slug: "elastic-divider",
    name: "Elastic divider",
    group: "Landing page",
    does: "A rule between sections that bends and wobbles when the pointer crosses it.",
    use: "Between the \"before\" and \"after\" halves of the landing page. It's the only playful line on an otherwise still page.",
    fit: true,
    Demo: DividerDemo,
  },
  // Navigation
  {
    slug: "floating-navbar",
    name: "Floating navbar",
    group: "Navigation",
    does: "A full-width top bar that folds into a small floating pill once you scroll, and back out at the top.",
    use: "The site's top bar. Features, Pricing, Open source and Changelog stay one click away without covering the page.",
    Demo: NavbarDemo,
  },
  {
    slug: "multi-level-drawer-menu",
    name: "Multi-level drawer menu",
    group: "Navigation",
    does: "A menu that opens in two panels: sections on the left, their pages on the right.",
    use: "The site's menu on phones, where the top bar can't fit everything. Plans and use cases get their own second level.",
    Demo: () => (
      <MultiLevelDrawerMenu
        panelBg="rgb(var(--paper-sunken))"
        logo="zWork"
        primaries={[
          { id: "product", label: "Product" },
          { id: "uses", label: "Use cases" },
          { id: "pricing", label: "Pricing" },
          { id: "help", label: "Help" },
        ]}
        sublists={{
          product: ["Features", "Schedules", "Connectors", "Changelog"],
          uses: ["Expense reports", "Invoices", "Timesheets", "Client updates"],
          pricing: ["Free", "Pro", "Max", "Compare plans"],
          help: ["Getting started", "Privacy", "Open source", "Contact"],
        }}
        secondaryLinks={[
          { label: "Sign in", href: SITE },
          { label: "Download", href: SITE },
        ]}
        cards={[
          { src: img("report-p"), alt: "Q3 expense report", label: "Expense reports" },
          { src: img("schedule-p"), alt: "Every Friday, sent", label: "Schedules" },
        ]}
        heroEyebrow="Your weekly paperwork"
        heroHeading="Done before the weekend."
        heroSub="Reports, spreadsheets and emails, on your own files."
        heroImage={img("sheet")}
      />
    ),
  },
  // Pricing and help
  {
    slug: "pricing",
    name: "Pricing",
    group: "Pricing and help",
    does: "Plan cards with a monthly and yearly switch; flipping it rolls every price to the new number.",
    use: "zWork's pricing page. Free, Pro and Max with the real prices, and yearly billing at ten months for twelve.",
    fit: true,
    Demo: () => (
      <Pricing
        title="Pick a plan"
        logoSrc="/favicon.svg"
        logoAlt="zWork"
        currency="$"
        savingsLabel="2 months free"
        plans={[
          {
            name: "Free",
            nameClass: "prc_name_silver",
            monthly: 0,
            yearly: 0,
            popular: false,
            features: ["Every tool, skill and connector", "Shared models or your own key", "Up to 3 schedules", "One task at a time"],
            ctaLabel: "Download free",
          },
          {
            name: "Pro",
            nameClass: "prc_name_champagne",
            monthly: 12,
            yearly: 120,
            popular: true,
            features: ["200 messages every 5 hours", "1,000 messages a week", "Up to 5 tasks at once", "Unlimited schedules", "Priority support"],
            ctaLabel: "Get Pro",
          },
          {
            name: "Max",
            nameClass: "prc_name_ice",
            monthly: 50,
            yearly: 500,
            popular: false,
            features: ["1,000 messages every 5 hours", "5,000 messages a week", "Up to 10 tasks at once", "Everything in Pro", "Dedicated support"],
            ctaLabel: "Get Max",
          },
        ]}
      />
    ),
  },
  {
    slug: "accordion",
    name: "Accordion",
    group: "Pricing and help",
    does: "Questions that open one at a time, with the answer's lines rising into place.",
    use: "The questions under the pricing table: the five things people ask before they pay.",
    fit: true,
    Demo: AccordionDemo,
  },
  {
    slug: "feature-dialog",
    name: "Feature dialog",
    group: "Pricing and help",
    does: "A tile that opens into a full sheet with pictures, numbers and a longer story.",
    use: "\"Asks before it sends\" on the features page. The tile says it in a line; the sheet shows the approval step and the numbers from a real run.",
    fit: true,
    Demo: () => (
      <FeatureDialog
        duration={0.7}
        ease="annnimate"
        label="Asks first"
        title="Nothing leaves without you"
        tileImage={{ src: img("ask-p"), alt: "zWork asking whether to send the report to Priya" }}
        sheetTitle="Asks before it sends"
        sheetText="When a job ends in an email or an upload, zWork stops and shows you what it's about to send and who it's for. Allow it, or deny it and nothing goes out."
        actionLabel="See a full run"
        mediaImages={[
          { src: img("report"), alt: "The finished Q3 expense report" },
          { src: img("sent"), alt: "Sent to Priya" },
        ]}
        stats={[
          { num: "87", label: "Rows read from the export" },
          { num: "$43,687.78", label: "Q3 total, line by line" },
          { num: "4:00 PM", label: "Every Friday, on schedule" },
        ]}
        sheetImage={{ src: img("schedule"), alt: "A grid of Fridays, each one sent" }}
        outro="The report goes out when you say so, and not a minute before."
      />
    ),
  },
  // In the app
  {
    slug: "split-flap-board",
    name: "Split-flap board",
    group: "In the app",
    does: "A departures board whose letters flip through the alphabet to the next line.",
    use: "Scheduled jobs in the app: what runs next and when. A board is how people already read \"what's leaving, and at what time\".",
    fit: true,
    Demo: () => (
      <SplitFlapBoard
        sets={[
          ["Expense report", "Every Friday", "16:00"],
          ["Invoice chase", "Mondays", "09:00"],
          ["Timesheets", "Every other Fri", "17:30"],
          ["Sales summary", "1st of month", "08:00"],
        ]}
      />
    ),
  },
  {
    slug: "hover-index",
    name: "Hover index",
    group: "In the app",
    does: "A list of names; pointing at one brings up its picture beside the pointer, and nearby names dim.",
    use: "The list of saved jobs. Pointing at a job shows the last thing it made, so you can find it by the result instead of the name.",
    fit: true,
    Demo: () => (
      <div className="demo-container">
        <HoverIndex
          label="Your jobs"
          range={2}
          dim={14}
          follow={9}
          projects={[
            { name: "Q3 expense report", image: img("report"), alt: "Q3 expense report" },
            { name: "Weekly sales sheet", image: img("sheet"), alt: "Expense spreadsheet with totals" },
            { name: "Invoice reminders", image: img("ask"), alt: "zWork asking before it sends" },
            { name: "Timesheet roll-up", image: img("schedule"), alt: "A grid of Fridays, all sent" },
            { name: "Client update email", image: img("sent"), alt: "Sent to Priya" },
            { name: "Receipts to Excel", image: img("export"), alt: "A bank export" },
            { name: "Monday status note", image: img("prompt"), alt: "A request typed into zWork" },
            { name: "Payroll check", image: img("friday"), alt: "Friday, 4:47 PM" },
          ]}
        />
      </div>
    ),
  },
];

export const bySlug = (slug: string) => ENTRIES.findIndex((e) => e.slug === slug);
