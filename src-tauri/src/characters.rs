//! Character folder CRUD.
//!
//! A character is a folder on disk under the app-data `characters/` directory:
//!
//! ```text
//! characters/
//!   joe/
//!     refs/            # 20-30+ reference images
//!     lora/            # optional trained .safetensors
//!     thumb.png        # auto-set to first ref
//!     character.json
//! ```
//!
//! This module owns that folder layout and the `character.json` contract. It
//! does not know anything about generation, training, or ComfyUI.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Mirrors `character.json` on disk exactly (see CLAUDE.md data model).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Character {
    pub id: String,
    pub name: String,
    /// "photoreal" | "stylized". Renamed because `type` is a Rust keyword.
    #[serde(rename = "type")]
    pub char_type: String,
    /// Injected into prompts when a LoRA is active. The user never types this.
    pub trigger: String,
    /// Relative path to the trained weight, or `null` until trained.
    pub lora_path: Option<String>,
    pub lora_strength: f32,
    pub base_model: String,
    /// Relative paths like `refs/01.jpg`.
    pub ref_images: Vec<String>,
    pub created_at: String,
}

const ALLOWED_IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif", "heic", "avif",
];
// Local 8GB default. FLUX.2 ("flux2-dev") is selected only on the cloud/16GB+ path.
const DEFAULT_BASE_MODEL: &str = "flux1-dev";
const DEFAULT_LORA_STRENGTH: f32 = 0.9;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested, no filesystem)
// ---------------------------------------------------------------------------

/// Turn a display name into a filesystem-safe folder id: lowercase ascii
/// alphanumerics, every run of other characters collapses to a single `_`.
pub fn slugify(name: &str) -> String {
    let mut slug = String::new();
    let mut prev_sep = false;
    for ch in name.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            prev_sep = false;
        } else if !slug.is_empty() && !prev_sep {
            slug.push('_');
            prev_sep = true;
        }
    }
    while slug.ends_with('_') {
        slug.pop();
    }
    slug
}

/// Build a fresh character with the documented defaults.
pub fn new_character(
    id: String,
    name: String,
    char_type: String,
    trigger: String,
    created_at: String,
) -> Character {
    Character {
        id,
        name,
        char_type,
        trigger,
        lora_path: None,
        lora_strength: DEFAULT_LORA_STRENGTH,
        base_model: DEFAULT_BASE_MODEL.to_string(),
        ref_images: Vec::new(),
        created_at,
    }
}

fn validate_type(t: &str) -> Result<String, String> {
    match t {
        "photoreal" | "stylized" => Ok(t.to_string()),
        other => Err(format!(
            "invalid type '{other}', expected 'photoreal' or 'stylized'"
        )),
    }
}

/// RFC 3339 / ISO 8601 UTC timestamp, dependency-free.
pub(crate) fn iso8601_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hour, min, sec) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{min:02}:{sec:02}Z")
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 -> (year, month, day).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/// `<app_data>/characters`, created if missing.
pub(crate) fn characters_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?
        .join("characters");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create characters dir: {e}"))?;
    Ok(dir)
}

pub(crate) fn char_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(characters_root(app)?.join(id))
}

pub(crate) fn read_character(dir: &Path) -> Result<Character, String> {
    let json_path = dir.join("character.json");
    let data = fs::read_to_string(&json_path)
        .map_err(|e| format!("read {}: {e}", json_path.display()))?;
    serde_json::from_str(&data).map_err(|e| format!("parse {}: {e}", json_path.display()))
}

pub(crate) fn write_character(dir: &Path, c: &Character) -> Result<(), String> {
    let json = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
    fs::write(dir.join("character.json"), json)
        .map_err(|e| format!("write character.json: {e}"))
}

/// Pick a non-colliding destination filename inside `dir` for an imported file.
fn unique_name(dir: &Path, src: &Path) -> String {
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("ref");
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("img");
    let mut name = format!("{stem}.{ext}");
    let mut n = 2;
    while dir.join(&name).exists() {
        name = format!("{stem}_{n}.{ext}");
        n += 1;
    }
    name
}

/// Standard base64 (with padding), dependency-free.
pub(crate) fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Standard base64 decode (ignores padding/whitespace), dependency-free.
pub(crate) fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for &c in s.as_bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        let v = val(c).ok_or("invalid base64")? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

/// Guess an image MIME from magic bytes so a JPEG copied into `thumb.png`
/// still gets the right data-URL type.
pub(crate) fn sniff_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.len() > 11 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/png"
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Create a character folder + `character.json`. Returns the new character.
/// The id is slugified from `name` and de-duplicated against existing folders.
#[tauri::command]
pub fn create_character(
    app: AppHandle,
    name: String,
    char_type: String,
    trigger: Option<String>,
) -> Result<Character, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("name cannot be empty".into());
    }
    let char_type = validate_type(&char_type)?;

    let base_id = slugify(&name);
    if base_id.is_empty() {
        return Err("name must contain letters or numbers".into());
    }

    let root = characters_root(&app)?;
    let mut id = base_id.clone();
    let mut n = 2;
    while root.join(&id).exists() {
        id = format!("{base_id}_{n}");
        n += 1;
    }

    let dir = root.join(&id);
    fs::create_dir_all(dir.join("refs")).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir.join("lora")).map_err(|e| e.to_string())?;

    let trigger = trigger
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| format!("{id}_token"));

    let c = new_character(id, name, char_type, trigger, iso8601_now());
    write_character(&dir, &c)?;
    Ok(c)
}

