import { createResource, createSignal, For, Show } from "solid-js";
import { getThumbnail, type Character, type CharacterType } from "../lib/characters";
import "./CastPanel.css";

interface CastPanelProps {
  characters: Character[];
  enabledIds: Set<string>;
  loading: boolean;
  error: string | null;
  onToggle: (id: string) => void;
  onCreate: (name: string, type: CharacterType) => Promise<unknown>;
  onOpenEditor: (id: string) => void;
}

/** Up to two initials, for the placeholder when a character has no thumbnail. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Lazily loads a character's thumbnail (data URL) and falls back to initials. */
function CharacterThumb(props: { character: Character }) {
  const [src] = createResource(() => props.character.id, getThumbnail);
  return (
    <Show
      when={src()}
      fallback={
        <div class="thumb thumb--empty" aria-hidden="true">
          {initials(props.character.name)}
        </div>
      }
    >
      <img class="thumb" src={src()!} alt="" />
    </Show>
  );
}

function CharacterCard(props: {
  character: Character;
  enabled: boolean;
  onToggle: (id: string) => void;
  onOpenEditor: (id: string) => void;
}) {
  return (
    <div class="card" classList={{ "card--active": props.enabled }}>
      <button
        type="button"
        class="card__main"
        onClick={() => props.onOpenEditor(props.character.id)}
        title="Edit character"
      >
        <CharacterThumb character={props.character} />
        <span class="card__body">
          <span class="card__name">{props.character.name}</span>
          <span class="card__type">{props.character.type}</span>
        </span>
      </button>
      <label class="switch" title={props.enabled ? "Active in cast" : "Inactive"}>
        <input
          type="checkbox"
          checked={props.enabled}
          onChange={() => props.onToggle(props.character.id)}
        />
        <span class="switch__slider" />
      </label>
    </div>
  );
}

export function CastPanel(props: CastPanelProps) {
  const [showForm, setShowForm] = createSignal(false);
  const [name, setName] = createSignal("");
  const [type, setType] = createSignal<CharacterType>("photoreal");
  const [submitting, setSubmitting] = createSignal(false);
  const [formError, setFormError] = createSignal<string | null>(null);

  function resetForm() {
    setName("");
    setType("photoreal");
    setFormError(null);
    setShowForm(false);
  }

  async function submit(e: Event) {
    e.preventDefault();
    const trimmed = name().trim();
    if (!trimmed) {
      setFormError("Name is required.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await props.onCreate(trimmed, type());
      resetForm();
    } catch (err) {
      setFormError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <aside class="cast">
      <header class="cast__header">
        <h2 class="cast__title">Cast</h2>
      </header>

      <div class="cast__list">
        <Show when={!props.loading} fallback={<p class="cast__empty">Loading…</p>}>
          <Show when={!props.error} fallback={<p class="cast__empty cast__error">{props.error}</p>}>
            <Show
              when={props.characters.length > 0}
              fallback={
                <p class="cast__empty">
                  No characters yet. Create one to get started.
                </p>
              }
            >
              <For each={props.characters}>
                {(c) => (
                  <CharacterCard
                    character={c}
                    enabled={props.enabledIds.has(c.id)}
                    onToggle={props.onToggle}
                    onOpenEditor={props.onOpenEditor}
                  />
                )}
              </For>
            </Show>
          </Show>
        </Show>
      </div>

      <footer class="cast__footer">
        <Show
          when={showForm()}
          fallback={
            <button type="button" class="btn btn--primary cast__new" onClick={() => setShowForm(true)}>
              + New character
            </button>
          }
        >
          <form class="new-form" onSubmit={submit}>
            <input
              class="field"
              type="text"
              placeholder="Character name"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              disabled={submitting()}
              autofocus
            />
            <select
              class="field"
              value={type()}
              onChange={(e) => setType(e.currentTarget.value as CharacterType)}
              disabled={submitting()}
            >
              <option value="photoreal">Photoreal</option>
              <option value="stylized">Stylized</option>
            </select>
            <Show when={formError()}>
              <p class="new-form__error">{formError()}</p>
            </Show>
            <div class="new-form__actions">
              <button type="button" class="btn" onClick={resetForm} disabled={submitting()}>
                Cancel
              </button>
              <button type="submit" class="btn btn--primary" disabled={submitting()}>
                {submitting() ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        </Show>
      </footer>
    </aside>
  );
}
