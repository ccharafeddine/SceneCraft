//! Cloud (BYOK) generation via fal.ai.
//!
//! Reads the fal key from the OS keychain (never from JS), submits to the fal
//! queue, polls, and returns the result as a data URL — the same `GenResult`
//! the local backend returns, so the UI is identical. The model slug is passed
//! in from the registry (models.json), so the provider/model isn't hardcoded.
//!
//! The video provider is intentionally NOT wired here (kept swappable —
//! Kling/Veo/Runway later); cloud video returns an honest "not configured" from
//! cloud.ts. Sora is intentionally never wired (discontinued).
//!
//! UNVERIFIED until a real fal key is supplied. Built to fal's documented queue
//! REST contract: POST queue.fal.run/{model} -> poll status_url -> GET
//! response_url -> images[0].url.

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::characters::{base64_encode, sniff_mime};
use crate::comfy::GenResult;
use crate::keychain::read_api_key;

fn characters_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("characters"))
}

/// Resolve registry-relative ref paths ("<id>/refs/x.jpg") to base64 data URIs
/// that fal can accept as reference images.
fn resolve_refs(app: &AppHandle, paths: &[String]) -> Result<Vec<String>, String> {
    let root = characters_root(app)?;
    let mut out = Vec::new();
    for rel in paths {
        if rel.contains("..") {
            continue;
        }
        let bytes = std::fs::read(root.join(rel)).map_err(|e| format!("read ref {rel}: {e}"))?;
        let mime = sniff_mime(&bytes);
        out.push(format!("data:{mime};base64,{}", base64_encode(&bytes)));
    }
    Ok(out)
}

/// Generate an image via fal. `model` is the fal slug from the registry
/// (text-to-image vs edit-with-references). Reference images come from the
/// active cast (multi-reference identity).
#[tauri::command]
pub async fn cloud_generate_image(
    app: AppHandle,
    model: String,
    prompt: String,
    ref_image_paths: Vec<String>,
    // Uploaded reference images already as data URLs (image-input feature).
    ref_data_urls: Vec<String>,
    width: u32,
    height: u32,
    steps: u32,
    seed: Option<u64>,
) -> Result<GenResult, String> {
    let key = read_api_key("fal")?
        .ok_or("No fal.ai API key set. Add it in Settings to use the Cloud backend.")?;
    let mut refs = resolve_refs(&app, &ref_image_paths)?;
    refs.extend(ref_data_urls);
    tauri::async_runtime::spawn_blocking(move || {
        fal_image(&key, &model, &prompt, &refs, width, height, steps, seed)
    })
    .await
    .map_err(|e| format!("cloud task failed: {e}"))?
}

fn fal_image(
    key: &str,
    model: &str,
    prompt: &str,
    refs: &[String],
    width: u32,
    height: u32,
    steps: u32,
    seed: Option<u64>,
) -> Result<GenResult, String> {
    let auth = format!("Key {key}");
    let mut input = json!({
        "prompt": prompt,
        "image_size": { "width": width, "height": height },
        "num_inference_steps": steps,
        "num_images": 1,
    });
    if let Some(s) = seed {
        input["seed"] = json!(s);
    }
    if !refs.is_empty() {
        // FLUX.2 edit: reference images carry identity (multi-reference).
        input["image_urls"] = json!(refs);
    }

    // 1. submit to the queue
    let submit: Value = ureq::post(&format!("https://queue.fal.run/{model}"))
        .set("Authorization", &auth)
        .timeout(Duration::from_secs(60))
        .send_json(input)
        .map_err(fal_err)?
        .into_json()
        .map_err(|e| e.to_string())?;
    let status_url = submit
        .get("status_url")
        .and_then(|v| v.as_str())
        .ok_or("fal: missing status_url")?
        .to_string();
    let response_url = submit
        .get("response_url")
        .and_then(|v| v.as_str())
        .ok_or("fal: missing response_url")?
        .to_string();

    // 2. poll until COMPLETED (up to ~20 min)
    let mut completed = false;
    for _ in 0..600 {
        std::thread::sleep(Duration::from_secs(2));
        let st: Value = match ureq::get(&status_url)
            .set("Authorization", &auth)
            .timeout(Duration::from_secs(15))
            .call()
        {
            Ok(r) => r.into_json().unwrap_or(Value::Null),
            Err(_) => continue,
        };
        match st.get("status").and_then(|v| v.as_str()) {
            Some("COMPLETED") => {
                completed = true;
                break;
            }
            Some("IN_QUEUE") | Some("IN_PROGRESS") | None => continue,
            Some(other) => return Err(format!("fal returned status '{other}'")),
        }
    }
    if !completed {
        return Err("fal generation timed out".into());
    }

    // 3. fetch the result + the image
    let result: Value = ureq::get(&response_url)
        .set("Authorization", &auth)
        .timeout(Duration::from_secs(30))
        .call()
        .map_err(fal_err)?
        .into_json()
        .map_err(|e| e.to_string())?;
    let img_url = result
        .get("images")
        .and_then(|i| i.as_array())
        .and_then(|a| a.first())
        .and_then(|im| im.get("url"))
        .and_then(|u| u.as_str())
        .ok_or("fal: no image url in result")?;

    let mut bytes = Vec::new();
    ureq::get(img_url)
        .timeout(Duration::from_secs(60))
        .call()
        .map_err(|e| format!("fetching the fal image failed: {e}"))?
        .into_reader()
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let mime = sniff_mime(&bytes);
    Ok(GenResult {
        data_url: format!("data:{mime};base64,{}", base64_encode(&bytes)),
        filename: "cloud-output".into(),
    })
}

fn fal_err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(401 | 403, _) => {
            "fal rejected the API key (unauthorized). Check your key in Settings.".to_string()
        }
        ureq::Error::Status(code, r) => {
            format!("fal error (HTTP {code}): {}", r.into_string().unwrap_or_default())
        }
        ureq::Error::Transport(t) => format!("fal connection failed: {t}"),
    }
}
