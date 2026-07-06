/**
 * Named color schemes. Each scheme is a set of runtime token values that
 * override the `:root.light/.dark` Parchment fallback in index.css.
 *
 * A token is the string "R G B" (no commas), consumed by Tailwind as
 * `rgb(var(--token) / <alpha>)`. See tailwind.config.js.
 *
 * Palette values are sourced from each theme's official spec:
 *  - Catppuccin:   https://catppuccin.com/palette
 *  - Dracula:      https://spec.draculatheme.com
 *  - GitHub:       https://github.com/primer/github-vscode-theme
 *  - Atom One:     https://github.com/atom/one-light-ui / one-dark-ui
 *  - Tokyo Night:  https://github.com/folke/tokyonight.nvim
 *  - Gruvbox:      https://github.com/morhetz/gruvbox (material palette)
 *  - Nord:         https://www.nordtheme.org
 *  - Solarized:    https://ethanschoonover.com/solarized
 *  - Aura:         https://github.com/daltonmenezes/aura
 *  - Monokai:      classic TextMate Monokai
 */

export type RgbTriplet = string; // "R G B"

/** The tokens that fully define a theme variant. */
export interface TokenSet {
  paper: RgbTriplet;
  paperSoft: RgbTriplet;
  paperRaised: RgbTriplet;
  paperSunken: RgbTriplet;
  paperSidebar: RgbTriplet;
  ink: RgbTriplet;
  inkSoft: RgbTriplet;
  inkMuted: RgbTriplet;
  inkFaint: RgbTriplet;
  line: RgbTriplet;
  lineSoft: RgbTriplet;
  lineStrong: RgbTriplet;
  accent: RgbTriplet;
  shadow: RgbTriplet;
  success: RgbTriplet;
  successFg: RgbTriplet;
  warning: RgbTriplet;
  warningFg: RgbTriplet;
  error: RgbTriplet;
  errorFg: RgbTriplet;
  info: RgbTriplet;
  infoFg: RgbTriplet;
}

export interface ColorScheme {
  id: string;
  label: string;
  /** Optional group label for organizing the dropdown. */
  group?: string;
  /** light, dark, or both. When single-mode, the Appearance toggle locks. */
  variants: {
    light?: TokenSet;
    dark?: TokenSet;
  };
}

// ---------------------------------------------------------------------------
// Parchment — the zWork default, mirrors index.css :root.light/.dark.
// Surface hierarchy follows the OpenCode mirror rule: in light mode, raised
// surfaces step DARKER than base (toward the foreground), not lighter.
// ---------------------------------------------------------------------------
const PARCHMENT_LIGHT: TokenSet = {
  paper: "242 240 232",
  paperSoft: "238 236 228",
  paperRaised: "234 232 224",
  paperSunken: "246 244 236",
  paperSidebar: "236 234 226",
  ink: "48 46 40",
  inkSoft: "80 76 68",
  inkMuted: "110 106 96",
  inkFaint: "155 150 138",
  line: "218 214 202",
  lineSoft: "228 224 212",
  lineStrong: "200 196 184",
  accent: "48 46 40",
  shadow: "30 28 24",
  success: "16 185 129",
  successFg: "255 255 255",
  warning: "245 158 11",
  warningFg: "48 46 40",
  error: "239 68 68",
  errorFg: "255 255 255",
  info: "59 130 246",
  infoFg: "255 255 255",
};

const PARCHMENT_DARK: TokenSet = {
  paper: "22 22 24",
  paperSoft: "26 26 29",
  paperRaised: "31 31 34",
  paperSunken: "18 18 20",
  paperSidebar: "20 20 22",
  ink: "236 236 234",
  inkSoft: "213 213 211",
  inkMuted: "160 160 157",
  inkFaint: "108 108 106",
  line: "45 45 49",
  lineSoft: "40 40 44",
  lineStrong: "62 62 66",
  accent: "236 236 234",
  shadow: "0 0 0",
  success: "52 211 153",
  successFg: "0 0 0",
  warning: "251 191 36",
  warningFg: "0 0 0",
  error: "248 113 113",
  errorFg: "0 0 0",
  info: "96 165 250",
  infoFg: "0 0 0",
};

