use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const TARGET_SAMPLE_RATE: u32 = 48_000;
const TARGET_CHANNELS: u16 = 1;
const TARGET_BITS_PER_SAMPLE: u16 = 16;

fn ffmpeg_command_failed(action: &str, stderr: &[u8]) -> io::Error {
    io::Error::other(format!(
        "FFmpeg {} failed: {}",
        action,
        String::from_utf8_lossy(stderr).trim()
    ))
}

fn normalize_audio_for_concat(input_path: &str, output_path: &Path) -> io::Result<()> {
    let output = Command::new("ffmpeg")
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            input_path,
            "-c:a",
            "pcm_s16le",
            "-ar",
            "48000",
            "-ac",
            "1",
            output_path.to_string_lossy().as_ref(),
        ])
        .output()?;

    if !output.status.success() {
        return Err(ffmpeg_command_failed("normalization", &output.stderr));
    }
    Ok(())
}

fn write_pcm_silence_wav(output_path: &Path, duration_ms: u32) -> io::Result<()> {
    let sample_count = ((duration_ms as u64 * TARGET_SAMPLE_RATE as u64) + 500) / 1000;
    let block_align = TARGET_CHANNELS * (TARGET_BITS_PER_SAMPLE / 8);
    let byte_rate = TARGET_SAMPLE_RATE * block_align as u32;
    let data_size = sample_count
        .checked_mul(block_align as u64)
        .ok_or_else(|| io::Error::other("Silence clip is too large"))?;
    let data_size_u32 =
        u32::try_from(data_size).map_err(|_| io::Error::other("Silence clip is too large"))?;
    let riff_size = 36u32
        .checked_add(data_size_u32)
        .ok_or_else(|| io::Error::other("Silence clip is too large"))?;

    let mut file = File::create(output_path)?;
    file.write_all(b"RIFF")?;
    file.write_all(&riff_size.to_le_bytes())?;
    file.write_all(b"WAVE")?;
    file.write_all(b"fmt ")?;
    file.write_all(&16u32.to_le_bytes())?;
    file.write_all(&1u16.to_le_bytes())?;
    file.write_all(&TARGET_CHANNELS.to_le_bytes())?;
    file.write_all(&TARGET_SAMPLE_RATE.to_le_bytes())?;
    file.write_all(&byte_rate.to_le_bytes())?;
    file.write_all(&block_align.to_le_bytes())?;
    file.write_all(&TARGET_BITS_PER_SAMPLE.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&data_size_u32.to_le_bytes())?;

    let zero_chunk = [0u8; 8192];
    let mut remaining = data_size as usize;
    while remaining > 0 {
        let len = remaining.min(zero_chunk.len());
        file.write_all(&zero_chunk[..len])?;
        remaining -= len;
    }

    Ok(())
}

fn concat_list_entry(path: &Path) -> io::Result<String> {
    let normalized = path
        .canonicalize()?
        .to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "'\\''");
    Ok(format!("file '{}'\n", normalized))
}

fn merge_audio_files(segments: &[PathBuf], output_path: &str, list_file: &Path) -> io::Result<()> {
    if segments.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "No audio segments to merge",
        ));
    }

    let mut concat_content = String::new();
    for seg in segments {
        concat_content.push_str(&concat_list_entry(seg)?);
    }
    fs::write(list_file, concat_content)?;

    let output = Command::new("ffmpeg")
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list_file.to_string_lossy().as_ref(),
            "-c",
            "copy",
            output_path,
        ])
        .output()?;

    if !output.status.success() {
        return Err(ffmpeg_command_failed("merge", &output.stderr));
    }
    Ok(())
}

fn unique_merge_working_dir() -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    std::env::temp_dir().join(format!("ttsm-{}-{}", std::process::id(), timestamp))
}

/// Merge audio segments and insert FFmpeg-generated silence (anullsrc) between them.
/// `segments` is `(path, pause_after_ms)`. The last segment's pause is ignored.
pub fn merge_audio_with_pauses(segments: &[(String, u32)], output_path: &str) -> io::Result<()> {
    if segments.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "No audio segments to merge",
        ));
    }

    if segments.len() == 1 {
        std::fs::copy(&segments[0].0, output_path)?;
        return Ok(());
    }

    let working_dir = unique_merge_working_dir();

    if let Err(error) = fs::remove_dir_all(&working_dir) {
        if error.kind() != io::ErrorKind::NotFound {
            return Err(error);
        }
    }
    fs::create_dir_all(&working_dir)?;

    // Windows can fail to spawn ffmpeg with OS error 206 once the inline
    // filter graph and input list become too long. Normalize every input to a
    // short, local temp file and merge via concat list instead.
    let merge_result = (|| -> io::Result<()> {
        let mut concat_inputs: Vec<PathBuf> = Vec::with_capacity(segments.len() * 2);

        for (index, (segment_path, pause_ms)) in segments.iter().enumerate() {
            let normalized_path = working_dir.join(format!("s{:03}.wav", index + 1));
            normalize_audio_for_concat(segment_path, &normalized_path)?;
            concat_inputs.push(normalized_path);

            let is_last = index + 1 == segments.len();
            if !is_last && *pause_ms > 0 {
                let silence_path = working_dir.join(format!("p{:03}.wav", index + 1));
                write_pcm_silence_wav(&silence_path, *pause_ms)?;
                concat_inputs.push(silence_path);
            }
        }

        let list_file = working_dir.join("c.txt");
        merge_audio_files(&concat_inputs, output_path, &list_file)
    })();

    let _ = fs::remove_dir_all(&working_dir);
    merge_result
}

pub fn extract_audio(video_path: &str, output_path: &str) -> std::io::Result<()> {
    let output = Command::new("ffmpeg")
        .args([
            "-i",
            video_path,
            "-vn",
            "-acodec",
            "pcm_s16le",
            "-ar",
            "44100",
            "-ac",
            "1",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            output_path,
        ])
        .output()?;

    if !output.status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!(
                "FFmpeg extraction failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    Ok(())
}

#[allow(dead_code)]
pub fn merge_audio(segments: Vec<&str>, output_path: &str, list_file: &str) -> std::io::Result<()> {
    if segments.len() == 1 {
        std::fs::copy(segments[0], output_path)?;
        return Ok(());
    }

    let segment_paths: Vec<PathBuf> = segments.into_iter().map(PathBuf::from).collect();
    merge_audio_files(&segment_paths, output_path, Path::new(list_file))
}

pub fn audio_to_video(
    audio_path: &str,
    image_path: &str,
    output_path: &str,
) -> std::io::Result<()> {
    let output = Command::new("ffmpeg")
        .args([
            "-loop",
            "1",
            "-i",
            image_path,
            "-i",
            audio_path,
            "-vf",
            "scale=trunc(iw/2)*2:trunc(ih/2)*2", // 确保宽高是偶数，H.264 必须
            "-c:v",
            "libx264",
            "-tune",
            "stillimage",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-pix_fmt",
            "yuv420p",
            "-shortest",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            output_path,
        ])
        .output()?;

    if !output.status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!(
                "FFmpeg audio-to-video failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    Ok(())
}

pub fn extract_subtitles(video_path: &str, output_path: &str) -> std::io::Result<()> {
    // Try to extract the first subtitle stream to .srt
    let output = Command::new("ffmpeg")
        .args([
            "-i",
            video_path,
            "-map",
            "0:s:0",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            output_path,
        ])
        .output()?;

    if !output.status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!(
                "FFmpeg subtitle extraction failed (maybe no subtitle stream found): {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    Ok(())
}
