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

/**
 * Collapse pathological repetition.
 *
 * Speech models can fall into a decoding loop and emit the same word or phrase
 * hundreds of times — "The The The The…" — which is unmistakable to a reader
 * and ruinous when pasted into a document. Natural speech does repeat, so the
 * threshold is set where a person plausibly stops: three consecutive
 * repetitions are kept, and a run longer than that is treated as a loop and
 * reduced to one.
 *
 * Phrases as well as single words, since loops are not always one token wide.
 *
 * @param {string} text
 * @param {number} [maxRun] consecutive repeats tolerated before collapsing
 * @returns {{text: string, collapsed: number}} how many runs were collapsed
 */
export function collapseRepetition(text, maxRun = 3) {
  if (!text) return { text: '', collapsed: 0 };
  const words = text.split(/(\s+)/);          // keeps the separators
  const tokens = words.filter((_, i) => i % 2 === 0);
  const gaps = words.filter((_, i) => i % 2 === 1);
  let collapsed = 0;

  // Longest phrases first, so a four-word loop is not first mangled as four
  // one-word ones.
  for (let size = 4; size >= 1; size -= 1) {
    for (let i = 0; i + size <= tokens.length;) {
      const phrase = tokens.slice(i, i + size).join(' ').toLowerCase();
      if (!phrase.trim()) { i += 1; continue; }

      let runs = 1;
      while (i + size * (runs + 1) <= tokens.length
        && tokens.slice(i + size * runs, i + size * (runs + 1)).join(' ').toLowerCase() === phrase) {
        runs += 1;
      }

      if (runs > maxRun) {
        tokens.splice(i + size, size * (runs - 1));
        gaps.splice(i + size, size * (runs - 1));
        collapsed += 1;
        i += size;
      } else {
        i += 1;
      }
    }
  }

  const out = tokens.reduce((acc, token, i) => acc + token + (gaps[i] ?? ''), '');
  return { text: out.trim(), collapsed };
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
  // Before anything else: a loop that reached this far would otherwise have
  // every later step applied to hundreds of copies of one word.
  const { text: deduped } = collapseRepetition(text);
  let out = applyReplacements(deduped, dict.replacements);
  if (dict.trimWhitespace) out = tidyWhitespace(out);
  if (dict.autoCapitalize) out = autoCapitalize(out);
  if (dict.autoPunctuate) out = autoPunctuate(out);
  return out;
}

const words = (text) => (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);

/**
 * Decide whether an enhancement is fit to insert.
 *
 * A small model can degenerate — repeating one word to the token limit, or
 * emitting text with no relation to what was said. Inserting that into
 * someone's document is far worse than inserting the raw transcript, and the
 * failure is obvious enough to detect: a rewrite should reuse the speaker's
 * words, and should not be much longer than what it rewrites.
 *
 * Generative modes are exempt from the overlap and length tests, since
 * answering a question or summarizing legitimately produces new words.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function assessEnhancement(input, output, { generative = false } = {}) {
  const out = (output ?? '').trim();
  if (!out) return { ok: false, reason: 'the model returned nothing' };

  const outWords = words(out);
  if (!outWords.length) return { ok: false, reason: 'the model returned no words' };

  // Repetition, whatever the mode: nothing legitimate collapses this far.
  const collapsed = words(collapseRepetition(out).text);
  if (collapsed.length < outWords.length * 0.7) {
    return { ok: false, reason: 'the model repeated itself' };
  }

  if (generative) return { ok: true };

  const inWords = words(input ?? '');
  if (inWords.length < 4) return { ok: true }; // too short to judge

  if (outWords.length > inWords.length * 3 + 15) {
    return { ok: false, reason: 'the model produced far more text than was dictated' };
  }

  // A rewrite should be built from the speaker's own words. Measured over
  // distinct words so a repeated one cannot carry the score.
  const spoken = new Set(inWords);
  const distinct = [...new Set(outWords)];
  const shared = distinct.filter((w) => spoken.has(w)).length;
  if (shared / distinct.length < 0.4) {
    return { ok: false, reason: 'the model produced text unrelated to what was dictated' };
  }

  return { ok: true };
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
  // The delimiters we wrap the prompt in. A small model will happily echo
  // </transcript> at the end of an otherwise perfect answer, and asking it not
  // to is not a guarantee — so they are removed here rather than trusted away.
  out = out.replace(/<\/?(transcript|context)>/gi, '').trim();
  // Matched wrapping quotes the user did not dictate.
  if (/^"[^"]*"$/.test(out) || /^'[^']*'$/.test(out)) out = out.slice(1, -1);
  // Removing a tag can leave the blank line it sat on behind it.
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