// ---------------------------------------------------------------------------
// Catppuccin — https://catppuccin.com/palette
// token map (dark): paper=base, paperSoft=surface0, paperRaised=tightened
// (kept close to base — the spec's surface1 #45475a was a +39pt jump that made
// the chatbox glare), paperSunken=mantle, paperSidebar=mantle, ink=text,
// inkSoft=subtext1, inkMuted=subtext0, inkFaint=overlay1, line=overlay0,
// lineSoft=surface0, lineStrong=surface2, shadow=crust, accent=mauve.
// ---------------------------------------------------------------------------
const CATPPUCCIN_MOCHA: TokenSet = {
  paper: "30 30 46", // base      #1e1e2e
  paperSoft: "40 42 62", // ~base+surface0 midpoint
  paperRaised: "49 50 68", // surface0   #313244 (was surface1 — too bright)
  paperSunken: "24 24 37", // mantle    #181825
  paperSidebar: "27 27 42", // base↔mantle midpoint
  ink: "205 214 244", // text       #cdd6f4
  inkSoft: "186 194 222", // subtext1   #bac2de
  inkMuted: "166 173 200", // subtext0   #a6adc8
  inkFaint: "150 153 166", // overlay1   #9399b2
  line: "108 112 134", // overlay0   #6c7086
  lineSoft: "49 50 68", // surface0
  lineStrong: "88 91 112", // surface2   #585b70
  accent: "203 166 247", // mauve      #cba6f7
  shadow: "17 17 27", // crust      #11111b
  success: "166 227 161", // green
  successFg: "17 17 27", // crust
  warning: "250 179 135", // peach
  warningFg: "17 17 27", // crust
  error: "243 139 168", // red
  errorFg: "17 17 27", // crust
  info: "137 180 250", // blue
  infoFg: "17 17 27", // crust
};

const CATPPUCCIN_MACCHIATO: TokenSet = {
  paper: "36 39 58", // base      #24273a
  paperSoft: "45 48 69", // tightened
  paperRaised: "54 58 79", // surface0   #363a4e (was surface1)
  paperSunken: "30 32 48", // mantle    #1e2030
  paperSidebar: "33 35 53",
  ink: "202 211 245", // text       #cad3f5
  inkSoft: "184 192 224", // subtext1   #b8c0e0
  inkMuted: "165 173 203", // subtext0   #a5adcb
  inkFaint: "147 153 178", // overlay1   #9399b2
  line: "110 115 141", // overlay0   #6e738d
  lineSoft: "54 58 79", // surface0
  lineStrong: "91 96 120", // surface2   #5b6078
  accent: "198 160 246", // mauve      #c6a0f6
  shadow: "24 25 38", // crust      #181926
  success: "166 218 149", // green
  successFg: "24 25 38", // crust
  warning: "245 169 127", // peach
  warningFg: "24 25 38", // crust
  error: "237 135 150", // red
  errorFg: "24 25 38", // crust
  info: "138 173 244", // blue
  infoFg: "24 25 38", // crust
};

const CATPPUCCIN_FRAPPE: TokenSet = {
  paper: "48 52 70", // base      #303446
  paperSoft: "57 61 80", // tightened
  paperRaised: "65 69 89", // surface0   #414559 (was surface1)
  paperSunken: "41 44 60", // mantle    #292c3c
  paperSidebar: "44 47 65",
  ink: "198 208 245", // text       #c6d0f5
  inkSoft: "181 191 226", // subtext1   #b5bfe2
  inkMuted: "165 172 201", // subtext0   #a5adce
  inkFaint: "148 153 187", // overlay1   #9499bb
  line: "115 121 153", // overlay0   #737994
  lineSoft: "65 69 89", // surface0
  lineStrong: "98 104 134", // surface2   #626880
  accent: "202 158 230", // mauve      #ca9ee6
  shadow: "35 38 52", // crust      #232634
  success: "166 209 137", // green
  successFg: "35 38 52", // crust
  warning: "239 159 118", // peach
  warningFg: "35 38 52", // crust
  error: "231 130 132", // red
  errorFg: "35 38 52", // crust
  info: "140 170 238", // blue
  infoFg: "35 38 52", // crust
};

