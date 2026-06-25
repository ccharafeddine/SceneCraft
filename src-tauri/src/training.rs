//! LoRA training — one-time per character.
//!
//! Two backends behind one shape, chosen independently of the generation
//! backend (a local-generation user can offload training to cloud):
//!   - cloud (fal): the default for 8GB — fal trains a FLUX.1 dev LoRA.
//!   - local (ai-toolkit): generates a config; the subprocess is impractical on
//!     8GB, so this build hands you the config + a pointer rather than running
//!     a multi-hour job behind your back.
//!
//! On success the `.safetensors` lands in `characters/<id>/lora/<id>.safetensors`
//! and `character.json`'s `lora_path` flips to it — which unblocks the LoRA
//! generation path the routing/graph already build. The base is FLUX.1 (matching
//! local generation), so the LoRA loads locally.
//!
//! UNVERIFIED until a real fal key + a finished album exist. The fal flow is
//! built to the documented queue contract; the config generation and the
//! lands-and-flips logic are unit-tested.

use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::characters::{char_dir, characters_root, read_character, write_character, Character};
use crate::keychain::read_api_key;

/// A character needs at least this many references to train a usable LoRA.
pub const MIN_ALBUM: usize = 10;

// ---------------------------------------------------------------------------
// Lands-and-flips: place the trained weight and flip the character to "trained"
// ---------------------------------------------------------------------------

