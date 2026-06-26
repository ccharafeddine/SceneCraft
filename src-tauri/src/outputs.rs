//! Output management: persist every generation (image/video) to a user-chosen
//! folder as a real file, with a metadata sidecar so the gallery survives
//! restarts and supports re-run / open-location / delete.
//!
//! Media files land directly in the folder (`<timestamp>_<slug>.<ext>`). Their
//! metadata lives in a hidden `.scenecraft/` subfolder (one JSON per file) — so
//! the user's folder shows just the media, and saves are race-free (no shared
//! index to read-modify-write).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::characters::{base64_decode, base64_encode, iso8601_now, sniff_mime};

const META_DIR: &str = ".scenecraft";

#[derive(Serialize, Deserialize, Clone)]
pub struct SavedOutput {
    pub id: String,
    pub filename: String,
    /// "image" | "video"
    pub kind: String,
    pub prompt: String,
    /// "local" | "cloud"
    pub backend: String,
    pub created_at: String,
    /// The full ImageRequest/VideoRequest used, for faithful re-run.
    pub request: Value,
}

fn output_slug(prompt: &str) -> String {
    let mut s = String::new();
    let mut prev_dash = false;
    for ch in prompt.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            s.push(ch);
            prev_dash = false;
        } else if !s.is_empty() && !prev_dash {
            s.push('-');
            prev_dash = true;
        }
        if s.len() >= 40 {
            break;
        }
    }
    while s.ends_with('-') {
        s.pop();
    }
    if s.is_empty() {
        s.push_str("output");
    }
    s
}

fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => "bin",
    }
}

fn parse_data_url(data_url: &str) -> Result<(String, Vec<u8>), String> {
    let rest = data_url.strip_prefix("data:").ok_or("not a data URL")?;
    let (mime_part, b64) = rest.split_once(',').ok_or("malformed data URL")?;
    let mime = mime_part.split(';').next().unwrap_or("application/octet-stream").to_string();
    Ok((mime, base64_decode(b64)?))
}

/// 2026-06-25T15:30:45Z -> 20260625-153045 (filesystem-safe).
fn fs_timestamp() -> String {
    iso8601_now().replace(['-', ':', 'Z'], "").replace('T', "-")
}

fn unique_filename(folder: &Path, base: &str, ext: &str) -> String {
    let mut name = format!("{base}.{ext}");
    let mut n = 2;
    while folder.join(&name).exists() {
        name = format!("{base}_{n}.{ext}");
        n += 1;
    }
    name
}

fn safe_name(filename: &str) -> Result<(), String> {
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err("invalid filename".into());
    }
    Ok(())
}

#[tauri::command]
pub fn save_output(
    folder: String,
    data_url: String,
    kind: String,
    prompt: String,
    backend: String,
    request: Value,
) -> Result<SavedOutput, String> {
    let dir = PathBuf::from(&folder);
    let meta_dir = dir.join(META_DIR);
    fs::create_dir_all(&meta_dir).map_err(|e| format!("create output folder: {e}"))?;

    let (mime, bytes) = parse_data_url(&data_url)?;
    let base = format!("{}_{}", fs_timestamp(), output_slug(&prompt));
    let filename = unique_filename(&dir, &base, ext_for_mime(&mime));
    fs::write(dir.join(&filename), &bytes).map_err(|e| format!("write output: {e}"))?;

    let saved = SavedOutput {
        id: filename.clone(),
        filename: filename.clone(),
        kind,
        prompt,
        backend,
        created_at: iso8601_now(),
        request,
    };
    let json = serde_json::to_string_pretty(&saved).map_err(|e| e.to_string())?;
    fs::write(meta_dir.join(format!("{filename}.json")), json).map_err(|e| e.to_string())?;
    Ok(saved)
}

#[tauri::command]
pub fn list_outputs(folder: String) -> Result<Vec<SavedOutput>, String> {
    let dir = PathBuf::from(&folder);
    let meta_dir = dir.join(META_DIR);
    if !meta_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&meta_dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(data) = fs::read_to_string(&path) {
            if let Ok(item) = serde_json::from_str::<SavedOutput>(&data) {
                // Skip items whose media file was removed out from under us.
                if dir.join(&item.filename).is_file() {
                    out.push(item);
                }
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at)); // newest first
    Ok(out)
}

#[tauri::command]
pub fn read_output(folder: String, filename: String) -> Result<String, String> {
    safe_name(&filename)?;
    let bytes = fs::read(PathBuf::from(&folder).join(&filename)).map_err(|e| e.to_string())?;
    let mime = sniff_mime(&bytes);
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

#[tauri::command]
pub fn delete_output(folder: String, filename: String) -> Result<(), String> {
    safe_name(&filename)?;
    let dir = PathBuf::from(&folder);
    let _ = fs::remove_file(dir.join(&filename));
    let _ = fs::remove_file(dir.join(META_DIR).join(format!("{filename}.json")));
    Ok(())
}

/// Free space (GB) on the output folder's drive, so the UI can warn before a
/// generation fails to save on a full disk.
#[tauri::command]
pub fn disk_free_gb(folder: String) -> Result<f64, String> {
    let path = PathBuf::from(&folder);
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let bytes = fs2::available_space(&path).map_err(|e| e.to_string())?;
    Ok(bytes as f64 / 1_000_000_000.0)
}

#[tauri::command]
pub fn default_output_folder(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("outputs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn reveal_output(app: AppHandle, folder: String, filename: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    safe_name(&filename)?;
    let path = PathBuf::from(&folder).join(&filename);
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_basics() {
        assert_eq!(output_slug("A Red Fox!!"), "a-red-fox");
        assert_eq!(output_slug("   "), "output");
        assert_eq!(output_slug(""), "output");
    }

    #[test]
    fn save_list_read_delete_roundtrip() {
        let dir = std::env::temp_dir().join("scenecraft-out-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let folder = dir.to_string_lossy().to_string();
        // 1x1 PNG.
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

        let saved = save_output(
            folder.clone(),
            png.into(),
            "image".into(),
            "a red fox".into(),
            "local".into(),
            serde_json::json!({ "prompt": "a red fox", "seed": 42 }),
        )
        .unwrap();
        assert!(saved.filename.ends_with(".png"));
        assert!(saved.filename.contains("a-red-fox"));
        assert!(dir.join(&saved.filename).is_file());

        let list = list_outputs(folder.clone()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].prompt, "a red fox");
        assert_eq!(list[0].request["seed"], 42);

        let data_url = read_output(folder.clone(), saved.filename.clone()).unwrap();
        assert!(data_url.starts_with("data:image/png;base64,"));

        delete_output(folder.clone(), saved.filename.clone()).unwrap();
        assert!(!dir.join(&saved.filename).exists());
        assert_eq!(list_outputs(folder).unwrap().len(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn disk_free_reports_positive_space() {
        let folder = std::env::temp_dir().to_string_lossy().to_string();
        let gb = disk_free_gb(folder).unwrap();
        assert!(gb > 0.0, "a real drive should report some free space");
    }
}
