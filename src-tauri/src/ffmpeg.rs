use std::io;
use std::path::Path;
use std::process::Command;

/// Merge audio segments and insert FFmpeg-generated silence (anullsrc) between them.
/// `segments` is `(path, pause_after_ms)`. The last segment's pause is ignored.
pub fn merge_audio_with_pauses(
    segments: &[(String, u32)],
    output_path: &str,
) -> io::Result<()> {
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

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
    ];

    // Real audio inputs first (indices 0..N-1)
    for (path, _) in segments {
        args.push("-i".into());
        args.push(path.clone());
    }

    // Then anullsrc inputs for non-zero pauses (excluding last segment)
    let mut silence_input_index: Vec<Option<usize>> = Vec::with_capacity(segments.len());
    let mut next_input = segments.len();
    for (i, (_, pause_ms)) in segments.iter().enumerate() {
        let is_last = i + 1 == segments.len();
        if !is_last && *pause_ms > 0 {
            let secs = *pause_ms as f64 / 1000.0;
            args.push("-f".into());
            args.push("lavfi".into());
            args.push("-t".into());
            args.push(format!("{:.3}", secs));
            args.push("-i".into());
            args.push("anullsrc=r=48000:cl=mono".into());
            silence_input_index.push(Some(next_input));
            next_input += 1;
        } else {
            silence_input_index.push(None);
        }
    }

    // Build filter_complex: normalize every input, then concat in interleaved order
    let mut filter = String::new();
    let mut concat_inputs = String::new();
    let mut tag_count: usize = 0;

    let normalize = "aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono";

    for i in 0..segments.len() {
        let tag = format!("s{}", tag_count);
        tag_count += 1;
        filter.push_str(&format!("[{}:a]{}[{}];", i, normalize, tag));
        concat_inputs.push_str(&format!("[{}]", tag));

        if let Some(silence_idx) = silence_input_index[i] {
            let stag = format!("s{}", tag_count);
            tag_count += 1;
            filter.push_str(&format!("[{}:a]{}[{}];", silence_idx, normalize, stag));
            concat_inputs.push_str(&format!("[{}]", stag));
        }
    }

    filter.push_str(&format!(
        "{}concat=n={}:v=0:a=1[out]",
        concat_inputs, tag_count
    ));

    args.push("-filter_complex".into());
    args.push(filter);
    args.push("-map".into());
    args.push("[out]".into());
    args.push("-c:a".into());
    args.push("pcm_s16le".into());
    args.push("-ar".into());
    args.push("48000".into());
    args.push("-ac".into());
    args.push("1".into());
    args.push(output_path.into());

    let output = Command::new("ffmpeg").args(&args).output()?;
    if !output.status.success() {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            format!(
                "FFmpeg merge failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    Ok(())
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
