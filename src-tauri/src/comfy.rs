//! ComfyUI client proxy.
//!
//! Image generation over the proven `/prompt` -> `/history` -> `/view`
//! contract, plus a `/system_stats` health check. Runs in Rust (ureq) so the
//! webview's cross-origin CORS restrictions don't block the HTTP calls. The app
//! never installs, starts, or stops ComfyUI; it only talks to an endpoint that
//! already exists (see README).
//!
//! Live step-by-step progress is delivered separately over a WebSocket the
//! frontend opens (`/ws?clientId=...`); this module owns the request/response.

use std::io::Read;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::characters::{base64_encode, sniff_mime};

#[derive(Serialize)]
pub struct GenResult {
    pub data_url: String,
    pub filename: String,
}

fn normalize(endpoint: &str) -> String {
    endpoint.trim_end_matches('/').to_string()
}

fn unreachable(endpoint: &str) -> String {
    format!(
        "ComfyUI is not reachable at {endpoint}. Start it and check the endpoint in Settings \
         (see the README section \"Setting up the generation engine\")."
    )
}

/// Health check: `GET /system_stats`. Returns the raw JSON (GPU + VRAM + tier).
#[tauri::command]
pub fn comfy_health(endpoint: String) -> Result<Value, String> {
    let url = format!("{}/system_stats", normalize(&endpoint));
    match ureq::get(&url).timeout(Duration::from_secs(5)).call() {
        Ok(resp) => resp.into_json::<Value>().map_err(|e| e.to_string()),
        Err(_) => Err(unreachable(&endpoint)),
    }
}

/// Generate one image from a complete ComfyUI graph. Blocks (on a Tauri command
/// thread) until the job finishes, then returns the result image as a data URL.
#[tauri::command]
pub fn comfy_generate_image(
    endpoint: String,
    graph: Value,
    client_id: String,
) -> Result<GenResult, String> {
    run_image_job(&normalize(&endpoint), graph, &client_id)
}

/// Core of `comfy_generate_image`, split out so it can be exercised directly by
/// the live integration test (and reused by future graph variants).
fn run_image_job(base: &str, graph: Value, client_id: &str) -> Result<GenResult, String> {
    // 1. POST /prompt
    let body = serde_json::json!({ "prompt": graph, "client_id": client_id });
    let resp = ureq::post(&format!("{base}/prompt"))
        .timeout(Duration::from_secs(30))
        .send_json(body)
        .map_err(|e| match e {
            ureq::Error::Status(code, r) => format!(
                "ComfyUI rejected the workflow (HTTP {code}): {}",
                r.into_string().unwrap_or_default()
            ),
            ureq::Error::Transport(_) => unreachable(base),
        })?;
    let posted: Value = resp.into_json().map_err(|e| e.to_string())?;
    if let Some(node_errors) = posted.get("node_errors").and_then(|v| v.as_object()) {
        if !node_errors.is_empty() {
            return Err(format!("ComfyUI rejected the workflow: {node_errors:?}"));
        }
    }
    let prompt_id = posted
        .get("prompt_id")
        .and_then(|v| v.as_str())
        .ok_or("ComfyUI did not return a prompt_id")?
        .to_string();

    // 2. Poll /history/{prompt_id} until an image output appears or it errors.
    //    600 * 500ms = up to 5 minutes (first run loads ~10GB and is the slow one).
    let mut image: Option<Value> = None;
    for _ in 0..600 {
        std::thread::sleep(Duration::from_millis(500));
        let hist = match ureq::get(&format!("{base}/history/{prompt_id}"))
            .timeout(Duration::from_secs(10))
            .call()
        {
            Ok(r) => r.into_json::<Value>().unwrap_or(Value::Null),
            Err(_) => continue, // transient; keep polling
        };
        let Some(entry) = hist.get(&prompt_id) else {
            continue;
        };
        if let Some(status) = entry.get("status") {
            if status.get("status_str").and_then(|s| s.as_str()) == Some("error") {
                return Err(execution_error(status));
            }
        }
        if let Some(outputs) = entry.get("outputs").and_then(|o| o.as_object()) {
            for node in outputs.values() {
                if let Some(first) = node
                    .get("images")
                    .and_then(|i| i.as_array())
                    .and_then(|a| a.first())
                {
                    image = Some(first.clone());
                    break;
                }
            }
        }
        if image.is_some() {
            break;
        }
    }
    let image = image.ok_or("Generation timed out without producing an image")?;
    let filename = image.get("filename").and_then(|v| v.as_str()).unwrap_or_default();
    let subfolder = image.get("subfolder").and_then(|v| v.as_str()).unwrap_or_default();
    let itype = image.get("type").and_then(|v| v.as_str()).unwrap_or("output");

    // 3. GET /view -> bytes -> data URL (ureq .query handles URL-encoding).
    let resp = ureq::get(&format!("{base}/view"))
        .query("filename", filename)
        .query("subfolder", subfolder)
        .query("type", itype)
        .timeout(Duration::from_secs(60))
        .call()
        .map_err(|e| format!("fetching the result image failed: {e}"))?;
    let mut bytes = Vec::new();
    resp.into_reader()
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let mime = sniff_mime(&bytes);
    let data_url = format!("data:{mime};base64,{}", base64_encode(&bytes));

    Ok(GenResult {
        data_url,
        filename: filename.to_string(),
    })
}

/// Pull a readable message out of ComfyUI's history error status, flagging OOM
/// with the agreed fix order so the UI can surface it.
fn execution_error(status: &Value) -> String {
    let mut detail = String::new();
    if let Some(msgs) = status.get("messages").and_then(|m| m.as_array()) {
        for m in msgs {
            let Some(arr) = m.as_array() else { continue };
            if arr.first().and_then(|v| v.as_str()) == Some("execution_error") {
                if let Some(data) = arr.get(1) {
                    let etype = data.get("exception_type").and_then(|v| v.as_str()).unwrap_or("");
                    let emsg = data.get("exception_message").and_then(|v| v.as_str()).unwrap_or("");
                    detail = format!("{etype}: {emsg}");
                }
            }
        }
    }
    if detail.is_empty() {
        detail = "ComfyUI reported an execution error.".to_string();
    }
    let low = detail.to_lowercase();
    if low.contains("out of memory") || low.contains("outofmemory") || low.contains("cuda error") {
        format!(
            "Out of VRAM — {detail}\nFix order: close the NVIDIA overlay (and other GPU apps), \
             then drop the T5 encoder to Q4_K_M."
        )
    } else {
        detail
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live end-to-end generation against a running ComfyUI at 127.0.0.1:8188,
    /// using the repo's proven FLUX.1 template. Ignored by default (needs the
    /// server + ~80s); run with: `cargo test --lib -- --ignored comfy_live`.
    #[test]
    #[ignore]
    fn comfy_live_generates_an_image() {
        let template = std::fs::read_to_string("../graphs/txt2img_flux.json")
            .expect("read graphs/txt2img_flux.json");
        let graph: Value = serde_json::from_str(&template).expect("parse template");
        let res = run_image_job("http://127.0.0.1:8188", graph, "scenecraft-live-test")
            .expect("generation should succeed against the live server");
        assert!(res.data_url.starts_with("data:image/"));
        assert!(res.data_url.len() > 1000, "data url should carry real image bytes");
        println!("live test produced {} ({} b64 chars)", res.filename, res.data_url.len());
    }
}
