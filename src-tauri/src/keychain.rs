//! OS keychain storage for cloud API keys — Windows Credential Manager / macOS
//! Keychain via the `keyring` crate.
//!
//! Keys never touch JS or disk config. The frontend only **sets**, **checks**,
//! or **clears** a key; it can never read one back. `cloud.rs` reads the key
//! directly from the keychain (in Rust) when it makes a provider call.

use keyring::Entry;

const SERVICE: &str = "scenecraft";

fn entry(provider: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, provider).map_err(|e| e.to_string())
}

/// Read a provider's key. Internal only — deliberately NOT a `#[tauri::command]`
/// so the secret can never be pulled into the webview/JS.
pub(crate) fn read_api_key(provider: &str) -> Result<Option<String>, String> {
    match entry(provider)?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Store a key for a provider (e.g. "fal") in the OS keychain.
#[tauri::command]
pub fn set_api_key(provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("API key is empty".into());
    }
    entry(&provider)?.set_password(key).map_err(|e| e.to_string())
}

/// Whether a key is stored for a provider (used to drive the no-key UI state).
#[tauri::command]
pub fn has_api_key(provider: String) -> Result<bool, String> {
    Ok(read_api_key(&provider)?.is_some())
}

/// Remove a provider's key.
#[tauri::command]
pub fn delete_api_key(provider: String) -> Result<(), String> {
    match entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trips a dummy value through the real OS keychain. Ignored by
    /// default (touches Windows Credential Manager / macOS Keychain); run with:
    /// `cargo test --lib keychain_roundtrip -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn keychain_roundtrip() {
        let p = "scenecraft-test-dummy".to_string();
        delete_api_key(p.clone()).unwrap();
        assert!(!has_api_key(p.clone()).unwrap(), "should start empty");

        set_api_key(p.clone(), "dummy-fal-key-123".into()).unwrap();
        assert!(has_api_key(p.clone()).unwrap(), "key should be present");
        assert_eq!(read_api_key(&p).unwrap().as_deref(), Some("dummy-fal-key-123"));

        delete_api_key(p.clone()).unwrap();
        assert!(!has_api_key(p).unwrap(), "key should be gone after delete");
        println!("keychain round-trip OK (set -> has -> read -> delete)");
    }
}