const CATPPUCCIN_LATTE: TokenSet = {
  paper: "239 241 245", // base      #eff1f5
  paperSoft: "230 233 239", // surface0   #e6e9ef
  paperRaised: "220 224 232", // surface1   #dce0e8
  paperSunken: "246 248 250", // light step up (light mode → sunken lighter)
  paperSidebar: "230 233 239",
  ink: "76 79 105", // text       #4c4f69
  inkSoft: "92 95 119", // subtext1   #5c5f77
  inkMuted: "108 111 133", // subtext0   #6c6f85
  inkFaint: "140 143 161", // overlay1   #8c8fa1
  line: "156 160 176", // overlay0   #9ca0b0
  lineSoft: "230 233 239",
  lineStrong: "204 208 218",
  accent: "136 57 239", // mauve      #8839ef
  shadow: "172 176 190", // crust      #acb0be
  success: "64 160 43", // green
  successFg: "255 255 255",
  warning: "254 100 11", // peach
  warningFg: "255 255 255",
  error: "210 15 57", // red
  errorFg: "255 255 255",
  info: "30 102 245", // blue
  infoFg: "255 255 255",
};

// ---------------------------------------------------------------------------
// Dracula — https://spec.draculatheme.com
// ---------------------------------------------------------------------------
const DRACULA: TokenSet = {
  paper: "40 42 54", // background      #282a36
  paperSoft: "50 52 70", // tightened
  paperRaised: "60 62 80", // current line    #3c3f50 (was #44475a — too bright)
  paperSunken: "33 34 44", // bg darker       #21222c
  paperSidebar: "36 38 49",
  ink: "248 248 242", // foreground      #f8f8f2
  inkSoft: "230 219 173", // comment+        #e6dead (lighter than comment)
  inkMuted: "132 148 184", // comment+light   (was identical to inkFaint)
  inkFaint: "98 114 164", // comment         #6272a4
  line: "60 62 80",
  lineSoft: "68 71 90",
  lineStrong: "98 114 164",
  accent: "189 147 249", // purple          #bd93f9
  shadow: "20 21 28",
  success: "80 250 123", // green           #50fa7b
  successFg: "40 42 54", // background
  warning: "241 250 140", // yellow          #f1fa8c
  warningFg: "40 42 54", // background
  error: "255 85 85", // red             #ff5555
  errorFg: "255 255 255",
  info: "139 233 253", // cyan            #8be9fd
  infoFg: "40 42 54", // background
};

// ---------------------------------------------------------------------------
// GitHub (Primer) — https://github.com/primer/github-vscode-theme
// ---------------------------------------------------------------------------
const GITHUB_DARK: TokenSet = {
  paper: "13 17 23", // canvas.default   #0d1117
  paperSoft: "18 22 29", // tightened
  paperRaised: "22 27 34", // canvas.subtle    #161b22 (was canvas.inset — too bright)
  paperSunken: "6 8 12", // bg               #06080c (derived)
  paperSidebar: "18 22 29",
  ink: "201 209 217", // fg.default       #c9d1d9
  inkSoft: "139 148 158", // fg.muted        #8b949e
  inkMuted: "125 133 144", // between muted/subtle (was identical to inkSoft)
  inkFaint: "110 118 129", // fg.subtle       #6e7681
  line: "48 54 61", // border.default   #30363d
  lineSoft: "33 38 45",
  lineStrong: "72 81 91", // border.muted     #48515b (derived)
  accent: "88 166 255", // accent.blue      #58a6ff
  shadow: "1 4 9",
  success: "35 134 54", // success.emerald  #238636
  successFg: "255 255 255",
  warning: "219 171 18", // attention.yellow #dbab12
  warningFg: "13 17 23",
  error: "218 54 51", // danger.red       #da3633
  errorFg: "255 255 255",
  info: "88 166 255", // accent.blue
  infoFg: "13 17 23",
};

