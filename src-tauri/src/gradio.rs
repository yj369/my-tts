use reqwest::Client;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use tokio::time::sleep;

const GRADIO_BASE_URL: &str = "http://127.0.0.1:7860";
const GRADIO_INFO_URL: &str = "http://127.0.0.1:7860/gradio_api/info";
const GRADIO_UPLOAD_URL: &str = "http://127.0.0.1:7860/gradio_api/upload";
const GRADIO_GENERATE_URL: &str = "http://127.0.0.1:7860/gradio_api/call/gen_single";

const READY_RETRY_COUNT: usize = 30;
const REQUEST_RETRY_COUNT: usize = 3;
const READY_RETRY_DELAY_MS: u64 = 1000;
const REQUEST_RETRY_DELAY_MS: u64 = 1200;

fn build_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())
}

fn summarize_body(body: &str) -> String {
    const LIMIT: usize = 240;
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return "<empty body>".to_string();
    }
    let mut out = trimmed.chars().take(LIMIT).collect::<String>();
    if trimmed.chars().count() > LIMIT {
        out.push_str("...");
    }
    out
}

fn extract_first_path(value: &Value) -> Option<String> {
    match value {
        Value::String(path) => Some(path.clone()),
        Value::Array(items) => items.iter().find_map(extract_first_path),
        Value::Object(map) => {
            if let Some(path) = map.get("path").and_then(|value| value.as_str()) {
                return Some(path.to_string());
            }

            ["value", "data", "output"]
                .iter()
                .find_map(|key| map.get(*key).and_then(extract_first_path))
        }
        _ => None,
    }
}

fn parse_upload_body(body: &str) -> Result<String, String> {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if let Some(path) = extract_first_path(&value) {
            return Ok(path);
        }
    }

    Err(format!(
        "Upload JSON parse failed: {}",
        summarize_body(body)
    ))
}

pub async fn ensure_server_ready() -> Result<(), String> {
    let client = build_client()?;
    let mut last_error = String::new();

    for attempt in 1..=READY_RETRY_COUNT {
        match client.get(GRADIO_INFO_URL).send().await {
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                if status.is_success() {
                    return Ok(());
                }
                last_error = format!(
                    "HTTP {} from /gradio_api/info: {}",
                    status,
                    summarize_body(&body)
                );
            }
            Err(error) => {
                last_error = error.to_string();
            }
        }

        if attempt < READY_RETRY_COUNT {
            sleep(Duration::from_millis(READY_RETRY_DELAY_MS)).await;
        }
    }

    Err(format!(
        "Gradio WebUI is not ready at {} after {} attempts. Last error: {}. 请先启动或等待 IndexTTS WebUI 完全就绪后再渲染。",
        GRADIO_BASE_URL,
        READY_RETRY_COUNT,
        last_error
    ))
}

async fn upload_file(client: &Client, file_path: &str) -> Result<String, String> {
    let file_data = tokio::fs::read(file_path)
        .await
        .map_err(|e| format!("Read error {}: {}", file_path, e))?;
    let file_name = Path::new(file_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("audio.wav")
        .to_string();

    let mut last_error = String::new();

    for attempt in 1..=REQUEST_RETRY_COUNT {
        let part = reqwest::multipart::Part::bytes(file_data.clone()).file_name(file_name.clone());
        let form = reqwest::multipart::Form::new().part("files", part);

        match client.post(GRADIO_UPLOAD_URL).multipart(form).send().await {
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.map_err(|e| e.to_string())?;
                if !status.is_success() {
                    last_error = format!("Upload HTTP {}: {}", status, summarize_body(&body));
                } else {
                    return parse_upload_body(&body);
                }
            }
            Err(error) => {
                last_error = error.to_string();
            }
        }

        if attempt < REQUEST_RETRY_COUNT {
            sleep(Duration::from_millis(REQUEST_RETRY_DELAY_MS)).await;
        }
    }

    Err(format!(
        "Failed to upload {} to Gradio after {} attempts: {}",
        file_name, REQUEST_RETRY_COUNT, last_error
    ))
}

