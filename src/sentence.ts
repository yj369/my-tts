const LINE_SPLIT_RE = /\n+/;
const SENTENCE_BREAK_RE = /(?<=[。！？!?；;])/;
const CLAUSE_BREAK_RE = /(?<=[，,、])/;

export type SentenceChunk = { text: string; pauseAfterMs: number };

const normalizeWhitespace = (input: string) =>
  input
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/\u00a0/g, " ");

const splitLongSentence = (value: string, maxChars: number) => {
  if (value.length <= maxChars) {
    return [value];
  }

  const clauses = value
    .split(CLAUSE_BREAK_RE)
    .map((item) => item.trim())
    .filter(Boolean);

  if (clauses.length <= 1) {
    return [value];
  }

  const chunks: string[] = [];
  let current = "";

  for (const clause of clauses) {
    const next = current ? `${current}${clause}` : clause;
    if (next.length > maxChars && current) {
      chunks.push(current);
      current = clause;
      continue;
    }
    current = next;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
};

export const computePauseMs = (
  text: string,
  isParagraphEnd: boolean,
  isLast: boolean
) => {
  if (isLast) return 0;
  const trimmed = text.replace(/\s+$/, "");
  const hasEllipsis = trimmed.endsWith("...") || trimmed.endsWith("…");
  const last = trimmed.slice(-1);

  let base: number;
  if (hasEllipsis) base = 720;
  else if ("?？".includes(last)) base = 500;
  else if (".。".includes(last)) base = 420;
  else if ("!！".includes(last)) base = 360;
  else if (";；".includes(last)) base = 320;
  else if (":：".includes(last)) base = 280;
  else if (",，、".includes(last)) base = 180;
  else base = 220;

  const charCount = [...trimmed].length;
  const wordCount = Math.max(1, trimmed.split(/\s+/).filter(Boolean).length);
  const weight = Math.max(charCount, wordCount * 4);

  let factor: number;
  if (weight < 10) factor = 0.65;
  else if (weight < 20) factor = 0.82;
  else if (weight < 40) factor = 1.0;
  else if (weight < 70) factor = 1.15;
  else if (weight < 110) factor = 1.3;
  else factor = 1.45;
  base *= factor;

  if (isParagraphEnd) base += 280;

  return Math.min(1500, Math.max(120, Math.round(base)));
};

export const splitTextToSentenceChunks = (
  input: string,
  maxChars = 120
): SentenceChunk[] => {
  const normalized = normalizeWhitespace(input).trim();
  if (!normalized) return [];

  const lines = normalized
    .split(LINE_SPLIT_RE)
    .map((item) => item.trim())
    .filter(Boolean);

  const collected: { text: string; isParagraphEnd: boolean }[] = [];

  for (const line of lines) {
    const rough = line
      .split(SENTENCE_BREAK_RE)
      .map((item) => item.trim())
      .filter(Boolean);
    const chunks = rough.flatMap((sentence) => splitLongSentence(sentence, maxChars));
    chunks.forEach((text, idx) => {
      collected.push({ text, isParagraphEnd: idx === chunks.length - 1 });
    });
  }

  return collected.map((entry, i) => ({
    text: entry.text,
    pauseAfterMs: computePauseMs(entry.text, entry.isParagraphEnd, i === collected.length - 1),
  }));
};

export const splitTextToSentences = (input: string, maxChars = 120) =>
  splitTextToSentenceChunks(input, maxChars).map((c) => c.text);
