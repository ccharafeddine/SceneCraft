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
  VideoRequest,
} from "./backends/types";
import { routeConditioning } from "./lib/routing";
import { defaultLocalImageModel } from "./lib/models";
import { checkComfy } from "./lib/comfy";
import {
  defaultOutputFolder,
  deleteOutput,
  listOutputs,
  revealOutput,
  saveOutput,
  type SavedOutput,
} from "./lib/outputs";
import {
  createCharacter,
  listCharacters,
  type Character,
  type CharacterType,
} from "./lib/characters";
import "./App.css";

function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000_000);
}

function App() {
  const [characters, setCharacters] = createSignal<Character[]>([]);
  const [enabledIds, setEnabledIds] = createSignal<Set<string>>(new Set());
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [jobs, setJobs] = createSignal<JobView[]>([]);
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  const stored = localStorage.getItem("backendMode");
  const [backendMode, setBackendModeRaw] = createSignal<BackendMode>(
    stored === "cloud" ? "cloud" : "local",
  );
  function setBackendMode(mode: BackendMode) {
    setBackendModeRaw(mode);
    localStorage.setItem("backendMode", mode);
  }

  const [comfyEndpoint, setComfyEndpointRaw] = createSignal(
    localStorage.getItem("comfyEndpoint") || "http://127.0.0.1:8188",
  );
  function setComfyEndpoint(url: string) {
    setComfyEndpointRaw(url);
    localStorage.setItem("comfyEndpoint", url);
  }

  // Output folder where every generation is saved (persisted across restarts).
  const [outputFolder, setOutputFolderRaw] = createSignal(
    localStorage.getItem("outputFolder") || "",
  );
  function setOutputFolder(path: string) {
    setOutputFolderRaw(path);
    localStorage.setItem("outputFolder", path);
    void loadOutputs(path);
  }

  const localBackend = new LocalBackend(comfyEndpoint());
  const cloudBackend = new CloudBackend();
  const backendFor = (): GenerationBackend =>
    backendMode() === "cloud" ? cloudBackend : localBackend;

  createEffect(() => localBackend.setEndpoint(comfyEndpoint()));

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

  /** Load previously-saved generations from the output folder into the gallery. */
  async function loadOutputs(folder: string) {
    if (!folder) return;
    try {
      const saved = await listOutputs(folder);
      setJobs(
        saved.map((s) => ({
          id: s.id,
          kind: s.kind,
          prompt: s.prompt,
          status: { id: s.id, state: "done" as const, progress: 1 },
          createdAt: Date.parse(s.created_at) || 0,
          saved: s,
        })),
      );
    } catch {
      /* gallery starts empty if the folder can't be read */
    }
  }

  onMount(async () => {
    let folder = outputFolder();
    if (!folder) {
      try {
        folder = await defaultOutputFolder();
        setOutputFolderRaw(folder);
        localStorage.setItem("outputFolder", folder);
      } catch {
        /* leave empty; saving will surface a clear error */
      }
    }
    await loadOutputs(folder);
    await refresh();
  });

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
  function buildImageRequest(input: GenerateInput): ImageRequest {
    return {
      prompt: input.prompt,
      conditioning: routeConditioning(activeCharacters(), backendMode()),
      baseModel: backendMode() === "cloud" ? "flux2-dev" : defaultLocalImageModel().id,
      width: input.width,
      height: input.height,
      steps: input.steps,
      seed: randomSeed(),
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
      seed: randomSeed(),
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
      if (next.state === "done") {
        const job = jobs().find((j) => j.id === id);
        const url = next.outputs?.[0]?.url;
        if (job && url && job.request && !job.saved && (job.kind === "image" || job.kind === "video")) {
          try {
            const saved = await saveOutput(
              outputFolder(),
              url,
              job.kind,
              job.prompt,
              job.backendName ?? "local",
              job.request as ImageRequest | VideoRequest,
            );
            setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: next, saved } : j)));
            return;
          } catch (e) {
            const failed = { ...next, message: `Saved to gallery failed: ${e}` };
            setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: failed } : j)));
            return;
          }
        }
      }
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: next } : j)));
      if (next.state !== "done" && next.state !== "error") {
        setTimeout(tick, 250);
      }
    };
    void tick();
  }

  async function startJob(
    backend: GenerationBackend,
    mode: "image" | "video",
    prompt: string,
    request: ImageRequest | VideoRequest,
  ) {
    let handle;
    try {
      handle =
        mode === "image"
          ? await backend.generateImage(request as ImageRequest)
          : await backend.generateVideo(request as VideoRequest);
    } catch (e) {
      setError(String(e));
      return;
    }
    const view: JobView = {
      id: handle.id,
      kind: handle.kind,
      prompt: prompt || "(no prompt)",
      status: { id: handle.id, state: "queued", progress: 0 },
      createdAt: Date.now(),
      request,
      backendName: backend.name,
    };
    setJobs((prev) => [view, ...prev]);
    poll(backend, handle.id);
  }

  function handleGenerate(input: GenerateInput) {
    const backend = backendFor();
    const request = input.mode === "image" ? buildImageRequest(input) : buildVideoRequest(input);
    void startJob(backend, input.mode, input.prompt, request);
  }

  // --- gallery item actions ---
  function rerun(saved: SavedOutput) {
    const backend = saved.backend === "cloud" ? cloudBackend : localBackend;
    void startJob(backend, saved.kind, saved.prompt, saved.request);
  }

  async function deleteItem(saved: SavedOutput) {
    try {
      await deleteOutput(outputFolder(), saved.filename);
    } catch (e) {
      setError(String(e));
    }
    setJobs((prev) => prev.filter((j) => j.saved?.filename !== saved.filename));
  }

  function revealItem(saved: SavedOutput) {
    void revealOutput(outputFolder(), saved.filename).catch((e) => setError(String(e)));
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
        <OutputGallery
          jobs={jobs()}
          outputFolder={outputFolder()}
          onRerun={rerun}
          onDelete={deleteItem}
          onReveal={revealItem}
        />
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
          outputFolder={outputFolder()}
          onOutputFolderChange={setOutputFolder}
          onClose={() => setSettingsOpen(false)}
        />
      </Show>
    </div>
  );
}

export default App;
