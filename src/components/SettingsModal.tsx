import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { BackendMode } from "../backends/types";
import "./SettingsModal.css";

interface SettingsModalProps {
  mode: BackendMode;
  onModeChange: (mode: BackendMode) => void;
  onClose: () => void;
}

export function SettingsModal(props: SettingsModalProps) {
  const [hasKey, setHasKey] = createSignal(false);
  const [keyInput, setKeyInput] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [msg, setMsg] = createSignal<string | null>(null);

  async function refreshKey() {
    setHasKey(await invoke<boolean>("has_api_key", { provider: "fal" }).catch(() => false));
  }

  onMount(() => {
    void refreshKey();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  async function saveKey() {
    const key = keyInput().trim();
    if (!key) return;
    setBusy(true);
    setMsg(null);
    try {
      await invoke("set_api_key", { provider: "fal", key });
      setKeyInput("");
      setMsg("Key saved to the OS keychain.");
      await refreshKey();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeKey() {
    setBusy(true);
    setMsg(null);
    try {
      await invoke("delete_api_key", { provider: "fal" });
      setMsg("Key removed.");
      await refreshKey();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="settings" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header class="editor__header">
          <h2 class="editor__title">Settings</h2>
          <button type="button" class="editor__close" onClick={props.onClose} title="Close">
            ✕
          </button>
        </header>

        <div class="settings__body">
          <section class="settings__section">
            <span class="field-row__label">Backend</span>
            <div class="segmented">
              <button
                type="button"
                class="segmented__btn"
                classList={{ "segmented__btn--active": props.mode === "local" }}
                onClick={() => props.onModeChange("local")}
              >
                Local
              </button>
              <button
                type="button"
                class="segmented__btn"
                classList={{ "segmented__btn--active": props.mode === "cloud" }}
                onClick={() => props.onModeChange("cloud")}
              >
                Cloud
              </button>
            </div>
            <p class="field-hint">
              Local runs on your ComfyUI (FLUX.1 images, LTX video). Cloud uses fal.ai (FLUX.2) —
              it handles multi-reference: group scenes and untrained characters that Local can't.
            </p>
          </section>

          <section class="settings__section">
            <span class="field-row__label">fal.ai API key</span>
            <Show
              when={hasKey()}
              fallback={
                <p class="field-hint settings__nokey">
                  No key set. Cloud generation needs a fal.ai key.
                </p>
              }
            >
              <p class="settings__keyset">✓ A key is stored in the OS keychain.</p>
            </Show>
            <div class="settings__keyrow">
              <input
                class="field"
                type="password"
                placeholder="fal_…"
                value={keyInput()}
                onInput={(e) => setKeyInput(e.currentTarget.value)}
                disabled={busy()}
              />
              <button
                type="button"
                class="btn btn--primary"
                onClick={saveKey}
                disabled={busy() || !keyInput().trim()}
              >
                Save
              </button>
            </div>
            <Show when={hasKey()}>
              <button type="button" class="btn settings__remove" onClick={removeKey} disabled={busy()}>
                Remove key
              </button>
            </Show>
            <Show when={msg()}>
              <p class="field-hint">{msg()}</p>
            </Show>
            <p class="field-hint">
              Stored in the OS keychain (Windows Credential Manager / macOS Keychain) — never in a
              config file or the repo.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