/// List every character on disk, sorted by creation time. Folders without a
/// readable `character.json` are skipped (logged, not fatal).
#[tauri::command]
pub fn list_characters(app: AppHandle) -> Result<Vec<Character>, String> {
    let root = characters_root(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.join("character.json").is_file() {
            match read_character(&path) {
                Ok(c) => out.push(c),
                Err(e) => eprintln!("skipping {}: {e}", path.display()),
            }
        }
    }
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(out)
}

/// Read a single character by id.
#[tauri::command]
pub fn get_character(app: AppHandle, id: String) -> Result<Character, String> {
    read_character(&char_dir(&app, &id)?)
}

/// Persist edits (type, trigger, strength, lora_path, etc.). The folder is
/// keyed by `character.id`, which is never changed here.
#[tauri::command]
pub fn update_character(app: AppHandle, character: Character) -> Result<Character, String> {
    let mut character = character;
    character.char_type = validate_type(&character.char_type)?;
    let dir = char_dir(&app, &character.id)?;
    if !dir.join("character.json").is_file() {
        return Err(format!("character '{}' does not exist", character.id));
    }
    write_character(&dir, &character)?;
    Ok(character)
}

/// Delete a character folder and everything in it.
#[tauri::command]
pub fn delete_character(app: AppHandle, id: String) -> Result<(), String> {
    let dir = char_dir(&app, &id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Copy image files into the character's `refs/` folder, append them to
/// `ref_images`, and auto-set `thumb.png` to the first ref if not already set.
/// Non-image files are skipped. Returns the updated character.
#[tauri::command]
pub fn import_refs(app: AppHandle, id: String, paths: Vec<String>) -> Result<Character, String> {
    let dir = char_dir(&app, &id)?;
    let mut c = read_character(&dir)?;
    let refs_dir = dir.join("refs");
    fs::create_dir_all(&refs_dir).map_err(|e| e.to_string())?;

    let mut imported = 0;
    for src in &paths {
        let src_path = Path::new(src);
        let ext = src_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !ALLOWED_IMAGE_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let file_name = unique_name(&refs_dir, src_path);
        fs::copy(src_path, refs_dir.join(&file_name)).map_err(|e| format!("copy {src}: {e}"))?;
        let rel = format!("refs/{file_name}");
        if !c.ref_images.contains(&rel) {
            c.ref_images.push(rel);
        }
        imported += 1;
    }

    if imported > 0 && !dir.join("thumb.png").exists() {
        if let Some(first) = c.ref_images.first() {
            let _ = fs::copy(dir.join(first), dir.join("thumb.png"));
        }
    }

    write_character(&dir, &c)?;
    Ok(c)
}

/// Set `thumb.png` to a copy of an existing ref (e.g. user picks a better one).
#[tauri::command]
pub fn set_thumb(app: AppHandle, id: String, ref_path: String) -> Result<(), String> {
    let dir = char_dir(&app, &id)?;
    let src = dir.join(&ref_path);
    if !src.is_file() {
        return Err(format!("ref '{ref_path}' not found"));
    }
    fs::copy(&src, dir.join("thumb.png")).map_err(|e| e.to_string())?;
    Ok(())
}

/// Return the character's thumbnail as a data URL, or `None` if not set yet.
#[tauri::command]
pub fn get_thumbnail(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let thumb = char_dir(&app, &id)?.join("thumb.png");
    if !thumb.is_file() {
        return Ok(None);
    }
    let bytes = fs::read(&thumb).map_err(|e| e.to_string())?;
    let mime = sniff_mime(&bytes);
    Ok(Some(format!("data:{mime};base64,{}", base64_encode(&bytes))))
}

/// Return a reference image (under the character's `refs/`) as a data URL.
/// Rejects anything outside `refs/` so a crafted path can't read the disk.
#[tauri::command]
pub fn get_ref_image(
    app: AppHandle,
    id: String,
    ref_path: String,
) -> Result<Option<String>, String> {
    if ref_path.contains("..") || !ref_path.starts_with("refs/") {
        return Err(format!("invalid ref path '{ref_path}'"));
    }
    let path = char_dir(&app, &id)?.join(&ref_path);
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let mime = sniff_mime(&bytes);
    Ok(Some(format!("data:{mime};base64,{}", base64_encode(&bytes))))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basics() {
        assert_eq!(slugify("Joe"), "joe");
        assert_eq!(slugify("Joe Smith"), "joe_smith");
        assert_eq!(slugify("  Pizza   Ninja!! "), "pizza_ninja");
        assert_eq!(slugify("J03"), "j03");
        assert_eq!(slugify("a-b_c"), "a_b_c");
        assert_eq!(slugify("***"), "");
    }

    #[test]
    fn character_json_roundtrip_uses_type_key() {
        let c = new_character(
            "joe".into(),
            "Joe".into(),
            "photoreal".into(),
            "joe_token".into(),
            "2026-01-01T00:00:00Z".into(),
        );
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains("\"type\":\"photoreal\""));
        let back: Character = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "joe");
        assert_eq!(back.lora_path, None);
        assert_eq!(back.base_model, "flux1-dev");
        assert_eq!(back.lora_strength, 0.9);
        assert!(back.ref_images.is_empty());
    }

    #[test]
    fn type_validation() {
        assert!(validate_type("photoreal").is_ok());
        assert!(validate_type("stylized").is_ok());
        assert!(validate_type("anime").is_err());
    }

    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(365), (1971, 1, 1));
        assert_eq!(civil_from_days(10_957), (2000, 1, 1));
    }

    #[test]
    fn base64_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"M"), "TQ==");
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
    }

    #[test]
    fn sniff_mime_by_magic() {
        assert_eq!(sniff_mime(&[0x89, 0x50, 0x4E, 0x47, 0x0D]), "image/png");
        assert_eq!(sniff_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), "image/jpeg");
        assert_eq!(sniff_mime(b"GIF89a"), "image/gif");
    }
}
