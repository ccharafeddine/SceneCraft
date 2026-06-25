import { createEffect, createResource, createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import {
  deleteCharacter,
  getCharacter,
  getRefImage,
  importRefs,
  setThumb,
  updateCharacter,
  type Character,
  type CharacterType,
} from "../lib/characters";
import "./CharacterEditor.css";

const IMAGE_EXTENSIONS = [
  "jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif", "heic", "avif",
];

interface CharacterEditorProps {
  id: string;
  onClose: () => void;
  /** Persisted change that the cast list should reflect (name/type/thumb). */
  onChanged: () => void;
  onDeleted: (id: string) => void;
}

/** One album cell: loads a ref image (data URL) and offers "set as thumbnail". */
function RefCell(props: {
  id: string;
  refPath: string;
  onSetThumb: (refPath: string) => void;
}) {
  const [src] = createResource(
    () => ({ id: props.id, refPath: props.refPath }),
    (k) => getRefImage(k.id, k.refPath),
  );
  return (
    <div class="ref-cell">
      <Show when={src()} fallback={<div class="ref-cell__loading" />}>
        <img class="ref-cell__img" src={src()!} alt="" loading="lazy" />
      </Show>
      <button
        type="button"
        class="ref-cell__thumb-btn"
        title="Use as thumbnail"
        onClick={() => props.onSetThumb(props.refPath)}
      >
        Set thumbnail
      </button>
    </div>
  );
}

export function CharacterEditor(props: CharacterEditorProps) {
  const [character, setCharacter] = createSignal<Character | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [trainNote, setTrainNote] = createSignal<string | null>(null);

  // Live-edited field mirrors (so typing/dragging feels instant; persistence
  // happens on commit). Seeded from the loaded character.
  const [trigger, setTrigger] = createSignal("");
  const [strength, setStrength] = createSignal(0.9);

  // (Re)load whenever the target id changes.
  createEffect(() => {
    const id = props.id;
    setCharacter(null);
    setLoadError(null);
    getCharacter(id)
      .then((c) => {
        setCharacter(c);
        setTrigger(c.trigger);
        setStrength(c.lora_strength);
      })
      .catch((e) => setLoadError(String(e)));
  });

  // Close on Escape.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  async function patch(update: Partial<Character>) {
    const cur = character();
    if (!cur) return;
    const next = { ...cur, ...update };
    setCharacter(next); // optimistic
    setBusy(true);
    setSaveError(null);
    try {
      const saved = await updateCharacter(next);
      setCharacter(saved);
      props.onChanged();
    } catch (e) {
      setSaveError(String(e));
      // Revert to disk truth on failure.
      getCharacter(props.id).then(setCharacter).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function addImages() {
    const selected = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;
    setBusy(true);
    setSaveError(null);
    try {
      const updated = await importRefs(props.id, paths);
      setCharacter(updated);
      props.onChanged(); // thumbnail may have been auto-set
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function makeThumb(refPath: string) {
    try {
      await setThumb(props.id, refPath);
      props.onChanged();
    } catch (e) {
      setSaveError(String(e));
    }
  }

  async function remove() {
    const cur = character();
    const label = cur ? cur.name : props.id;
    const ok = window.confirm(
      `Delete "${label}"? This permanently removes its album and any trained LoRA.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await deleteCharacter(props.id);
      props.onDeleted(props.id);
    } catch (e) {
      setSaveError(String(e));
      setBusy(false);
    }
  }

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="editor" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <Show when={character()} fallback={
          <div class="editor__loading">
            <Show when={loadError()} fallback={<p>Loading…</p>}>
              <p class="editor__error">{loadError()}</p>
            </Show>
          </div>
        }>
          {(c) => (
            <>
              <header class="editor__header">
                <div class="editor__title-block">
                  <h2 class="editor__title">{c().name}</h2>
                  <span class="editor__id">{c().id}</span>
                </div>
                <button type="button" class="editor__close" onClick={props.onClose} title="Close">
                  ✕
                </button>
              </header>

              <Show when={saveError()}>
                <p class="editor__error editor__error--banner">{saveError()}</p>
              </Show>

              <div class="editor__body">
                {/* Settings column */}
                <section class="editor__settings">
                  <label class="field-row">
                    <span class="field-row__label">Type</span>
                    <select
                      class="field"
                      value={c().type}
                      disabled={busy()}
                      onChange={(e) => patch({ type: e.currentTarget.value as CharacterType })}
                    >
                      <option value="photoreal">Photoreal</option>
                      <option value="stylized">Stylized</option>
                    </select>
                  </label>

                  <label class="field-row">
                    <span class="field-row__label">Trigger</span>
                    <input
                      class="field"
                      type="text"
                      value={trigger()}
                      disabled={busy()}
                      onInput={(e) => setTrigger(e.currentTarget.value)}
                      onChange={() => patch({ trigger: trigger().trim() })}
                    />
                  </label>
                  <p class="field-hint">
                    Injected automatically when this character's LoRA is active. You never type it in prompts.
                  </p>

                  <div class="field-row">
                    <span class="field-row__label">
                      LoRA strength <span class="field-row__value">{strength().toFixed(2)}</span>
                    </span>
                    <input
                      class="slider"
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={strength()}
                      disabled={busy()}
                      onInput={(e) => setStrength(Number(e.currentTarget.value))}
                      onChange={() => patch({ lora_strength: strength() })}
                    />
                  </div>

                  <div class="field-row">
                    <span class="field-row__label">LoRA status</span>
                    <Show
                      when={c().lora_path}
                      fallback={<span class="badge badge--none">Not trained</span>}
                    >
                      <span class="badge badge--ok">Trained</span>
                    </Show>
                  </div>

                  <button type="button" class="btn train-btn" onClick={() => {
                    setTrainNote(
                      "Training is wired up in Step 14. On 8GB cards, cloud (fal) training is recommended.",
                    );
                  }}>
                    Train LoRA
                  </button>
                  <Show when={trainNote()}>
                    <p class="field-hint">{trainNote()}</p>
                  </Show>

                  <button type="button" class="btn btn--danger" disabled={busy()} onClick={remove}>
                    Delete character
                  </button>
                </section>

                {/* Album column */}
                <section class="editor__album">
                  <div class="album__head">
                    <span class="album__title">
                      Album <span class="album__count">{c().ref_images.length}</span>
                    </span>
                    <button type="button" class="btn btn--primary" disabled={busy()} onClick={addImages}>
                      Add images
                    </button>
                  </div>
                  <Show
                    when={c().ref_images.length > 0}
                    fallback={
                      <div class="album__empty">
                        No reference images yet. Add 20-30+ for a strong character.
                      </div>
                    }
                  >
                    <div class="album__grid">
                      <For each={c().ref_images}>
                        {(refPath) => (
                          <RefCell id={c().id} refPath={refPath} onSetThumb={makeThumb} />
                        )}
                      </For>
                    </div>
                  </Show>
                </section>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
