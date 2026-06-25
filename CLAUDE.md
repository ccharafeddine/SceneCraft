# Scenecraft (placeholder name, rename freely)

**One-line spec:** Standalone Mac/Windows desktop app that lets you create reusable "characters" from a 20-30+ image album, then generate photorealistic or stylized images and videos of one or more of those characters doing anything, anywhere, with maximum identity fidelity. Runs fully local when toggled on. No library lock-in, no accounts, no telemetry, no ads, MIT.

This is a Smith-family tool: single purpose, clean, native. It does character-conditioned generation and nothing else. If a feature isn't in service of "pick character(s) → describe scene → get image or video," it doesn't belong in v1.

---

## Stack (locked)

- **Shell:** Tauri 2.x (Rust + system webview, ~10MB binary)
- **Frontend:** SolidJS + TypeScript + Vite, plain CSS with custom properties for light/dark theming via `prefers-color-scheme`
- **Generation engine:** ComfyUI running at a local endpoint (offline) OR a cloud API (BYOK). The app does NOT install, manage, or launch ComfyUI; it expects an endpoint to exist and talks to it. Engine setup lives in the README as steps Claude Code executes per machine. The app never reimplements diffusion; it sends graphs and reads results.
- **Image model:** FLUX.2 Dev (open weights, local) or FLUX.2 via cloud. Supports LoRA and multi-reference.
- **Video model (stylized):** LTX-Video, image-to-video. Runs on 8GB+.
- **Video model (photoreal):** Wan 2.2 image-to-video. 14B wants 16GB+; 1.3B fits 8GB at lower quality.
- **LoRA training:** swappable backend, local (ai-toolkit) or cloud (fal.ai). Separate from generation.
- **Local store:** plain folders + JSON on disk. No database in v1.

Rationale for matching GifSmith's stack: same toolchain, smallest binary, native file dialogs, fast fine-grained reactivity for the gallery and progress UI.

---

## Core design principle: solve identity at the image stage, never the video stage

