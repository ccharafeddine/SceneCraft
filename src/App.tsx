import { createMemo, createSignal, onMount, Show } from "solid-js";
import { CastPanel } from "./components/CastPanel";
import { CharacterEditor } from "./components/CharacterEditor";
import { PromptPanel, type GenerateInput } from "./components/PromptPanel";
import { OutputGallery, type JobView } from "./components/OutputGallery";
import { LocalBackend } from "./backends/local";
import type { ImageRequest, JobHandle, VideoRequest } from "./backends/types";
import { routeConditioning } from "./lib/routing";
import { defaultLocalImageModel } from "./lib/models";
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
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [jobs, setJobs] = createSignal<JobView[]>([]);

  // Default backend is the Local stub. The Local | Cloud toggle lands in Step 13.
  const backend = new LocalBackend();

  const activeCharacters = createMemo(() =>
    characters().filter((c) => enabledIds().has(c.id)),
  );

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

  function handleDeleted(id: string) {
    const next = new Set(enabledIds());
    next.delete(id);
    setEnabledIds(next);
    setEditingId(null);
    void refresh();
  }

  // --- generation ---
  // Routing turns the active cast into conditioning (LoRA / multi-reference /
  // none). The stub backend ignores it; the real backends (Steps 9-10) act on it.
  // The base model comes from the registry (models.json), not a hardcoded string;
  // once the connection check reads VRAM (Step 13) this becomes tier-aware.
  function buildImageRequest(input: GenerateInput): ImageRequest {
    return {
      prompt: input.prompt,
      conditioning: routeConditioning(activeCharacters()),
      baseModel: defaultLocalImageModel().id,
      width: input.width,
      height: input.height,
      steps: input.steps,
    };
  }

  function buildVideoRequest(input: GenerateInput): VideoRequest {
    return {
      prompt: input.prompt,
      conditioning: routeConditioning(activeCharacters()),
      baseModel: defaultLocalImageModel().id,
      width: input.width,
      height: input.height,
      steps: input.steps,
      videoModel: input.videoModel,
      frames: input.frames,
      fps: input.fps,
    };
  }

  function poll(id: string) {
    const tick = async () => {
      let next;
      try {
        next = await backend.pollJob(id);
      } catch (e) {
        next = { id, state: "error" as const, progress: 0, error: String(e) };
      }
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: next } : j)));
      if (next.state !== "done" && next.state !== "error") {
        setTimeout(tick, 250);
      }
    };
    void tick();
  }

  async function handleGenerate(input: GenerateInput) {
    let handle: JobHandle;
    try {
      handle =
        input.mode === "image"
          ? await backend.generateImage(buildImageRequest(input))
          : await backend.generateVideo(buildVideoRequest(input));
    } catch (e) {
      setError(String(e));
      return;
    }
    const view: JobView = {
      id: handle.id,
      kind: handle.kind,
      prompt: input.prompt || "(no prompt)",
      status: { id: handle.id, state: "queued", progress: 0 },
      createdAt: Date.now(),
    };
    setJobs((prev) => [view, ...prev]);
    poll(handle.id);
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
        onOpenEditor={setEditingId}
      />
      <main class="workspace">
        <PromptPanel activeCharacters={activeCharacters()} onGenerate={handleGenerate} />
        <OutputGallery jobs={jobs()} />
      </main>

      <Show when={editingId()}>
        {(id) => (
          <CharacterEditor
            id={id()}
            onClose={() => setEditingId(null)}
            onChanged={refresh}
            onDeleted={handleDeleted}
          />
        )}
      </Show>
    </div>
  );
}

export default App;
