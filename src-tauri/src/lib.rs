mod ffmpeg;
mod gradio;
mod system;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use system::fs::{
    delete_record, read_history, save_history, update_record, HistoryRecord, Segment,
};
use system::sentence::split_text_to_sentences_with_pause;
use tauri::{AppHandle, Manager};

static DELETED_RECORD_IDS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn deleted_record_ids() -> &'static Mutex<HashSet<String>> {
    DELETED_RECORD_IDS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn mark_record_deleted(id: &str) {
    if let Ok(mut ids) = deleted_record_ids().lock() {
        ids.insert(id.to_string());
    }
}

fn clear_record_deleted(id: &str) {
    if let Ok(mut ids) = deleted_record_ids().lock() {
        ids.remove(id);
    }
}

fn is_record_deleted(id: &str) -> bool {
    deleted_record_ids()
        .lock()
        .map(|ids| ids.contains(id))
        .unwrap_or(false)
}

fn update_record_if_active(db_path: &Path, id: &str, record: HistoryRecord) -> bool {
    if is_record_deleted(id) {
        return false;
    }
    update_record(db_path, id, record);
    true
}

fn app_storage_root(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let root = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?
        .join("tts-workflow");
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create app storage dir: {}", e))?;
    Ok(root)
}

fn history_db_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_storage_root(app_handle)?.join("history.json"))
}

fn jobs_root(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let path = app_storage_root(app_handle)?.join("jobs");
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create jobs dir: {}", e))?;
    Ok(path)
}

fn tmp_root(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let path = app_storage_root(app_handle)?.join("tmp");
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create temp dir: {}", e))?;
    Ok(path)
}

fn legacy_storage_root() -> PathBuf {
    PathBuf::from("./.tts_data")
}

fn legacy_history_db_path() -> PathBuf {
    legacy_storage_root().join("history.json")
}

fn infer_job_dir(record: &HistoryRecord) -> Option<PathBuf> {
    if let Some(job_dir) = record.job_dir.as_ref() {
        return Some(PathBuf::from(job_dir));
    }
    if let Some(merged_path) = record.merged_path.as_ref() {
        return Path::new(merged_path).parent().map(Path::to_path_buf);
    }
    record
        .segments
        .iter()
        .find(|segment| !segment.path.is_empty())
        .and_then(|segment| Path::new(&segment.path).parent().map(Path::to_path_buf))
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("Failed to create {}: {}", dst.display(), e))?;
    for entry in
        fs::read_dir(src).map_err(|e| format!("Failed to read {}: {}", src.display(), e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to read file type for {}: {}", src_path.display(), e))?;
        if file_type.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path).map_err(|e| {
                format!(
                    "Failed to copy {} to {}: {}",
                    src_path.display(),
                    dst_path.display(),
                    e
                )
            })?;
        }
    }
    Ok(())
}

