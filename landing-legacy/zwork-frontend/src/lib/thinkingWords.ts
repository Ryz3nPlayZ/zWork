/**
 * Whimsical -ing words that replace "Thinking" in the working indicator.
 * Shuffled on app boot so runs feel fresh; the UI cycles through them every
 * ~2s while the assistant is working.
 */
export const THINKING_WORDS: string[] = [
  "Accomplishing", "Actioning", "Actualizing", "Architecting",
  "Baking", "Beaming", "Beboppin'", "Befuddling", "Billowing",
  "Blanching", "Bloviating", "Boogieing", "Boondoggling", "Booping",
  "Bootstrapping", "Brewing", "Bunning", "Burrowing",
  "Calculating", "Canoodling", "Caramelizing", "Cascading",
  "Catapulting", "Cerebrating", "Channeling", "Channelling",
  "Choreographing", "Churning", "Clauding", "Coalescing", "Cogitating",
  "Combobulating", "Composing", "Computing", "Concocting",
  "Considering", "Contemplating", "Cooking", "Crafting", "Creating",
  "Crunching", "Crystallizing", "Cultivating",
  "Deciphering", "Deliberating", "Determining", "Dilly-dallying",
  "Discombobulating", "Doing", "Doodling", "Drizzling",
  "Ebbing", "Effecting", "Elucidating", "Embellishing", "Enchanting",
  "Envisioning", "Evaporating",
  "Fermenting", "Fiddle-faddling", "Finagling", "Flambéing",
  "Flibbertigibbeting", "Flowing", "Flummoxing", "Fluttering",
  "Forging", "Forming", "Frolicking", "Frosting",
  "Gallivanting", "Galloping", "Garnishing", "Generating",
  "Gesticulating", "Germinating", "Gitifying", "Grooving", "Gusting",
  "Harmonizing", "Hashing", "Hatching", "Herding", "Honking",
  "Hullaballooing", "Hyperspacing",
  "Ideating", "Imagining", "Improvising", "Incubating", "Inferring",
  "Infusing", "Ionizing",
  "Jitterbugging", "Julienning",
  "Kneading",
  "Leavening", "Levitating", "Lollygagging",
  "Manifesting", "Marinating", "Meandering", "Metamorphosing",
  "Misting", "Moonwalking", "Moseying", "Mulling", "Mustering",
  "Musing",
  "Nebulizing", "Nesting", "Newspapering", "Noodling", "Nucleating",
  "Orbiting", "Orchestrating", "Osmosing",
  "Perambulating", "Percolating", "Perusing", "Philosophising",
  "Photosynthesizing", "Pollinating", "Pondering", "Pontificating",
  "Pouncing", "Precipitating", "Prestidigitating", "Processing",
  "Proofing", "Propagating", "Puttering", "Puzzling",
  "Quantumizing",
  "Razzle-dazzling", "Razzmatazzing", "Recombobulating",
  "Reticulating", "Roosting", "Ruminating",
  "Sautéing", "Scampering", "Schlepping", "Scurrying", "Seasoning",
  "Shenaniganing", "Shimmying", "Simmering", "Skedaddling",
  "Sketching", "Slithering", "Smooshing", "Sock-hopping", "Spelunking",
  "Spinning", "Sprouting", "Stewing", "Sublimating", "Swirling",
  "Swooping", "Symbioting", "Synthesizing",
  "Tempering", "Thinking", "Thundering", "Tinkering", "Tomfoolering",
  "Topsy-turvying", "Transfiguring", "Transmuting", "Twisting",
  "Undulating", "Unfurling", "Unravelling",
  "Vibing",
  "Waddling", "Wandering", "Warping", "Whatchamacalliting",
  "Whirlpooling", "Whirring", "Whisking", "Wibbling", "Working",
  "Wrangling",
  "Zesting", "Zigzagging",
];

/** Fisher–Yates shuffle of a copy. */
export function shuffled<T>(arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
