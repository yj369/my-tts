use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

fn default_segment_status() -> String {
    "queued".to_string()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Segment {
    pub index: usize,
    pub text: String,
    #[serde(default)]
    pub filename: String,
    pub path: String,
    pub url: String,
    pub size: usize,
    #[serde(default = "default_segment_status")]
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct HistoryRecord {
    pub id: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub text: String,
    #[serde(rename = "sentenceCount")]
    pub sentence_count: usize,
    #[serde(rename = "processedCount")]
    pub processed_count: usize,
    pub status: String,
    pub error: Option<String>,
    #[serde(rename = "jobDir")]
    pub job_dir: Option<String>,
    #[serde(rename = "mergedPath")]
    pub merged_path: Option<String>,
    #[serde(rename = "mergedUrl")]
    pub merged_url: Option<String>,
    #[serde(rename = "emoWeight")]
    pub emo_weight: Option<f32>,
    #[serde(rename = "promptPath", default)]
    pub prompt_path: Option<String>,
    #[serde(rename = "emotionPath", default)]
    pub emotion_path: Option<String>,
    pub segments: Vec<Segment>,
}

pub fn read_history(db_path: &Path) -> Vec<HistoryRecord> {
    if !db_path.exists() {
        return Vec::new();
    }
    match fs::read_to_string(db_path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or(Vec::new()),
        Err(_) => Vec::new(),
    }
}

pub fn save_history(db_path: &Path, records: &[HistoryRecord]) {
    if let Some(parent) = db_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(data) = serde_json::to_string_pretty(records) {
        let _ = fs::write(db_path, data);
    }
}

pub fn delete_record(db_path: &Path, id: &str) -> Option<HistoryRecord> {
    let mut records = read_history(db_path);
    let removed = records
        .iter()
        .position(|r| r.id == id)
        .map(|pos| records.remove(pos));
    save_history(db_path, &records);
    removed
}

pub fn update_record(db_path: &Path, id: &str, new_record: HistoryRecord) {
    let mut records = read_history(db_path);
    if let Some(pos) = records.iter().position(|r| r.id == id) {
        records[pos] = new_record;
    } else {
        records.insert(0, new_record); // Insert new at top
    }
    save_history(db_path, &records);
}
