// Parse a duration string like "1h30m", "2d 4h", "45s", "1w" into seconds.
// Units: w (week), d (day), h (hour), m (minute), s (second). Whitespace between
// parts is allowed. Returns null for anything that doesn't parse (including "").
const UNITS = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };

function parseDuration(str) {
  const re = /(\d+)([wdhms])/g;
  let total = 0;
  let matched = '';
  let m;
  while ((m = re.exec(str)) !== null) {
    total += parseInt(m[1]) * UNITS[m[2]];
    matched += m[0];
  }
  if (matched.length === 0) return null;
  return total;
}

// Format seconds as the shortest canonical string, largest units first,
// e.g. 5400 -> "1h30m", 0 -> "0s". Negative input throws RangeError.
function formatDuration(sec) {
  if (sec < 0) throw new RangeError('negative');
  if (sec === 0) return '0s';
  let out = '';
  for (const [u, n] of Object.entries(UNITS)) {
    const q = Math.floor(sec / n);
    if (q > 0) { out += q + u; sec -= q * n; }
  }
  return out;
}

module.exports = { parseDuration, formatDuration };