fn canonical_path_string(path: impl AsRef<Path>) -> String {
    path.as_ref()
        .canonicalize()
        .unwrap_or_else(|_| path.as_ref().to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn segment_filename(index: usize) -> String {
    format!("segment_{:03}.wav", index)
}

fn segment_output_path(job_dir: &Path, index: usize) -> PathBuf {
    job_dir.join(segment_filename(index))
}

fn retry_file_op<F>(mut op: F) -> std::io::Result<()>
where
    F: FnMut() -> std::io::Result<()>,
{
    let mut last_error = None;
    for attempt in 0..5 {
        match op() {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                if attempt < 4 {
                    thread::sleep(Duration::from_millis(40 * (attempt + 1) as u64));
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| std::io::Error::other("file operation failed")))
}

fn remove_file_if_exists(path: &Path) -> std::io::Result<()> {
    retry_file_op(|| match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    })
}

fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    if source == destination {
        return Ok(());
    }
    remove_file_if_exists(destination)?;
    retry_file_op(|| fs::rename(source, destination)).or_else(|rename_error| {
        fs::copy(source, destination)
            .and_then(|_| remove_file_if_exists(source))
            .map(|_| ())
            .map_err(|copy_error| {
                std::io::Error::other(format!(
                    "rename failed: {}; copy fallback failed: {}",
                    rename_error, copy_error
                ))
            })
    })
}

fn build_segments(sentences: &[(String, u32)]) -> Vec<Segment> {
    sentences
        .iter()
        .enumerate()
        .map(|(idx, (text, pause_after_ms))| Segment {
            index: idx + 1,
            text: text.clone(),
            filename: segment_filename(idx + 1),
            path: String::new(),
            url: String::new(),
            size: 0,
            status: "queued".to_string(),
            error: None,
            pause_after_ms: *pause_after_ms,
        })
        .collect()
}

fn count_success_segments(record: &HistoryRecord) -> usize {
    record
        .segments
        .iter()
        .filter(|segment| segment.status == "success")
        .count()
}

fn failed_segment_summary(record: &HistoryRecord) -> Option<String> {
    let failed_indexes = record
        .segments
        .iter()
        .filter(|segment| segment.status == "failed")
        .map(|segment| segment.index.to_string())
        .collect::<Vec<_>>();

    if failed_indexes.is_empty() {
        None
    } else if failed_indexes.len() == 1 {
        Some(format!("第 {} 句生成失败，可单独重试。", failed_indexes[0]))
    } else {
        Some(format!(
            "第 {} 句生成失败，可单独重试。",
            failed_indexes.join("、")
        ))
    }
}

fn set_segment_processing(record: &mut HistoryRecord, segment_index: usize) -> Result<(), String> {
    let segment = record
        .segments
        .iter_mut()
        .find(|segment| segment.index == segment_index)
        .ok_or_else(|| format!("Segment {} not found", segment_index))?;
    segment.status = "processing".to_string();
    segment.error = None;
    record.status = "processing".to_string();
    record.error = None;
    Ok(())
}

fn set_segment_success(
    record: &mut HistoryRecord,
    segment_index: usize,
    absolute_path: String,
) -> Result<(), String> {
    let size = fs::metadata(&absolute_path)
        .map(|metadata| metadata.len() as usize)
        .unwrap_or(0);
    let segment = record
        .segments
        .iter_mut()
        .find(|segment| segment.index == segment_index)
        .ok_or_else(|| format!("Segment {} not found", segment_index))?;
    segment.filename = segment_filename(segment_index);
    segment.path = absolute_path.clone();
    segment.url = absolute_path;
    segment.size = size;
    segment.status = "success".to_string();
    segment.error = None;
    record.processed_count = count_success_segments(record);
    Ok(())
}

fn set_segment_failure(
    record: &mut HistoryRecord,
    segment_index: usize,
    error: String,
) -> Result<(), String> {
    let segment = record
        .segments
        .iter_mut()
        .find(|segment| segment.index == segment_index)
        .ok_or_else(|| format!("Segment {} not found", segment_index))?;
    segment.status = "failed".to_string();
    segment.error = Some(error);
    record.processed_count = count_success_segments(record);
    Ok(())
}

fn sync_record_text(record: &mut HistoryRecord) {
    record.text = record
        .segments
        .iter()
        .map(|segment| segment.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    record.sentence_count = record.segments.len();
    record.processed_count = count_success_segments(record);
}

fn invalidate_merged_artifacts(record: &mut HistoryRecord, job_dir: &Path) {
    if let Some(merged_path) = record.merged_path.take() {
        let merged_path_buf = PathBuf::from(&merged_path);
        if merged_path_buf.exists() {
            let _ = remove_file_if_exists(&merged_path_buf);
        }
    }
    record.merged_url = None;

    let concat_list = job_dir.join("concat_list.txt");
    if concat_list.exists() {
        let _ = remove_file_if_exists(&concat_list);
    }
}

fn queue_segment_for_regeneration(
    record: &mut HistoryRecord,
    job_dir: &Path,
    segment_index: usize,
) -> Result<(), String> {
    let segment_position = record
        .segments
        .iter()
        .position(|segment| segment.index == segment_index)
        .ok_or_else(|| format!("Segment {} not found", segment_index))?;

    let old_path = record.segments[segment_position].path.clone();
    if !old_path.is_empty() {
        let old_path_buf = PathBuf::from(&old_path);
        if old_path_buf.exists() {
            let _ = remove_file_if_exists(&old_path_buf);
        }
    }

    {
        let segment = &mut record.segments[segment_position];
        segment.filename = segment_filename(segment_index);
        segment.path.clear();
        segment.url.clear();
        segment.size = 0;
        segment.status = "queued".to_string();
        segment.error = None;
    }

    invalidate_merged_artifacts(record, job_dir);
    sync_record_text(record);
    finalize_record(record, job_dir);
    Ok(())
}

fn renumber_segments_and_files(record: &mut HistoryRecord, job_dir: &Path) -> Result<(), String> {
    for (idx, segment) in record.segments.iter_mut().enumerate() {
        let next_index = idx + 1;
        segment.index = next_index;
        let next_filename = segment_filename(next_index);

        if segment.path.is_empty() {
            segment.filename = next_filename;
            continue;
        }

        let current_path = PathBuf::from(&segment.path);
        let next_path = job_dir.join(&next_filename);
        segment.filename = next_filename;

        if current_path == next_path {
            continue;
        }

        if current_path.exists() {
            let temp_path = job_dir.join(format!(
                ".renumber-{}-{}",
                next_index,
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            replace_file(&current_path, &temp_path).map_err(|error| {
                format!(
                    "Failed to stage segment file {}: {}",
                    current_path.display(),
                    error
                )
            })?;
            replace_file(&temp_path, &next_path).map_err(|error| {
                format!(
                    "Failed to renumber segment file to {}: {}",
                    next_path.display(),
                    error
                )
            })?;
        }

        let absolute = canonical_path_string(&next_path);
        segment.path = absolute.clone();
        segment.url = absolute;
    }

    Ok(())
}

fn move_generated_file(output_path: &str, dest_path: &Path) -> Result<String, String> {
    replace_file(Path::new(output_path), dest_path).map_err(|error| {
        format!(
            "Failed to move generated file into {}: {}",
            dest_path.display(),
            error
        )
    })?;

    Ok(canonical_path_string(dest_path))
}

fn merge_record_segments(record: &mut HistoryRecord, job_dir: &Path) -> Result<(), String> {
    let mut ordered_segments = record.segments.clone();
    ordered_segments.sort_by_key(|segment| segment.index);

    let segment_inputs: Vec<(String, u32)> = ordered_segments
        .iter()
        .filter(|segment| segment.status == "success" && !segment.path.is_empty())
        .map(|segment| (segment.path.clone(), segment.pause_after_ms))
        .collect();

    if segment_inputs.len() != record.segments.len() {
        return Err("还有句子未成功生成，暂时无法合并。".to_string());
    }

    let merged_path = job_dir.join("merged.wav");
    ffmpeg::merge_audio_with_pauses(&segment_inputs, merged_path.to_string_lossy().as_ref())
        .map_err(|e| format!("Merge Error: {}", e))?;

    let absolute_merged_path = canonical_path_string(&merged_path);
    record.status = "success".to_string();
    record.error = None;
    record.merged_path = Some(absolute_merged_path.clone());
    record.merged_url = Some(absolute_merged_path);
    Ok(())
}

fn finalize_record(record: &mut HistoryRecord, job_dir: &Path) {
    record.processed_count = count_success_segments(record);

    if record
        .segments
        .iter()
        .any(|segment| segment.status == "processing")
    {
        record.status = "processing".to_string();
        record.error = None;
        return;
    }

    if let Some(summary) = failed_segment_summary(record) {
        record.status = "failed".to_string();
        record.error = Some(summary);
        record.merged_path = None;
        record.merged_url = None;
        return;
    }

    if record
        .segments
        .iter()
        .all(|segment| segment.status == "success")
        && !record.segments.is_empty()
    {
        if let Err(error) = merge_record_segments(record, job_dir) {
            record.status = "failed".to_string();
            record.error = Some(error);
            record.merged_path = None;
            record.merged_url = None;
        }
        return;
    }

    record.status = "queued".to_string();
    record.error = None;
    record.merged_path = None;
    record.merged_url = None;
}

fn remap_record_to_job_dir(mut record: HistoryRecord, job_dir: &Path) -> HistoryRecord {
    let absolute_job_dir = canonical_path_string(job_dir);
    record.job_dir = Some(absolute_job_dir.clone());

    for segment in &mut record.segments {
        let file_name = if !segment.filename.is_empty() {
            segment.filename.clone()
        } else if let Some(file_name) = Path::new(&segment.path)
            .file_name()
            .and_then(|value| value.to_str())
        {
            file_name.to_string()
        } else {
            segment_filename(segment.index)
        };

        let remapped_path = job_dir.join(&file_name);
        if remapped_path.exists() {
            let absolute = canonical_path_string(&remapped_path);
            segment.filename = file_name;
            segment.path = absolute.clone();
            segment.url = absolute;
        }
    }

    if let Some(merged_path) = record.merged_path.clone() {
        if let Some(file_name) = Path::new(&merged_path).file_name() {
            let remapped_path = job_dir.join(file_name);
            if remapped_path.exists() {
                let absolute = canonical_path_string(&remapped_path);
                record.merged_path = Some(absolute.clone());
                record.merged_url = Some(absolute);
            }
        }
    }

    record
}

fn migrate_legacy_storage(app_handle: &AppHandle, db_path: &Path) -> Result<(), String> {
    let legacy_db_path = legacy_history_db_path();
    if !legacy_db_path.exists() {
        return Ok(());
    }

    let mut records = read_history(db_path);
    let mut known_ids = records
        .iter()
        .map(|record| record.id.clone())
        .collect::<HashSet<_>>();
    let legacy_records = read_history(&legacy_db_path);
    if legacy_records.is_empty() {
        return Ok(());
    }

    let jobs_dir = jobs_root(app_handle)?;
    let mut migrated_any = false;

    for legacy_record in legacy_records {
        if known_ids.contains(&legacy_record.id) {
            continue;
        }

        let target_job_dir = jobs_dir.join(&legacy_record.id);
        if let Some(source_job_dir) = infer_job_dir(&legacy_record) {
            if source_job_dir.exists()
                && source_job_dir != target_job_dir
                && !target_job_dir.exists()
            {
                copy_dir_all(&source_job_dir, &target_job_dir)?;
            }
        }

        let migrated_record = if target_job_dir.exists() {
            remap_record_to_job_dir(legacy_record, &target_job_dir)
        } else {
            legacy_record
        };

        known_ids.insert(migrated_record.id.clone());
        records.push(migrated_record);
        migrated_any = true;
    }

    if migrated_any {
        records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        save_history(db_path, &records);
    }

    Ok(())
}

fn load_record(db_path: &Path, id: &str) -> Result<HistoryRecord, String> {
    read_history(db_path)
        .into_iter()
        .find(|record| record.id == id)
        .ok_or_else(|| format!("Record not found: {}", id))
}

#[tauri::command]
fn get_history(app_handle: AppHandle) -> Vec<HistoryRecord> {
    match history_db_path(&app_handle) {
        Ok(db_path) => {
            let _ = migrate_legacy_storage(&app_handle, &db_path);
            read_history(&db_path)
        }
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
async fn generate_tts(
    app_handle: AppHandle,
    text: String,
    prompt_path: String,
    emotion_path: String,
    emo_weight: f32,
) -> Result<String, String> {
    let db_path = history_db_path(&app_handle)?;
    migrate_legacy_storage(&app_handle, &db_path)?;

    let sentences = split_text_to_sentences_with_pause(&text, 120);
    if sentences.is_empty() {
        return Err("没有可生成的句子。".to_string());
    }

    let job_dir = jobs_root(&app_handle)?.join(format!(
        "job-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    let id = job_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("job-unknown")
        .to_string();

    let mut record = HistoryRecord {
        id: id.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        text: text.clone(),
        sentence_count: sentences.len(),
        processed_count: 0,
        status: "processing".into(),
        error: None,
        job_dir: Some(job_dir.to_string_lossy().into_owned()),
        merged_path: None,
        merged_url: None,
        emo_weight: Some(emo_weight),
        prompt_path: Some(prompt_path.clone()),
        emotion_path: Some(emotion_path.clone()),
        segments: build_segments(&sentences),
    };
    clear_record_deleted(&id);
    update_record(&db_path, &id, record.clone());

    let id_clone = id.clone();
    let db_path_clone = db_path.clone();
    let job_dir_clone = job_dir.clone();

    tokio::spawn(async move {
        if let Err(error) = fs::create_dir_all(&job_dir_clone) {
            record.status = "failed".into();
            record.error = Some(format!("Failed to create job directory: {}", error));
            update_record_if_active(&db_path_clone, &id_clone, record);
            return;
        }

        if let Err(error) = gradio::ensure_server_ready().await {
            record.status = "failed".into();
            record.error = Some(error);
            update_record_if_active(&db_path_clone, &id_clone, record);
            return;
        }

        for segment_index in 1..=sentences.len() {
            if is_record_deleted(&id_clone) {
                return;
            }
            if let Err(error) = set_segment_processing(&mut record, segment_index) {
                record.status = "failed".into();
                record.error = Some(error);
                update_record_if_active(&db_path_clone, &id_clone, record);
                return;
            }
            if !update_record_if_active(&db_path_clone, &id_clone, record.clone()) {
                return;
            }

            let segment_text = record
                .segments
                .iter()
                .find(|segment| segment.index == segment_index)
                .map(|segment| segment.text.clone())
                .unwrap_or_default();

            match gradio::generate_single(&segment_text, &prompt_path, &emotion_path, emo_weight)
                .await
            {
                Ok(output_path) => {
                    if is_record_deleted(&id_clone) {
                        let _ = remove_file_if_exists(Path::new(&output_path));
                        return;
                    }
                    let dest_path = segment_output_path(&job_dir_clone, segment_index);
                    match move_generated_file(&output_path, &dest_path) {
                        Ok(absolute_dest_path) => {
                            if let Err(error) =
                                set_segment_success(&mut record, segment_index, absolute_dest_path)
                            {
                                record.status = "failed".into();
                                record.error = Some(error);
                                update_record_if_active(&db_path_clone, &id_clone, record);
                                return;
                            }
                        }
                        Err(error) => {
                            let _ = set_segment_failure(&mut record, segment_index, error);
                        }
                    }
                }
                Err(error) => {
                    let _ = set_segment_failure(
                        &mut record,
                        segment_index,
                        format!("Gradio Error on segment {}: {}", segment_index, error),
                    );
                }
            }

            finalize_record(&mut record, &job_dir_clone);
            if !update_record_if_active(&db_path_clone, &id_clone, record.clone()) {
                return;
            }
        }
    });

    Ok(id)
}

#[tauri::command]
async fn retry_segment(app_handle: AppHandle, id: String, index: usize) -> Result<(), String> {
    let db_path = history_db_path(&app_handle)?;
    migrate_legacy_storage(&app_handle, &db_path)?;

    let mut record = load_record(&db_path, &id)?;
    let prompt_path = record
        .prompt_path
        .clone()
        .ok_or_else(|| "缺少原始音色参考路径，无法重试该句。".to_string())?;
    let emotion_path = record
        .emotion_path
        .clone()
        .ok_or_else(|| "缺少原始情绪参考路径，无法重试该句。".to_string())?;
    let emo_weight = record.emo_weight.unwrap_or(1.0);
    let job_dir = infer_job_dir(&record)
        .or_else(|| record.job_dir.as_ref().map(PathBuf::from))
        .ok_or_else(|| "无法定位该任务的音频目录。".to_string())?;

    if record.status == "processing" {
        return Err("当前任务还在生成中，稍后再重试这一句。".to_string());
    }

    let segment_text = record
        .segments
        .iter()
        .find(|segment| segment.index == index)
        .map(|segment| segment.text.clone())
        .ok_or_else(|| format!("Segment {} not found", index))?;

    if !Path::new(&prompt_path).exists() {
        return Err(format!("音色参考文件不存在: {}", prompt_path));
    }
    if !Path::new(&emotion_path).exists() {
        return Err(format!("情绪参考文件不存在: {}", emotion_path));
    }

    fs::create_dir_all(&job_dir).map_err(|e| {
        format!(
            "Failed to create job directory {}: {}",
            job_dir.display(),
            e
        )
    })?;

    set_segment_processing(&mut record, index)?;
    if !update_record_if_active(&db_path, &id, record.clone()) {
        return Err("该任务已被删除。".to_string());
    }

    let id_clone = id.clone();
    let db_path_clone = db_path.clone();
    let job_dir_clone = job_dir.clone();

    tokio::spawn(async move {
        let mut retry_record = match load_record(&db_path_clone, &id_clone) {
            Ok(record) => record,
            Err(_) => return,
        };

        if let Err(error) = gradio::ensure_server_ready().await {
            let _ = set_segment_failure(&mut retry_record, index, error);
            finalize_record(&mut retry_record, &job_dir_clone);
            update_record_if_active(&db_path_clone, &id_clone, retry_record);
            return;
        }

        match gradio::generate_single(&segment_text, &prompt_path, &emotion_path, emo_weight).await
        {
            Ok(output_path) => {
                if is_record_deleted(&id_clone) {
                    let _ = remove_file_if_exists(Path::new(&output_path));
                    return;
                }
                let dest_path = segment_output_path(&job_dir_clone, index);
                match move_generated_file(&output_path, &dest_path) {
                    Ok(absolute_dest_path) => {
                        let _ = set_segment_success(&mut retry_record, index, absolute_dest_path);
                    }
                    Err(error) => {
                        let _ = set_segment_failure(&mut retry_record, index, error);
                    }
                }
            }
            Err(error) => {
                let _ = set_segment_failure(
                    &mut retry_record,
                    index,
                    format!("Gradio Error on segment {}: {}", index, error),
                );
            }
        }

        finalize_record(&mut retry_record, &job_dir_clone);
        update_record_if_active(&db_path_clone, &id_clone, retry_record);
    });

    Ok(())
}

#[tauri::command]
async fn regenerate_queued_segments(app_handle: AppHandle, id: String) -> Result<(), String> {
    let db_path = history_db_path(&app_handle)?;
    migrate_legacy_storage(&app_handle, &db_path)?;

    let mut record = load_record(&db_path, &id)?;
    if record.status == "processing" {
        return Err("当前任务还在生成中。".to_string());
    }

    let queued_segments = record
        .segments
        .iter()
        .filter(|segment| segment.status == "queued")
        .map(|segment| (segment.index, segment.text.clone()))
        .collect::<Vec<_>>();

    if queued_segments.is_empty() {
        return Err("当前任务没有待生成的句子。".to_string());
    }

    let prompt_path = record
        .prompt_path
        .clone()
        .ok_or_else(|| "缺少原始音色参考路径，无法补生成。".to_string())?;
    let emotion_path = record
        .emotion_path
        .clone()
        .ok_or_else(|| "缺少原始情绪参考路径，无法补生成。".to_string())?;
    let emo_weight = record.emo_weight.unwrap_or(1.0);
    let job_dir = infer_job_dir(&record)
        .or_else(|| record.job_dir.as_ref().map(PathBuf::from))
        .ok_or_else(|| "无法定位该任务的音频目录。".to_string())?;

    if !Path::new(&prompt_path).exists() {
        return Err(format!("音色参考文件不存在: {}", prompt_path));
    }
    if !Path::new(&emotion_path).exists() {
        return Err(format!("情绪参考文件不存在: {}", emotion_path));
    }

    fs::create_dir_all(&job_dir).map_err(|e| {
        format!(
            "Failed to create job directory {}: {}",
            job_dir.display(),
            e
        )
    })?;

    for (index, _) in &queued_segments {
        set_segment_processing(&mut record, *index)?;
    }
    if !update_record_if_active(&db_path, &id, record.clone()) {
        return Err("该任务已被删除。".to_string());
    }

    let id_clone = id.clone();
    let db_path_clone = db_path.clone();
    let job_dir_clone = job_dir.clone();

    tokio::spawn(async move {
        let mut regen_record = match load_record(&db_path_clone, &id_clone) {
            Ok(record) => record,
            Err(_) => return,
        };

        if let Err(error) = gradio::ensure_server_ready().await {
            for (index, _) in &queued_segments {
                let _ = set_segment_failure(&mut regen_record, *index, error.clone());
            }
            finalize_record(&mut regen_record, &job_dir_clone);
            update_record_if_active(&db_path_clone, &id_clone, regen_record);
            return;
        }

        for (index, segment_text) in queued_segments {
            if is_record_deleted(&id_clone) {
                return;
            }
            match gradio::generate_single(&segment_text, &prompt_path, &emotion_path, emo_weight)
                .await
            {
                Ok(output_path) => {
                    if is_record_deleted(&id_clone) {
                        let _ = remove_file_if_exists(Path::new(&output_path));
                        return;
                    }
                    let dest_path = segment_output_path(&job_dir_clone, index);
                    match move_generated_file(&output_path, &dest_path) {
                        Ok(absolute_dest_path) => {
                            let _ =
                                set_segment_success(&mut regen_record, index, absolute_dest_path);
                        }
                        Err(error) => {
                            let _ = set_segment_failure(&mut regen_record, index, error);
                        }
                    }
                }
                Err(error) => {
                    let _ = set_segment_failure(
                        &mut regen_record,
                        index,
                        format!("Gradio Error on segment {}: {}", index, error),
                    );
                }
            }

            finalize_record(&mut regen_record, &job_dir_clone);
            if !update_record_if_active(&db_path_clone, &id_clone, regen_record.clone()) {
                return;
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn delete_segment(app_handle: AppHandle, id: String, index: usize) -> Result<(), String> {
    let db_path = history_db_path(&app_handle)?;
    migrate_legacy_storage(&app_handle, &db_path)?;

    let mut record = load_record(&db_path, &id)?;
    if record.status == "processing" {
        return Err("当前任务还在生成中，暂时不能删除句子。".to_string());
    }
    if record.segments.len() <= 1 {
        return Err("至少保留一句。若不需要该任务，请删除整条历史记录。".to_string());
    }

    let job_dir = infer_job_dir(&record)
        .or_else(|| record.job_dir.as_ref().map(PathBuf::from))
        .ok_or_else(|| "无法定位该任务的音频目录。".to_string())?;

    let segment_position = record
        .segments
        .iter()
        .position(|segment| segment.index == index)
        .ok_or_else(|| format!("Segment {} not found", index))?;

    let removed = record.segments.remove(segment_position);
    if !removed.path.is_empty() {
        let path = PathBuf::from(&removed.path);
        if path.exists() {
            let _ = remove_file_if_exists(&path);
        }
    }

    renumber_segments_and_files(&mut record, &job_dir)?;
    invalidate_merged_artifacts(&mut record, &job_dir);
    sync_record_text(&mut record);
    finalize_record(&mut record, &job_dir);
    if !update_record_if_active(&db_path, &id, record) {
        return Err("该任务已被删除。".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn update_segment_text(
    app_handle: AppHandle,
    id: String,
    index: usize,
    text: String,
) -> Result<(), String> {
    let db_path = history_db_path(&app_handle)?;
    migrate_legacy_storage(&app_handle, &db_path)?;

    let mut record = load_record(&db_path, &id)?;
    if record.status == "processing" {
        return Err("当前任务还在生成中，暂时不能编辑句子。".to_string());
    }

    let next_text = text.trim();
    if next_text.is_empty() {
        return Err("句子内容不能为空。".to_string());
    }

    let job_dir = infer_job_dir(&record)
        .or_else(|| record.job_dir.as_ref().map(PathBuf::from))
        .ok_or_else(|| "无法定位该任务的音频目录。".to_string())?;

    let segment_position = record
        .segments
        .iter()
        .position(|segment| segment.index == index)
        .ok_or_else(|| format!("Segment {} not found", index))?;

    let current_text = record.segments[segment_position].text.trim().to_string();
    if current_text == next_text {
        return Ok(());
    }

    record.segments[segment_position].text = next_text.to_string();
    queue_segment_for_regeneration(&mut record, &job_dir, index)?;
    if !update_record_if_active(&db_path, &id, record) {
        return Err("该任务已被删除。".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn update_segment_pause(
    app_handle: AppHandle,
    id: String,
    index: usize,
    pause_ms: u32,
) -> Result<(), String> {
    let db_path = history_db_path(&app_handle)?;
    migrate_legacy_storage(&app_handle, &db_path)?;

    let mut record = load_record(&db_path, &id)?;
    if record.status == "processing" {
        return Err("当前任务还在生成中，暂时不能修改停顿。".to_string());
    }

    let job_dir = infer_job_dir(&record)
        .or_else(|| record.job_dir.as_ref().map(PathBuf::from))
        .ok_or_else(|| "无法定位该任务的音频目录。".to_string())?;

    let segment = record
        .segments
        .iter_mut()
        .find(|segment| segment.index == index)
        .ok_or_else(|| format!("Segment {} not found", index))?;

    let clamped = pause_ms.min(5000);
    if segment.pause_after_ms == clamped {
        return Ok(());
    }
    segment.pause_after_ms = clamped;

    invalidate_merged_artifacts(&mut record, &job_dir);
    finalize_record(&mut record, &job_dir);
    if !update_record_if_active(&db_path, &id, record) {
        return Err("该任务已被删除。".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn delete_history(app_handle: AppHandle, id: String) -> Result<(), String> {
    let db_path = history_db_path(&app_handle)?;
    migrate_legacy_storage(&app_handle, &db_path)?;
    mark_record_deleted(&id);

    // Also delete from legacy DB so migration never re-imports this record
    let legacy_db_path = legacy_history_db_path();
    if legacy_db_path.exists() {
        delete_record(&legacy_db_path, &id);
    }

    if let Some(record) = delete_record(&db_path, &id) {
        if let Some(job_dir) = infer_job_dir(&record) {
            if job_dir.exists() {
                fs::remove_dir_all(&job_dir).map_err(|e| {
                    format!("Failed to remove job data {}: {}", job_dir.display(), e)
                })?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn control_task(app_handle: AppHandle, id: String, action: String) -> Result<(), String> {
    let db_path = history_db_path(&app_handle)?;
    migrate_legacy_storage(&app_handle, &db_path)?;

    let mut records = read_history(&db_path);
    if let Some(position) = records.iter().position(|record| record.id == id) {
        records[position].status = match action.as_str() {
            "pause" => "paused".to_string(),
            "cancel" => "cancelled".to_string(),
            "resume" => "queued".to_string(),
            _ => records[position].status.clone(),
        };
        save_history(&db_path, &records);
    }

    Ok(())
}

#[tauri::command]
async fn extract_video_audio(app_handle: AppHandle, video_path: String) -> Result<String, String> {
    let out_dir = tmp_root(&app_handle)?;

    let out_path = out_dir.join(format!(
        "extract_{}.wav",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    let out_path_str = out_path.to_string_lossy().into_owned();

    ffmpeg::extract_audio(&video_path, &out_path_str)
        .map_err(|e| format!("FFmpeg Error: {}", e))?;

    Ok(out_path_str)
}

#[tauri::command]
async fn remerge_record(app_handle: AppHandle, id: String) -> Result<(), String> {
    let db_path = history_db_path(&app_handle)?;
    migrate_legacy_storage(&app_handle, &db_path)?;

    let mut record = load_record(&db_path, &id)?;
    if record.status == "processing" {
        return Err("当前任务还在生成中，稍后再合并。".to_string());
    }
    let job_dir = infer_job_dir(&record)
        .or_else(|| record.job_dir.as_ref().map(PathBuf::from))
        .ok_or_else(|| "无法定位该任务的音频目录。".to_string())?;

    invalidate_merged_artifacts(&mut record, &job_dir);
    match merge_record_segments(&mut record, &job_dir) {
        Ok(()) => {
            record.status = "success".to_string();
            record.error = None;
        }
        Err(error) => {
            record.status = "failed".to_string();
            record.error = Some(error.clone());
            update_record_if_active(&db_path, &id, record);
            return Err(error);
        }
    }
    if !update_record_if_active(&db_path, &id, record) {
        return Err("该任务已被删除。".to_string());
    }
    Ok(())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

#[tauri::command]
async fn export_audio(source_path: String, destination_path: String) -> Result<(), String> {
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(format!("Source audio does not exist: {}", source.display()));
    }

    let destination = PathBuf::from(&destination_path);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create export directory {}: {}",
                parent.display(),
                e
            )
        })?;
    }

    if source == destination {
        return Ok(());
    }

    remove_file_if_exists(&destination).map_err(|e| {
        format!(
            "Failed to replace existing export {}: {}",
            destination.display(),
            e
        )
    })?;

    fs::copy(&source, &destination).map_err(|e| {
        format!(
            "Failed to export audio from {} to {}: {}",
            source.display(),
            destination.display(),
            e
        )
    })?;

    Ok(())
}

#[tauri::command]
async fn is_server_live() -> bool {
    gradio::is_server_live().await
}

#[tauri::command]
async fn audio_to_video(
    app_handle: AppHandle,
    audio_path: String,
    image_path: String,
) -> Result<String, String> {
    let out_dir = tmp_root(&app_handle)?;
    let out_path = out_dir.join(format!(
        "av_{}.mp4",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    let out_path_str = out_path.to_string_lossy().into_owned();

    ffmpeg::audio_to_video(&audio_path, &image_path, &out_path_str)
        .map_err(|e| format!("FFmpeg Error: {}", e))?;

    Ok(out_path_str)
}

#[tauri::command]
async fn extract_subtitles(app_handle: AppHandle, video_path: String) -> Result<String, String> {
    let out_dir = tmp_root(&app_handle)?;
    let out_path = out_dir.join(format!(
        "subs_{}.srt",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    let out_path_str = out_path.to_string_lossy().into_owned();

    ffmpeg::extract_subtitles(&video_path, &out_path_str)
        .map_err(|e| format!("FFmpeg Error: {}", e))?;

    Ok(out_path_str)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_history,
            generate_tts,
            retry_segment,
            regenerate_queued_segments,
            delete_segment,
            update_segment_text,
            update_segment_pause,
            delete_history,
            control_task,
            extract_video_audio,
            export_audio,
            path_exists,
            remerge_record,
            is_server_live,
            audio_to_video,
            extract_subtitles
        ])
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
