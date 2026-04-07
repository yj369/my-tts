const LINE_SPLIT_RE = /\n+/;
const SENTENCE_BREAK_RE = /(?<=[。！？!?；;])/;
const CLAUSE_BREAK_RE = /(?<=[，,、])/;

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

export const splitTextToSentences = (input: string, maxChars = 120) => {
  const normalized = normalizeWhitespace(input).trim();
  if (!normalized) {
    return [];
  }

  const lines = normalized
    .split(LINE_SPLIT_RE)
    .map((item) => item.trim())
    .filter(Boolean);

  const rough = lines.flatMap((line) =>
    line
      .split(SENTENCE_BREAK_RE)
      .map((item) => item.trim())
      .filter(Boolean)
  );

  const chunks = rough.flatMap((sentence) => splitLongSentence(sentence, maxChars));
  return chunks.map((item) => item.trim()).filter(Boolean);
};
