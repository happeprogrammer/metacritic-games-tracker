/**
 * Pull the model's JSON answer out of text that may carry code fences or reasoning before it.
 * Tries the whole text, then every balanced {...} block, and returns the largest one that parses.
 */
export function extractJson(text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { const v = JSON.parse(raw); if (v && typeof v === 'object') return v; } catch { /* fall through */ }
  let best = null;
  let bestLen = 0;
  for (let i = raw.indexOf('{'); i !== -1; i = raw.indexOf('{', i + 1)) {
    const end = balancedEnd(raw, i);
    if (end === -1 || end - i + 1 <= bestLen) continue;
    try { best = JSON.parse(raw.slice(i, end + 1)); bestLen = end - i + 1; } catch { /* not JSON, keep looking */ }
  }
  return best;
}

function balancedEnd(s, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}