const GITHUB_LIGHT: TokenSet = {
  paper: "255 255 255", // canvas.default   #ffffff
  paperSoft: "246 248 250", // canvas.subtle    #f6f8fa
  paperRaised: "233 237 241", // tightened (was #d0d7de — too strong a step)
  paperSunken: "246 248 250",
  paperSidebar: "246 248 250",
  ink: "36 41 47", // fg.default       #24292f
  inkSoft: "87 96 106", // fg.muted        #57606a
  inkMuted: "100 109 117", // between muted/subtle (was identical to inkSoft)
  inkFaint: "110 118 129", // fg.subtle       #6e7681
  line: "208 215 222", // border.default   #d0d7de
  lineSoft: "233 237 241",
  lineStrong: "175 184 193", // border.muted     #afb8c1
  accent: "9 105 218", // accent.blue      #0969da
  shadow: "100 105 110",
  success: "35 134 54", // success.emerald  #238636
  successFg: "255 255 255",
  warning: "154 103 0", // attention.fg     #9a6700
  warningFg: "255 255 255",
  error: "207 34 46", // danger.fg        #cf222e
  errorFg: "255 255 255",
  info: "9 105 218", // accent.blue
  infoFg: "255 255 255",
};

// ---------------------------------------------------------------------------
// Atom One — https://github.com/atom/one-light-ui / one-dark-ui
// ---------------------------------------------------------------------------
const ONE_DARK: TokenSet = {
  paper: "40 44 52", // #282c34
  paperSoft: "45 49 58", // tightened
  paperRaised: "50 56 66", // #323842 (was #3e4550 — too bright, glared)
  paperSunken: "33 36 42", // #21242a (derived)
  paperSidebar: "35 38 45", // #23232d
  ink: "171 178 191", // #abb3bf
  inkSoft: "149 157 170", // derived
  inkMuted: "110 118 130", // split (was identical to inkFaint at #5c6470)
  inkFaint: "92 100 112", // #5c6470
  line: "56 62 72", // tightened (was same as paperRaised)
  lineSoft: "50 56 66",
  lineStrong: "92 100 112",
  accent: "97 175 254", // blue #61afef
  shadow: "20 22 27",
  success: "152 195 121", // green #98c379
  successFg: "40 44 52",
  warning: "229 192 123", // yellow #e5c07b
  warningFg: "40 44 52",
  error: "224 108 117", // red #e06c75
  errorFg: "255 255 255",
  info: "97 175 254", // blue
  infoFg: "40 44 52",
};

const ONE_LIGHT: TokenSet = {
  paper: "250 250 250", // #fafafa
  paperSoft: "244 245 245", // #f4f5f5 (derived)
  paperRaised: "234 235 237", // #eaeb (derived)
  paperSunken: "240 240 240",
  paperSidebar: "234 235 237", // #eaeaec
  ink: "56 58 66", // #383a42
  inkSoft: "92 97 102", // derived
  inkMuted: "110 115 122", // split (was too close to inkSoft)
  inkFaint: "155 160 165",
  line: "226 227 229", // #e2e3e5 (derived)
  lineSoft: "234 235 237",
  lineStrong: "200 202 206",
  accent: "64 120 242", // blue #4078f2
  shadow: "150 150 150",
  success: "80 161 79", // green #50a14f
  successFg: "255 255 255",
  warning: "193 132 1", // yellow #c18401
  warningFg: "255 255 255",
  error: "228 86 73", // red #e45649
  errorFg: "255 255 255",
  info: "64 120 242", // blue
  infoFg: "255 255 255",
};