/// Copy a trained `.safetensors` into the character's `lora/` folder and set
/// `lora_path` in `character.json`. After this, routing returns `lora` for the
/// character and the graph injects the LoRA loader.
pub(crate) fn place_lora_and_flip(char_dir: &Path, src: &Path) -> Result<(), String> {
    let id = char_dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("cannot determine character id from folder")?;
    let lora_dir = char_dir.join("lora");
    std::fs::create_dir_all(&lora_dir).map_err(|e| e.to_string())?;
    let dest_name = format!("{id}.safetensors");
    std::fs::copy(src, lora_dir.join(&dest_name)).map_err(|e| format!("place lora: {e}"))?;

    let mut c = read_character(char_dir)?;
    c.lora_path = Some(format!("lora/{dest_name}"));
    write_character(char_dir, &c)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Config / request generation (pure, unit-tested)
// ---------------------------------------------------------------------------

/// fal FLUX.1 LoRA trainer input. `images_data_url` is a zip of the album.
pub(crate) fn fal_train_input(trigger: &str, images_data_url: &str, steps: u32) -> Value {
    json!({
        "images_data_url": images_data_url,
        "trigger_word": trigger,
        "steps": steps,
        "create_masks": true,
    })
}

/// ai-toolkit FLUX.1 dev LoRA config (YAML). Base is FLUX.1 dev to match the
/// local generation path.
pub(crate) fn ai_toolkit_config(id: &str, trigger: &str, refs_dir: &str, output_dir: &str) -> String {
    format!(
        "---\n\
job: extension\n\
config:\n\
  name: {id}\n\
  process:\n\
    - type: sd_trainer\n\
      training_folder: {output_dir}\n\
      trigger_word: {trigger}\n\
      network:\n\
        type: lora\n\
        linear: 16\n\
        linear_alpha: 16\n\
      save:\n\
        dtype: float16\n\
      datasets:\n\
        - folder_path: {refs_dir}\n\
      train:\n\
        steps: 2000\n\
        batch_size: 1\n\
        lr: 1e-4\n\
      model:\n\
        name_or_path: black-forest-labs/FLUX.1-dev\n\
        is_flux: true\n\
        quantize: true\n"
    )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Zip the album images (registry-relative paths) into an in-memory zip and
/// return a `data:application/zip;base64,...` URL fal can ingest.
fn zip_album_data_url(app: &AppHandle, ref_paths: &[String]) -> Result<String, String> {
    if ref_paths.len() < MIN_ALBUM {
        return Err(format!(
            "This character has {} reference image(s); training needs at least {MIN_ALBUM}. Add more, then train.",
            ref_paths.len()
        ));
    }
    let root = characters_root(app)?;
    let mut buf = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut buf);
        let mut zip = zip::ZipWriter::new(cursor);
        let opts: zip::write::FileOptions<()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (i, rel) in ref_paths.iter().enumerate() {
            if rel.contains("..") {
                continue;
            }
            let bytes = std::fs::read(root.join(rel)).map_err(|e| format!("read ref {rel}: {e}"))?;
            let ext = Path::new(rel).extension().and_then(|e| e.to_str()).unwrap_or("jpg");
            zip.start_file(format!("{i:03}.{ext}"), opts).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?;
    }
    Ok(format!("data:application/zip;base64,{}", crate::characters::base64_encode(&buf)))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Cloud training via fal (FLUX.1 LoRA). Reads the fal key from the keychain,
/// zips the album, submits, polls, downloads the LoRA, and flips the character.
#[tauri::command]
pub async fn train_cloud(
    app: AppHandle,
    character_id: String,
    trigger: String,
    ref_image_paths: Vec<String>,
    fal_model: String,
    steps: u32,
) -> Result<Character, String> {
    let key = read_api_key("fal")?
        .ok_or("No fal.ai API key set. Add it in Settings to use cloud training.")?;
    let images = zip_album_data_url(&app, &ref_image_paths)?;
    let dir = char_dir(&app, &character_id)?;
    let input = fal_train_input(&trigger, &images, steps);

    tauri::async_runtime::spawn_blocking(move || run_fal_training(&key, &fal_model, input, &dir))
        .await
        .map_err(|e| format!("training task failed: {e}"))?
}

fn run_fal_training(key: &str, model: &str, input: Value, dir: &Path) -> Result<Character, String> {
    let auth = format!("Key {key}");
    let submit: Value = ureq::post(&format!("https://queue.fal.run/{model}"))
        .set("Authorization", &auth)
        .timeout(Duration::from_secs(120))
        .send_json(input)
        .map_err(fal_err)?
        .into_json()
        .map_err(|e| e.to_string())?;
    let status_url = submit.get("status_url").and_then(|v| v.as_str()).ok_or("fal: no status_url")?.to_string();
    let response_url = submit.get("response_url").and_then(|v| v.as_str()).ok_or("fal: no response_url")?.to_string();

    // Training is slow: poll up to ~40 min.
    let mut done = false;
    for _ in 0..480 {
        std::thread::sleep(Duration::from_secs(5));
        let st: Value = match ureq::get(&status_url).set("Authorization", &auth).timeout(Duration::from_secs(20)).call() {
            Ok(r) => r.into_json().unwrap_or(Value::Null),
            Err(_) => continue,
        };
        match st.get("status").and_then(|v| v.as_str()) {
            Some("COMPLETED") => {
                done = true;
                break;
            }
            Some("IN_QUEUE") | Some("IN_PROGRESS") | None => continue,
            Some(other) => return Err(format!("fal training status '{other}'")),
        }
    }
    if !done {
        return Err("fal training timed out".into());
    }

    let result: Value = ureq::get(&response_url).set("Authorization", &auth).timeout(Duration::from_secs(30)).call()
        .map_err(fal_err)?.into_json().map_err(|e| e.to_string())?;
    let lora_url = result
        .get("diffusers_lora_file")
        .and_then(|f| f.get("url"))
        .and_then(|u| u.as_str())
        .ok_or("fal: training result has no diffusers_lora_file")?;

    // Download the .safetensors to a temp file, then place + flip.
    let mut bytes = Vec::new();
    ureq::get(lora_url).timeout(Duration::from_secs(300)).call().map_err(|e| e.to_string())?
        .into_reader().read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let tmp = std::env::temp_dir().join("scenecraft-trained-lora.safetensors");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    place_lora_and_flip(dir, &tmp)?;
    let _ = std::fs::remove_file(&tmp);
    read_character(dir)
}

/// Local training via ai-toolkit. Generates the config into the character's
/// folder. Running the multi-hour subprocess on 8GB is impractical, so rather
/// than silently spawn it this returns the config path + guidance (cloud is the
/// 8GB default). 16GB+ users run ai-toolkit with the generated config.
#[tauri::command]
pub fn train_local(
    app: AppHandle,
    character_id: String,
    trigger: String,
) -> Result<Character, String> {
    let dir = char_dir(&app, &character_id)?;
    let c = read_character(&dir)?;
    if c.ref_images.len() < MIN_ALBUM {
        return Err(format!(
            "This character has {} reference image(s); training needs at least {MIN_ALBUM}.",
            c.ref_images.len()
        ));
    }
    let refs_dir = dir.join("refs");
    let out_dir = dir.join("lora");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let config = ai_toolkit_config(
        &character_id,
        &trigger,
        &refs_dir.to_string_lossy(),
        &out_dir.to_string_lossy(),
    );
    let cfg_path = out_dir.join("train_config.yaml");
    std::fs::write(&cfg_path, config).map_err(|e| e.to_string())?;
    Err(format!(
        "Local training is impractical on 8GB (multi-hour). Cloud (fal) is the default for your tier. \
         An ai-toolkit FLUX.1 config was written to {} — on a 16GB+ card, run ai-toolkit with it. See README.",
        cfg_path.display()
    ))
}

fn fal_err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(401 | 403, _) => {
            "fal rejected the API key (unauthorized). Check your key in Settings.".to_string()
        }
        ureq::Error::Status(code, r) => {
            format!("fal training error (HTTP {code}): {}", r.into_string().unwrap_or_default())
        }
        ureq::Error::Transport(t) => format!("fal connection failed: {t}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::characters::{new_character, write_character};

    #[test]
    fn fal_input_carries_trigger_and_steps() {
        let v = fal_train_input("j03_token", "data:application/zip;base64,AAAA", 1500);
        assert_eq!(v["trigger_word"], "j03_token");
        assert_eq!(v["steps"], 1500);
        assert_eq!(v["images_data_url"], "data:application/zip;base64,AAAA");
    }

    #[test]
    fn ai_toolkit_config_is_flux1_and_has_trigger() {
        let cfg = ai_toolkit_config("joe", "j03_token", "/refs", "/out");
        assert!(cfg.contains("trigger_word: j03_token"));
        assert!(cfg.contains("black-forest-labs/FLUX.1-dev"));
        assert!(cfg.contains("is_flux: true"));
    }

    #[test]
    fn place_lora_flips_character_to_trained() {
        // Temp character dir with a character.json and a dummy trained weight.
        let base = std::env::temp_dir().join("scenecraft-train-test");
        let dir = base.join("joe");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&dir).unwrap();
        let c = new_character(
            "joe".into(),
            "Joe".into(),
            "photoreal".into(),
            "j03_token".into(),
            "2026-01-01T00:00:00Z".into(),
        );
        assert_eq!(c.lora_path, None);
        write_character(&dir, &c).unwrap();

        let dummy = base.join("dummy.safetensors");
        std::fs::write(&dummy, b"not-a-real-lora").unwrap();

        place_lora_and_flip(&dir, &dummy).unwrap();

        let after = read_character(&dir).unwrap();
        assert_eq!(after.lora_path.as_deref(), Some("lora/joe.safetensors"));
        assert!(dir.join("lora/joe.safetensors").is_file());

        let _ = std::fs::remove_dir_all(&base);
    }
}