Do not ask a video model to know a face. The pipeline always generates a still with identity already locked (FLUX.2 + the character's LoRA, or multi-reference), then feeds that finished frame into image-to-video. The video model only adds motion to a frame that is already correct.

Consequences:
- Video backend (LTX, Wan) is interchangeable and never touches the identity problem.
- One pipeline handles photoreal humans and stylized characters. References are references; the model does not care if they are photos of a person or renders of a Pizza Ninja. Only a per-character `type` flag changes prompt scaffolding and negatives.

**Training is one-time per character.** Training consumes the album and compiles a single `.safetensors` into the character's `lora/` folder. After that, every image and video loads that file in milliseconds; you never train again unless you change the album. Mental model: album is the source, LoRA is a compiled artifact, re-train = re-compile. Adding references does not auto-update the LoRA; it sits unused until a re-train. The album is the durable asset and can be re-compiled at higher quality later (e.g. on a 16GB+ card or cloud) without collecting new photos. The 3-4 hour cost on 8GB is paid once at character creation, not per generation.

---

## Character data model

Each character is a local folder under the app's `characters/` directory:

```
characters/
  joe/
    refs/            # 20-30+ reference images
    lora/            # optional trained .safetensors
    thumb.png        # auto-set to first ref
    character.json
```

`character.json`:

```json
{
  "id": "joe",
  "name": "Joe",
  "type": "photoreal",            // "photoreal" | "stylized"
  "trigger": "j03_token",         // injected into prompts when LoRA active
  "lora_path": "lora/joe.safetensors",  // null until trained
  "lora_strength": 0.9,
  "base_model": "flux2-dev",
  "ref_images": ["refs/01.jpg", "..."],
  "created_at": "..."
}
```

Creating a character: name it, drop images into `refs/`, pick type, optionally train. That is the entire abstraction.

---

## Backend abstraction (the heart of the app)

A single `GenerationBackend` interface with two implementations behind a settings toggle. The character library and prompt flow are identical regardless of backend.

```ts
interface GenerationBackend {
  generateImage(req: ImageRequest): Promise<JobHandle>;
  generateVideo(req: VideoRequest): Promise<JobHandle>; // image-to-video
  pollJob(id: string): Promise<JobStatus>;              // queued|running|done|error + progress
}
```

- **LocalBackend:** talks to a ComfyUI endpoint at a URL set in settings (default `http://127.0.0.1:8188`). `POST /prompt` with a workflow graph, subscribe to the WebSocket for progress, `GET /history/{id}` then `GET /view` for outputs. The app assumes ComfyUI is already running (started by the user or by Claude Code per the README). It does not own ComfyUI's lifecycle.
- **CloudBackend:** BYOK. Image/training via Black Forest Labs or fal.ai; video via Kling/Veo/Runway. Keys live in the settings panel, stored with the OS keychain (Tauri's secure store), never in plaintext config.

Do NOT wire Sora. It is discontinued (API ends Sept 24, 2026).

A separate `TrainingBackend` (local ai-toolkit subprocess, or fal cloud trainer) produces a `.safetensors` written into the character's `lora/` folder. Generation and training backends are chosen independently, so a fully-local generation user can still offload one-time training to cloud.

---

## Identity + routing logic

```
activeCharacters = cast.filter(c => c.enabled)

if activeCharacters.length === 0:
    plain text-to-image, no conditioning
elif activeCharacters.length === 1:
    c = activeCharacters[0]
    if c.lora_path: inject LoRA node + trigger token   # max fidelity (default)
    else:           inject multi-reference (up to 10 refs)
else:  # 2+ characters in one frame
    use multi-reference with each character's refs       # avoids LoRA identity bleed
    (optional advanced: regional conditioning per subject)
```

Two-plus characters always routes to multi-reference. Stacking multiple LoRAs causes identity bleed (one face leaks onto another); multi-reference is the correct tool for group scenes.

---

## Generation contracts

The app ships a set of ComfyUI workflow graph templates (JSON) with placeholder nodes the backend fills at runtime:

1. **txt2img_flux_lora.json** — FLUX.2 + LoRA loader + trigger token. Single photoreal/stylized character, max fidelity.
2. **txt2img_flux_multiref.json** — FLUX.2 + multi-reference image inputs. Solo without LoRA, or group scenes.
3. **img2vid_ltx.json** — LTX-Video image-to-video. Stylized.
4. **img2vid_wan.json** — Wan 2.2 image-to-video. Photoreal.

Video flow is always two stages internally: generate the locked still, then animate it. The user sees one "Generate video" button.

---

## UI / screens (keep it GifSmith-simple)

Single window, three regions:

- **Left: Cast panel.** Character cards with thumbnail + on/off toggle. Multiple can be active. "+ New character" at the bottom. Card click opens the character editor (album, type, LoRA status, train button, trigger, strength slider).
- **Center: Prompt + output.** Plain-English prompt box (active characters auto-injected, user never types trigger tokens). Image/Video toggle. Output-controls disclosure (size, steps, video length, video model). Generate button. Output gallery below, async with progress bars.
- **Settings (modal):** backend toggle (Local | Cloud), ComfyUI setup/status, cloud keys (keychain), training backend, output folder.

Aesthetic: minimal and native, same bar as GifSmith. System font stack, CSS custom properties, light/dark via `prefers-color-scheme`. No chrome that isn't load-bearing.

---

## First-run: connection check (Local backend)

The app does not install ComfyUI. The README handles that (per machine, executed by Claude Code or the user). On first run in Local mode, the app:

1. Reads the configured ComfyUI endpoint from settings (default `http://127.0.0.1:8188`).
2. Pings `/system_stats`. If alive, reads GPU + VRAM and shows the tier so the user knows what's runnable.
3. If unreachable, shows a clear, non-blocking error pointing at the README's "Setting up the generation engine" section, with the endpoint field editable inline.

That is the entire local-backend onboarding. No Python management, no installer, no subprocess lifecycle.

---

## Project structure

```
scenecraft/
  src/                      # SolidJS frontend
    components/
      CastPanel.tsx
      CharacterEditor.tsx
      PromptPanel.tsx
      OutputGallery.tsx
      SettingsModal.tsx
      ConnectionCheck.tsx
    backends/
      types.ts              # GenerationBackend, TrainingBackend interfaces
      local.ts              # ComfyUI client (talks to existing endpoint)
      cloud.ts              # BYOK clients
    lib/routing.ts          # identity + multi-character routing
  src-tauri/                # Rust
    src/
      comfy.rs              # ComfyUI client proxy + health check (does NOT manage ComfyUI)
      training.rs           # ai-toolkit subprocess / fal client
      characters.rs         # CRUD over characters/ folders
      keychain.rs           # secure key storage
  graphs/                   # ComfyUI workflow templates (JSON)
  characters/               # user data (gitignored)
  CLAUDE.md
  README.md                 # includes consent disclosure (see below)
  LICENSE                   # MIT
```

---

## Build plan (ordered, drop into Claude Code one step at a time)

1. Scaffold Tauri 2.x + SolidJS + TS + Vite. Empty window, light/dark theming, system font.
2. Character folder CRUD in Rust (`characters.rs`): create, list, read/write `character.json`, import images into `refs/`, set thumb.
3. Cast panel UI: list character cards from disk, on/off toggle in component state, "+ New character" flow.
4. Character editor: album grid, type selector, trigger field, strength slider, LoRA status (none/trained), train button (stubbed).
5. Define backend interfaces (`backends/types.ts`). Stub both implementations returning fake jobs.
6. Prompt panel + output gallery wired to the stubbed backend. Image/Video toggle, async job UI with progress bars.
7. Routing logic (`lib/routing.ts`) with unit tests for the 0 / 1-LoRA / 1-multiref / 2+ cases.
8. Stand up ComfyUI manually (follow README) and get one FLUX.2 image out of it by hand. Confirm the `/prompt`, `/history`, `/view`, WebSocket contract before automating anything.
9. ComfyUI client (`backends/local.ts` + `comfy.rs`): POST graph, WebSocket progress, history + view fetch, `/system_stats` health check. Test against the manually-running ComfyUI from step 8.
10. Graph templates: txt2img_flux_lora and txt2img_flux_multiref. Fill placeholders from request. Real local image generation works end to end.
11. Video graphs: img2vid_ltx and img2vid_wan. Implement the two-stage still-then-animate flow behind one button.
12. CloudBackend: BYOK image + video clients. Keychain storage (`keychain.rs`). Backend toggle in settings.
13. Connection check + settings: editable ComfyUI endpoint, health ping, tier readout, clear error pointing at the README when unreachable.
14. Training backend (`training.rs`): local ai-toolkit subprocess writing `.safetensors` to the character; fal cloud trainer as alternative. Wire the train button. Training is one-time per character.
15. Output management: save to chosen folder, gallery persistence, re-run with same settings.
16. Polish: error states, OOM/VRAM guidance surfaced from ComfyUI responses, disk-space checks for outputs, empty states.
17. Package: Mac (.dmg, note Gatekeeper) and Windows (.msi/.exe). Verify README + consent disclosure + MIT license are present.

---

## Gotchas

- **Mac vs Windows GPU split.** Local video generation is a CUDA/NVIDIA world. The 3070 (Windows) is the realistic local video machine; the Mac handles local image generation (FLUX via Q4/MLX, slow) but is not a viable local video box in 2026. The backend toggle is what makes this a non-issue: Mac users flip to cloud for video.
- **8GB training is slow.** FLUX LoRA at Q4 on the 3070 runs multi-hour. Default the training backend recommendation to cloud (fal) for 8GB tiers; keep local available with a clear time warning.
- **Multi-LoRA bleed.** Never stack two character LoRAs in one graph. Route 2+ characters to multi-reference.
- **Trigger tokens.** Inject the LoRA trigger automatically; never make the user type it. Keep prompts plain English.
- **App does not own ComfyUI.** The app never starts, stops, or installs ComfyUI. It assumes an endpoint exists (see README). If the ping fails, show the README pointer, never try to fix the environment from inside the app.
- **Keys never in plaintext.** Cloud keys go through the OS keychain via Tauri secure store, not a JSON config.
- **Weight downloads are huge.** Always disk-space-check before pulling models. Show progress; allow resume.
- **Sora is dead.** Do not add it as a video provider.
- **Solid reactivity.** Don't destructure props (breaks reactivity); access via `props.x`. Same pitfall as GifSmith.

---

## Consent and license (required, ships in README + LICENSE)

Scenecraft generates images and video of real and fictional characters from user-supplied reference images. The README must state plainly:

- This tool is for generating likenesses you own or have explicit consent to use.
- Generating sexual or intimate imagery of any real person without their consent is prohibited and in many jurisdictions illegal.
- Generating sexual content involving minors is illegal everywhere and absolutely prohibited. Running locally does not change this.
- The user is solely responsible for the content they generate and for complying with the terms of any cloud model provider they configure.

MIT license for the code. The disclosure is a usage notice in the README and an in-app first-run acknowledgement, not a license restriction.