// ---------------------------------------------------------------------------
// Tokyo Night — https://github.com/folke/tokyonight.nvim (night variant)
// ---------------------------------------------------------------------------
const TOKYO_NIGHT: TokenSet = {
  paper: "26 27 38", // bg            #1a1b26
  paperSoft: "31 33 46", // tightened
  paperRaised: "36 40 59", // bg_highlight #24283b
  paperSunken: "21 22 32", // bg_dark      #16161e
  paperSidebar: "23 25 35",
  ink: "192 202 245", // fg            #c0caf5
  inkSoft: "169 177 214", // derived
  inkMuted: "125 133 166", // #7d85a6
  inkFaint: "89 95 122", // #565f89
  line: "55 60 82", // #374052 (derived)
  lineSoft: "36 40 59",
  lineStrong: "89 95 122",
  accent: "122 162 247", // blue          #7aa2f7
  shadow: "14 15 22",
  success: "158 206 106", // green         #9ece6a
  successFg: "26 27 38",
  warning: "224 175 104", // yellow        #e0af68
  warningFg: "26 27 38",
  error: "247 118 142", // red           #f7768e
  errorFg: "26 27 38",
  info: "125 207 255", // cyan          #7dcfff
  infoFg: "26 27 38",
};

// ---------------------------------------------------------------------------
// Gruvbox (material) — https://github.com/morhetz/gruvbox
// ---------------------------------------------------------------------------
const GRUVBOX_DARK: TokenSet = {
  paper: "40 40 40", // bg0       #282828
  paperSoft: "50 46 44", // tightened
  paperRaised: "60 56 54", // bg1       #3c3836 (was bg2 — too bright)
  paperSunken: "29 32 33", // bg0_h     #1d2021
  paperSidebar: "34 31 30",
  ink: "235 219 178", // fg        #ebdbb2
  inkSoft: "214 197 142", // fg4-ish
  inkMuted: "168 153 132", // gray      #a89984
  inkFaint: "146 131 116",
  line: "60 56 54", // bg1
  lineSoft: "50 46 44",
  lineStrong: "102 92 84", // bg3-ish
  accent: "250 189 47", // yellow    #fabd2f
  shadow: "16 18 19",
  success: "184 187 38", // green     #b8bb26
  successFg: "29 32 33",
  warning: "250 189 47", // yellow    #fabd2f
  warningFg: "29 32 33",
  error: "251 73 52", // red       #fb4934
  errorFg: "29 32 33",
  info: "131 165 152", // aqua      #83a598
  infoFg: "29 32 33",
};

const GRUVBOX_LIGHT: TokenSet = {
  paper: "250 241 199", // bg0       #fbf1c7
  paperSoft: "242 229 188", // bg1       #f2e5bc
  paperRaised: "230 215 166", // bg2       #e6d6a6 (derived)
  paperSunken: "254 247 217", // bg0_s     #fef7d9 (derived, lighter than bg0)
  paperSidebar: "237 224 183", // bg0 soft-ish
  ink: "60 56 54", // fg        #3c3836
  inkSoft: "80 73 69", // fg-ish
  inkMuted: "124 111 100", // gray      #7c6f64
  inkFaint: "146 131 116",
  line: "205 188 143", // derived
  lineSoft: "221 206 166",
  lineStrong: "168 153 132",
  accent: "177 98 27", // orange    #b16226
  shadow: "120 110 95",
  success: "121 116 14", // green     #79740e
  successFg: "250 241 199",
  warning: "181 118 20", // yellow    #b57614
  warningFg: "250 241 199",
  error: "157 0 6", // red       #9d0006
  errorFg: "250 241 199",
  info: "7 102 120", // aqua      #076678
  infoFg: "250 241 199",
};

