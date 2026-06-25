import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js";
import { CastPanel } from "./components/CastPanel";
import { CharacterEditor } from "./components/CharacterEditor";
import { PromptPanel, type GenerateInput } from "./components/PromptPanel";
import { OutputGallery, type JobView } from "./components/OutputGallery";
import { SettingsModal } from "./components/SettingsModal";
import { LocalBackend } from "./backends/local";
import { CloudBackend } from "./backends/cloud";
import type {
  BackendMode,
  GenerationBackend,
  ImageRequest,
  JobHandle,
  VideoRequest,
} from "./backends/types";
import { routeConditioning } from "./lib/routing";
import { defaultLocalImageModel } from "./lib/models";
import { checkComfy } from "./lib/comfy";
import {
  createCharacter,
  listCharacters,
  type Character,
  type CharacterType,
} from "./lib/characters";
import "./App.css";

function App() {
  const [characters, setCharacters] = createSignal<Character[]>([]);
  const [enabledIds, setEnabledIds] = createSignal<Set<string>>(new Set());
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [jobs, setJobs] = createSignal<JobView[]>([]);
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  // Backend selection (Local | Cloud), persisted across sessions. The library,
  // routing, and prompt flow are identical regardless; only the backend swaps.
  const stored = localStorage.getItem("backendMode");
  const [backendMode, setBackendModeRaw] = createSignal<BackendMode>(
    stored === "cloud" ? "cloud" : "local",
  );
  function setBackendMode(mode: BackendMode) {
    setBackendModeRaw(mode);
    localStorage.setItem("backendMode", mode);
  }

  // ComfyUI endpoint (persisted). The app never manages ComfyUI; it talks to
  // whatever endpoint is configured here.
  const [comfyEndpoint, setComfyEndpointRaw] = createSignal(
    localStorage.getItem("comfyEndpoint") || "http://127.0.0.1:8188",
  );
  function setComfyEndpoint(url: string) {
    setComfyEndpointRaw(url);
    localStorage.setItem("comfyEndpoint", url);
  }

  const localBackend = new LocalBackend(comfyEndpoint());
  const cloudBackend = new CloudBackend();
  const backendFor = (): GenerationBackend =>
    backendMode() === "cloud" ? cloudBackend : localBackend;

  // Keep the local backend pointed at the configured endpoint.
  createEffect(() => localBackend.setEndpoint(comfyEndpoint()));

  // First-run / on-change connection check (Local only): a non-blocking banner
  // when ComfyUI is unreachable.
  const [connOk, setConnOk] = createSignal<boolean | null>(null);
  const [bannerDismissed, setBannerDismissed] = createSignal(false);
  createEffect(() => {
    const endpoint = comfyEndpoint();
    if (backendMode() !== "local") {
      setConnOk(null);
      return;
    }
    setBannerDismissed(false);
    void checkComfy(endpoint).then((s) => setConnOk(s.ok));
  });

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
  // Routing turns the active cast into conditioning for the active backend:
  // Local (FLUX.1) uses LoRA when trained; Cloud (FLUX.2) uses multi-reference.
  function buildImageRequest(input: GenerateInput): ImageRequest {
    return {
      prompt: input.prompt,
      conditioning: routeConditioning(activeCharacters(), backendMode()),
      baseModel: backendMode() === "cloud" ? "flux2-dev" : defaultLocalImageModel().id,
      width: input.width,
      height: input.height,
      steps: input.steps,
    };
  }

  function buildVideoRequest(input: GenerateInput): VideoRequest {
    return {
      prompt: input.prompt,
      conditioning: routeConditioning(activeCharacters(), backendMode()),
      baseModel: backendMode() === "cloud" ? "flux2-dev" : defaultLocalImageModel().id,
      width: input.width,
      height: input.height,
      steps: input.steps,
      videoModel: input.videoModel,
      frames: input.frames,
      fps: input.fps,
    };
  }

  function poll(backend: GenerationBackend, id: string) {
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
    const backend = backendFor();
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
    poll(backend, handle.id);
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
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main class="workspace">
        <Show when={backendMode() === "local" && connOk() === false && !bannerDismissed()}>
          <div class="conn-banner">
            <span>
              ComfyUI isn't reachable at {comfyEndpoint()}. Generation won't work until it's running
              — see the README "Setting up the generation engine" section.
            </span>
            <span class="conn-banner__actions">
              <button type="button" onClick={() => setSettingsOpen(true)}>
                Open Settings
              </button>
              <button type="button" title="Dismiss" onClick={() => setBannerDismissed(true)}>
                ✕
              </button>
            </span>
          </div>
        </Show>
        <PromptPanel
          activeCharacters={activeCharacters()}
          backendMode={backendMode()}
          onGenerate={handleGenerate}
        />
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

      <Show when={settingsOpen()}>
        <SettingsModal
          mode={backendMode()}
          onModeChange={setBackendMode}
          endpoint={comfyEndpoint()}
          onEndpointChange={setComfyEndpoint}
          onClose={() => setSettingsOpen(false)}
        />
      </Show>
    </div>
  );
}

export default App;
