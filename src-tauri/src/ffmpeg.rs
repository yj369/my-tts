use std::path::Path;
use std::process::Command;

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

pub fn merge_audio(segments: Vec<&str>, output_path: &str, list_file: &str) -> std::io::Result<()> {
    if segments.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "No audio segments to merge",
        ));
    }

    if segments.len() == 1 {
        std::fs::copy(segments[0], output_path)?;
        return Ok(());
    }

    let mut concat_content = String::new();
    for seg in segments {
        let canonical_seg = Path::new(seg).canonicalize()?;
        concat_content.push_str(&format!(
            "file '{}'\n",
            canonical_seg.to_string_lossy().replace("'", "'\\''")
        ));
    }
    std::fs::write(list_file, concat_content)?;

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
            list_file,
            "-c",
            "copy",
            output_path,
        ])
        .output()?;

    if !output.status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!(
                "FFmpeg merge failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    Ok(())
}
