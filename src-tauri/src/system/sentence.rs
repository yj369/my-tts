pub fn split_text_to_sentences(input: &str, max_chars: usize) -> Vec<String> {
    split_text_to_sentences_with_pause(input, max_chars)
        .into_iter()
        .map(|(text, _)| text)
        .collect()
}

/// Split text into sentence chunks and assign a smart pause (in ms) to insert AFTER each chunk.
/// The last chunk's pause is always 0.
pub fn split_text_to_sentences_with_pause(input: &str, max_chars: usize) -> Vec<(String, u32)> {
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

    let mut chunks: Vec<(String, bool)> = Vec::new();
    let sentence_breaks = ['。', '！', '？', '!', '?', '；', ';'];
    let clause_breaks = ['，', ',', '、'];

    for line in lines {
        let mut rough: Vec<String> = Vec::new();
        let mut start = 0;
        for (i, c) in line.char_indices() {
            if sentence_breaks.contains(&c) {
                let end = i + c.len_utf8();
                let piece = line[start..end].trim();
                if !piece.is_empty() {
                    rough.push(piece.to_string());
                }
                start = end;
            }
        }
        if start < line.len() {
            let piece = line[start..].trim();
            if !piece.is_empty() {
                rough.push(piece.to_string());
            }
        }

        let mut line_chunks: Vec<String> = Vec::new();
        for sentence in rough {
            if sentence.chars().count() <= max_chars {
                line_chunks.push(sentence);
                continue;
            }
            let mut clauses: Vec<String> = Vec::new();
            let mut s = 0;
            for (i, c) in sentence.char_indices() {
                if clause_breaks.contains(&c) {
                    let end = i + c.len_utf8();
                    let p = sentence[s..end].trim();
                    if !p.is_empty() {
                        clauses.push(p.to_string());
                    }
                    s = end;
                }
            }
            if s < sentence.len() {
                let p = sentence[s..].trim();
                if !p.is_empty() {
                    clauses.push(p.to_string());
                }
            }
            if clauses.is_empty() {
                line_chunks.push(sentence);
                continue;
            }
            let mut current = String::new();
            for clause in clauses {
                let next = if current.is_empty() {
                    clause.clone()
                } else {
                    format!("{}{}", current, clause)
                };
                if next.chars().count() > max_chars && !current.is_empty() {
                    line_chunks.push(current);
                    current = clause;
                } else {
                    current = next;
                }
            }
            if !current.is_empty() {
                line_chunks.push(current);
            }
        }

        let total = line_chunks.len();
        for (idx, text) in line_chunks.into_iter().enumerate() {
            let is_para_end = idx + 1 == total;
            chunks.push((text, is_para_end));
        }
    }

    let total_chunks = chunks.len();
    chunks
        .into_iter()
        .enumerate()
        .map(|(i, (text, is_para_end))| {
            let is_last = i + 1 == total_chunks;
            let pause = compute_pause_ms(&text, is_para_end, is_last);
            (text, pause)
        })
        .collect()
}

pub fn compute_pause_ms(text: &str, is_paragraph_end: bool, is_last: bool) -> u32 {
    if is_last {
        return 0;
    }
    let trimmed = text.trim_end();
    let has_ellipsis = trimmed.ends_with("...") || trimmed.ends_with("…");
    let last = trimmed.chars().last();

    // 基础停顿：标点细分
    let mut base: f32 = if has_ellipsis {
        720.0
    } else {
        match last {
            Some('?') | Some('？') => 500.0, // 问号 — 留一拍等回应
            Some('.') | Some('。') => 420.0, // 句号 — 标准结束
            Some('!') | Some('！') => 360.0, // 感叹 — 情绪带过
            Some(';') | Some('；') => 320.0,
            Some(':') | Some('：') => 280.0,
            Some(',') | Some('，') | Some('、') => 180.0,
            _ => 220.0,
        }
    };

    // 长度系数：字符数 + 词数综合，CJK 字 ≈ 一拍，英文按词折算
    let char_count = trimmed.chars().count();
    let word_count = trimmed.split_whitespace().count().max(1);
    let weight = char_count.max(word_count * 4);

    let length_factor = if weight < 10 {
        0.65 // 非常短，snappy
    } else if weight < 20 {
        0.82
    } else if weight < 40 {
        1.0
    } else if weight < 70 {
        1.15
    } else if weight < 110 {
        1.3
    } else {
        1.45
    };
    base *= length_factor;

    if is_paragraph_end {
        base += 280.0;
    }

    base.round().clamp(120.0, 1500.0) as u32
}
