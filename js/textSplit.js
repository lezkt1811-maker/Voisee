// Splits arbitrarily long text into paragraphs and safe sentence-sized chunks
// for TTS generation. Never sends more than MAX_CHUNK_LEN characters to the
// model in one call, since transformers.js tokenizers silently truncate
// (truncation: true) rather than erroring on overly long input.

const MAX_CHUNK_LEN = 400;

let segmenter = null;
if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
  try {
    segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  } catch (err) {
    segmenter = null;
  }
}

export function splitIntoParagraphs(text) {
  const norm = text.replace(/\r\n?/g, '\n');
  const blocks = norm
    .split(/\n[ \t]*\n+/)
    .map((b) => b.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (blocks.length > 1) return blocks;

  // No blank-line paragraph breaks found (common with some pasted sources).
  // Fall back to treating each non-empty line as its own paragraph.
  const lines = norm
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return lines.length > 1 ? lines : [norm.replace(/\s+/g, ' ').trim()].filter(Boolean);
}

// Intl.Segmenter (and the regex fallback) follow the generic Unicode sentence
// boundary algorithm, which has no knowledge of English abbreviations and
// will happily split "Dr. Smith" into two "sentences". Protect common
// abbreviations by hiding their period behind a placeholder before
// splitting, then restore it in each resulting piece.
const ABBREVIATIONS = [
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'sgt', 'col',
  'gen', 'rep', 'sen', 'gov', 'lt', 'maj', 'capt', 'mt', 'co', 'inc', 'ltd',
  'dept', 'approx', 'apt', 'no', 'vol', 'jan', 'feb', 'mar', 'apr', 'jun',
  'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
];
const ABBR_REGEX = new RegExp(`\\b(${ABBREVIATIONS.join('|')})\\.`, 'gi');
const PLACEHOLDER = '\u0000';

function protectAbbreviations(text) {
  return text.replace(ABBR_REGEX, (m) => m.slice(0, -1) + PLACEHOLDER);
}

function restorePlaceholder(text) {
  return text.split(PLACEHOLDER).join('.');
}

function splitSentencesRegex(paragraph) {
  const matches = paragraph.match(/[^.!?]+[.!?]+(?:["')\]]+)?(?:\s+|$)|[^.!?]+$/g);
  if (!matches) return [restorePlaceholder(paragraph).trim()].filter(Boolean);
  return matches.map((s) => restorePlaceholder(s).trim()).filter(Boolean);
}

function splitSentences(rawParagraph) {
  const paragraph = protectAbbreviations(rawParagraph);
  if (segmenter) {
    const out = [];
    for (const { segment } of segmenter.segment(paragraph)) {
      const s = restorePlaceholder(segment).trim();
      if (s) out.push(s);
    }
    if (out.length) return out;
  }
  return splitSentencesRegex(paragraph);
}

// Hard-splits a sentence that has no usable punctuation and exceeds the safe
// chunk length (e.g. a huge run-on line) at the nearest word boundary.
function hardSplitLong(str) {
  const parts = [];
  let s = str.trim();
  while (s.length > MAX_CHUNK_LEN) {
    let cut = s.lastIndexOf(' ', MAX_CHUNK_LEN);
    if (cut <= 20) cut = MAX_CHUNK_LEN; // no good space found; hard cut
    parts.push(s.slice(0, cut).trim());
    s = s.slice(cut).trim();
  }
  if (s) parts.push(s);
  return parts;
}

// Returns { paragraphs: string[], sentences: {text, paraIndex}[] }
export function buildSentences(text) {
  const paragraphs = splitIntoParagraphs(text);
  const sentences = [];
  paragraphs.forEach((para, paraIndex) => {
    const raws = splitSentences(para);
    for (const raw of raws) {
      if (raw.length > MAX_CHUNK_LEN) {
        for (const part of hardSplitLong(raw)) {
          sentences.push({ text: part, paraIndex });
        }
      } else {
        sentences.push({ text: raw, paraIndex });
      }
    }
  });
  return { paragraphs, sentences };
}

export { MAX_CHUNK_LEN };
