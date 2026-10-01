// remark-math treats `$…$` as inline TeX, so prose about money
// ("spent $43.20 … and $51.38") renders as a garbled formula. A `$` that
// directly precedes a digit is a price, not math: escape it so it stays text.
// Code spans and fences are left alone; `$x^2$` and `$$…$$` still render.
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;

export function protectCurrency(md: string): string {
  return md
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/(^|[^\\$])\$(?=\d)/g, "$1\\$")))
    .join("");
}
