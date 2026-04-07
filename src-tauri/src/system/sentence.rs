pub fn split_text_to_sentences(input: &str, max_chars: usize) -> Vec<String> {
    let normalized = input
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\u{2028}", "\n")
        .replace("\u{2029}", "\n")
        .replace("\u{00a0}", " ")
        .trim()
        .to_string();

    if normalized.is_empty() {
        return Vec::new();
    }

    let lines: Vec<&str> = normalized
        .split('\n')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    let mut rough = Vec::new();
    let sentence_breaks = ['。', '！', '？', '!', '?', '；', ';'];

    for line in lines {
        let mut start = 0;
        for (i, c) in line.char_indices() {
            if sentence_breaks.contains(&c) {
                let end = i + c.len_utf8();
                rough.push(line[start..end].trim());
                start = end;
            }
        }
        if start < line.len() {
            rough.push(line[start..].trim());
        }
    }

    let mut final_chunks = Vec::new();
    let clause_breaks = ['，', ',', '、'];

    for sentence in rough {
        if sentence.len() <= max_chars {
            final_chunks.push(sentence.to_string());
            continue;
        }

        let mut clauses = Vec::new();
        let mut start = 0;
        for (i, c) in sentence.char_indices() {
            if clause_breaks.contains(&c) {
                let end = i + c.len_utf8();
                clauses.push(sentence[start..end].trim());
                start = end;
            }
        }
        if start < sentence.len() {
            clauses.push(sentence[start..].trim());
        }

        if clauses.is_empty() {
            final_chunks.push(sentence.to_string());
            continue;
        }

        let mut current = String::new();
        for clause in clauses {
            let next = if current.is_empty() {
                clause.to_string()
            } else {
                format!("{}{}", current, clause)
            };

            if next.len() > max_chars && !current.is_empty() {
                final_chunks.push(current);
                current = clause.to_string();
            } else {
                current = next;
            }
        }
        if !current.is_empty() {
            final_chunks.push(current);
        }
    }

    final_chunks
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}