// ---------------------------------------------------------------------------
// Nord — https://www.nordtheme.org
// ---------------------------------------------------------------------------
const NORD: TokenSet = {
  paper: "46 52 64", // polar.night.0  #2e3440
  paperSoft: "52 59 73", // tightened
  paperRaised: "59 66 82", // polar.night.1  #3b4252 (was polar.night.2)
  paperSunken: "38 43 55", // derived darker
  paperSidebar: "42 47 59",
  ink: "236 239 244", // snow.storm.3   #eceff4
  inkSoft: "216 222 233", // snow.storm.2   #d8dee9
  inkMuted: "193 200 217", // split (was identical to inkSoft)
  inkFaint: "171 178 191", // derived
  line: "76 86 106", // polar.night.3  #4c566a
  lineSoft: "59 66 82",
  lineStrong: "76 86 106",
  accent: "136 192 208", // frost.3        #88c0d0
  shadow: "28 32 42",
  success: "163 190 140", // aurora.green   #a3be8c
  successFg: "46 52 64",
  warning: "235 203 139", // aurora.yellow  #ebcb8b
  warningFg: "46 52 64",
  error: "191 97 106", // aurora.red     #bf616a
  errorFg: "236 239 244",
  info: "129 161 193", // frost.2        #81a1c1
  infoFg: "46 52 64",
};

// ---------------------------------------------------------------------------
// Solarized — https://ethanschoonover.com/solarized
// ---------------------------------------------------------------------------
const SOLARIZED_DARK: TokenSet = {
  paper: "0 43 54", // base03   #002b36
  paperSoft: "7 54 66", // base02   #073642
  paperRaised: "20 67 86", // derived
  paperSunken: "0 36 46",
  paperSidebar: "7 54 66",
  ink: "147 161 161", // base1    #93a1a1 (body text on dark)
  inkSoft: "131 148 150", // base00   #839496 (secondary)
  inkMuted: "119 137 137", // split (was identical to inkSoft)
  inkFaint: "101 123 131", // base01   #657b83
  line: "7 54 66", // base02
  lineSoft: "20 67 86",
  lineStrong: "40 84 96",
  accent: "38 139 210", // blue     #268bd2
  shadow: "0 28 38",
  success: "133 153 0", // green    #859900
  successFg: "0 43 54",
  warning: "181 137 0", // yellow   #b58900
  warningFg: "0 43 54",
  error: "220 50 47", // red      #dc322f
  errorFg: "0 43 54",
  info: "38 139 210", // blue     #268bd2
  infoFg: "0 43 54",
};

const SOLARIZED_LIGHT: TokenSet = {
  paper: "253 246 227", // base3    #fdf6e3
  paperSoft: "238 232 213", // base2    #eee8d5
  paperRaised: "224 218 198", // derived
  paperSunken: "247 240 221",
  paperSidebar: "238 232 213",
  ink: "101 123 131", // base01   #657b83 (body text on light)
  inkSoft: "88 110 117", // base00   #586e75
  inkMuted: "131 148 150", // base1    #93a1a1
  inkFaint: "147 161 161",
  line: "238 232 213", // base2
  lineSoft: "224 218 198",
  lineStrong: "200 194 174",
  accent: "38 139 210", // blue     #268bd2
  shadow: "160 150 120",
  success: "133 153 0", // green    #859900
  successFg: "253 246 227",
  warning: "181 137 0", // yellow   #b58900
  warningFg: "253 246 227",
  error: "220 50 47", // red      #dc322f
  errorFg: "253 246 227",
  info: "38 139 210", // blue     #268bd2
  infoFg: "253 246 227",
};

