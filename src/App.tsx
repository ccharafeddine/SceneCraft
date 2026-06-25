import { createSignal, onMount } from "solid-js";
import { CastPanel } from "./components/CastPanel";
import {
  createCharacter,
  listCharacters,
  type Character,
  type CharacterType,
} from "./lib/characters";
import "./App.css";

function App() {
  // Cast list from disk, plus which characters are active this session.
  // `enabledIds` is runtime-only (never persisted) and drives routing later.
  const [characters, setCharacters] = createSignal<Character[]>([]);
  const [enabledIds, setEnabledIds] = createSignal<Set<string>>(new Set());
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  async function refresh() {
    try {
      setError(null);
      setCharacters(await listCharacters());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  onMount(refresh);

  function toggle(id: string) {
    const next = new Set(enabledIds());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setEnabledIds(next);
  }

  async function handleCreate(name: string, type: CharacterType) {
    const created = await createCharacter(name, type);
    await refresh();
    return created;
  }

  function openEditor(id: string) {
    // The character editor arrives in Step 4.
    console.info("[scenecraft] open editor for", id);
  }

  return (
    <div class="layout">
      <CastPanel
        characters={characters()}
        enabledIds={enabledIds()}
        loading={loading()}
        error={error()}
        onToggle={toggle}
        onCreate={handleCreate}
        onOpenEditor={openEditor}
      />
      <main class="workspace">
        <div class="workspace__placeholder">
          <p>Prompt &amp; output arrive in Step 6.</p>
        </div>
      </main>
    </div>
  );
}

export default App;