pub async fn generate_single(
    text: &str,
    prompt: &str,
    emotion: &str,
    emo_weight: f32,
) -> Result<String, String> {
    let client = build_client()?;

    let uploaded_prompt = upload_file(&client, prompt).await?;
    let uploaded_emotion = upload_file(&client, emotion).await?;

    let payload = json!({
        "data": [
            "Use emotion reference audio",
            {"path": uploaded_prompt, "meta": {"_type": "gradio.FileData"}},    // parameter 1: prompt audio
            text,                      // param 2: text
            {"path": uploaded_emotion, "meta": {"_type": "gradio.FileData"}},   // param 3: emotion audio
            emo_weight,                // param 4: weight
            0.0, 0.0, 0.0, 0.0, 0.0,   // vec1 to vec5
            0.0, 0.0, 0.0,             // vec6 to vec8
            "",                        // emo_text
            false,                     // emo_random
            120,                       // max_text_tokens
            true, 0.8, 30, 0.8, 0, 3, 10, 1500 // do_sample, top_p, top_k, temp, len_pen, beams, rep_pen, max_mel
        ]
    });

    let mut txt = String::new();
    let mut last_error = String::new();

    for attempt in 1..=REQUEST_RETRY_COUNT {
        match client.post(GRADIO_GENERATE_URL).json(&payload).send().await {
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.map_err(|e| e.to_string())?;
                if status.is_success() {
                    txt = body;
                    last_error.clear();
                    break;
                }
                last_error = format!("Handshake HTTP {}: {}", status, summarize_body(&body));
            }
            Err(error) => {
                last_error = error.to_string();
            }
        }

        if attempt < REQUEST_RETRY_COUNT {
            sleep(Duration::from_millis(REQUEST_RETRY_DELAY_MS)).await;
        }
    }

    if txt.is_empty() {
        return Err(format!(
            "Failed to start Gradio generation after {} attempts: {}",
            REQUEST_RETRY_COUNT, last_error
        ));
    }

    // Extract event_id
    let event_id: String;
    if let Ok(v) = serde_json::from_str::<Value>(&txt) {
        if let Some(id) = v.get("event_id").and_then(|i| i.as_str()) {
            event_id = id.to_string();
        } else {
            return Err(format!("Gradio Event ID Missing: {}", txt));
        }
    } else {
        return Err(format!("Invalid Gradio Handshake: {}", txt));
    }

    // Connect to SSE Stream
    let sse_url = format!("{}/{}", GRADIO_GENERATE_URL, event_id);
    let mut sse_res = client
        .get(&sse_url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !sse_res.status().is_success() {
        let status = sse_res.status();
        let body = sse_res.text().await.unwrap_or_default();
        return Err(format!(
            "Gradio stream HTTP {}: {}",
            status,
            summarize_body(&body)
        ));
    }

    let mut complete_data = String::new();
    let mut is_complete = false;

    // Read stream chunks
    while let Ok(Some(chunk)) = sse_res.chunk().await {
        let chunk_str = String::from_utf8_lossy(&chunk);
        if chunk_str.contains("event: complete") {
            is_complete = true;
        }
        if is_complete && chunk_str.contains("data:") {
            if let Some(data_idx) = chunk_str.find("data: ") {
                let json_slice = &chunk_str[data_idx + 6..];
                // Take up to next newline
                let json_str = json_slice.split('\n').next().unwrap_or(json_slice);
                complete_data = json_str.to_string();
                break;
            }
        } else if chunk_str.contains("event: error") {
            return Err(format!(
                "Gradio Processing Error encountered in stream: {}",
                chunk_str
            ));
        }
    }

    if let Ok(value) = serde_json::from_str::<Value>(&complete_data) {
        if let Some(path) = extract_first_path(&value) {
            return Ok(path);
        }
    }

    Err(format!(
        "Failed to parse stream completion: {}",
        complete_data
    ))
}

#[cfg(test)]
mod tests {
    use super::extract_first_path;
    use serde_json::json;

    #[test]
    fn extracts_path_from_gradio_update_payload() {
        let payload = json!([
            {
                "visible": true,
                "value": {
                    "path": "/tmp/output.wav",
                    "url": "http://127.0.0.1:7860/gradio_api/file=/tmp/output.wav",
                    "meta": { "_type": "gradio.FileData" }
                },
                "__type__": "update"
            }
        ]);

        assert_eq!(
            extract_first_path(&payload).as_deref(),
            Some("/tmp/output.wav")
        );
    }
}