// ---------------------------------------------------------------------------
// Aura — https://github.com/daltonmenezes/aura (dark variant)
// ---------------------------------------------------------------------------
const AURA: TokenSet = {
  paper: "21 19 46", // #15132e
  paperSoft: "24 21 51", // tightened
  paperRaised: "27 24 56", // #1b1838 (was #26244b — too bright)
  paperSunken: "17 15 38",
  paperSidebar: "19 17 42",
  ink: "225 220 255", // #e1dcff (derived, text)
  inkSoft: "186 179 235",
  inkMuted: "160 152 219", // split (was identical to inkFaint)
  inkFaint: "138 130 203", // #8a82cb
  line: "44 39 88", // #2c2758 (derived)
  lineSoft: "27 24 56",
  lineStrong: "69 62 138",
  accent: "164 116 255", // #a474ff (aura accent)
  shadow: "12 10 28",
  success: "97 255 202", // #61ffca
  successFg: "21 19 46",
  warning: "255 202 133", // #ffca85
  warningFg: "21 19 46",
  error: "255 103 103", // #ff6767
  errorFg: "21 19 46",
  info: "164 116 255", // accent
  infoFg: "21 19 46",
};

// ---------------------------------------------------------------------------
// Monokai — classic TextMate Monokai
// ---------------------------------------------------------------------------
const MONOKAI: TokenSet = {
  paper: "39 40 34", // background  #272822
  paperSoft: "48 50 41", // tightened
  paperRaised: "57 59 49", // line-ish    #393b31 (was #494c40 — too bright)
  paperSunken: "30 31 26",
  paperSidebar: "34 35 30",
  ink: "248 248 242", // foreground  #f8f8f2
  inkSoft: "213 213 197",
  inkMuted: "150 146 117", // split (was identical to inkFaint)
  inkFaint: "117 113 94", // #75715e
  line: "57 59 49",
  lineSoft: "73 76 64",
  lineStrong: "117 113 94",
  accent: "166 226 46", // green       #a6e22e
  shadow: "20 21 18",
  success: "166 226 46", // green       #a6e22e
  successFg: "39 40 34",
  warning: "253 151 31", // orange      #fd971f
  warningFg: "39 40 34",
  error: "249 38 114", // red         #f92672
  errorFg: "255 255 255",
  info: "102 217 239", // cyan        #66d9ef
  infoFg: "39 40 34",
};

// ---------------------------------------------------------------------------
// Exported scheme registry.
// ---------------------------------------------------------------------------
export const COLOR_SCHEMES: ColorScheme[] = [
  {
    id: "parchment",
    label: "Parchment",
    group: "zWork",
    variants: { light: PARCHMENT_LIGHT, dark: PARCHMENT_DARK },
  },
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    group: "Catppuccin",
    variants: { light: CATPPUCCIN_LATTE },
  },
  {
    id: "catppuccin-frappe",
    label: "Catppuccin Frappé",
    group: "Catppuccin",
    variants: { dark: CATPPUCCIN_FRAPPE },
  },
  {
    id: "catppuccin-macchiato",
    label: "Catppuccin Macchiato",
    group: "Catppuccin",
    variants: { dark: CATPPUCCIN_MACCHIATO },
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    group: "Catppuccin",
    variants: { dark: CATPPUCCIN_MOCHA },
  },
  { id: "dracula", label: "Dracula", group: "Classic", variants: { dark: DRACULA } },
  {
    id: "github",
    label: "GitHub",
    group: "Editor",
    variants: { light: GITHUB_LIGHT, dark: GITHUB_DARK },
  },
  {
    id: "atom-one",
    label: "Atom One",
    group: "Editor",
    variants: { light: ONE_LIGHT, dark: ONE_DARK },
  },
  { id: "tokyo-night", label: "Tokyo Night", group: "Editor", variants: { dark: TOKYO_NIGHT } },
  { id: "gruvbox", label: "Gruvbox", group: "Classic", variants: { light: GRUVBOX_LIGHT, dark: GRUVBOX_DARK } },
  { id: "nord", label: "Nord", group: "Classic", variants: { dark: NORD } },
  { id: "solarized", label: "Solarized", group: "Classic", variants: { light: SOLARIZED_LIGHT, dark: SOLARIZED_DARK } },
  { id: "aura", label: "Aura", group: "Classic", variants: { dark: AURA } },
  { id: "monokai", label: "Monokai", group: "Classic", variants: { dark: MONOKAI } },
];

export const DEFAULT_SCHEME_ID = "parchment";
