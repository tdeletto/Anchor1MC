/**
 * Deterministic post-processing applied to every transcript, before and
 * independently of any AI enhancement: dictionary replacements, capitalization
 * and spacing cleanup.
 */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Apply user replacements. Non-regex rules match on word boundaries. */
export function applyReplacements(text, replacements = []) {
  let out = text;
  for (const rule of replacements) {
    const from = (rule?.from ?? '').trim();
    if (!from) continue;
    const to = rule.to ?? '';
    const flags = rule.matchCase ? 'g' : 'gi';
    try {
      const re = rule.regex
        ? new RegExp(from, flags)
        // \b does not fire next to punctuation-only phrases, so only use it
        // when the phrase starts and ends with a word character.
        : new RegExp(
            `${/^\w/.test(from) ? '\\b' : ''}${escapeRe(from)}${/\w$/.test(from) ? '\\b' : ''}`,
            flags,
          );
      out = out.replace(re, to);
    } catch {
      // A malformed user regex should never break a dictation.
    }
  }
  return out;
}

/** Capitalize the first letter of each sentence, and a standalone "i". */
export function autoCapitalize(text) {
  let out = text.replace(/(^|[.!?]\s+|\n\s*)([a-z])/g, (m, lead, ch) => lead + ch.toUpperCase());
  out = out.replace(/\bi\b/g, 'I');
  return out;
}

/** Add a terminal period when the text plainly ends mid-sentence. */
export function autoPunctuate(text) {
  const trimmed = text.trimEnd();
  if (!trimmed) return trimmed;
  return /[.!?:;,\-–—)\]"'’”]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function tidyWhitespace(text) {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Full deterministic pipeline.
 * @param {string} text
 * @param {import('./defaults.js').DEFAULTS['dictionary']} dict
 */
export function postProcess(text, dict) {
  if (!text) return '';
  let out = applyReplacements(text, dict.replacements);
  if (dict.trimWhitespace) out = tidyWhitespace(out);
  if (dict.autoCapitalize) out = autoCapitalize(out);
  if (dict.autoPunctuate) out = autoPunctuate(out);
  return out;
}

/** Strip wrapper text a small model may add despite instructions. */
export function unwrapModelOutput(text) {
  let out = (text ?? '').trim();
  // Reasoning models sometimes emit a <think> block first.
  out = out.replace(/^<think>[\s\S]*?<\/think>\s*/i, '').trim();
  // Leading "Here is the cleaned-up text:" style preambles, which may sit in
  // front of a code fence, so strip them first.
  out = out.replace(/^(here(?:'s| is)[^:\n]{0,60}:)\s*/i, '').trim();
  // A whole-output code fence.
  const fence = out.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fence) out = fence[1].trim();
  // Matched wrapping quotes the user did not dictate.
  if (/^"[^"]*"$/.test(out) || /^'[^']*'$/.test(out)) out = out.slice(1, -1);
  return out.trim();
}
