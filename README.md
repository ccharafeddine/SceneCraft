<p align="center">
  <img src="logo.svg" alt="Scenecraft" width="360" />
</p>

# Scenecraft

A standalone Mac/Windows desktop app for generating photorealistic or stylized images and videos of reusable **characters**. Create a character once from a 20-30+ image album, train it, then generate that character (or several together) doing anything, anywhere, with maximum identity fidelity. Runs **fully local** when toggled on, or against cloud APIs with your own keys.

Single purpose, in the spirit of GifSmith and ClipSmith: it does character-conditioned image and video generation and nothing else. No accounts, no telemetry, no ads. MIT licensed.

---

## Table of contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Hardware tiers](#hardware-tiers)
- [Quick start](#quick-start)
- [Building the app](#building-the-app)
- [Setting up the generation engine (ComfyUI)](#setting-up-the-generation-engine-comfyui)
- [Configuring Scenecraft](#configuring-scenecraft)
- [Using Scenecraft](#using-scenecraft)
- [Cloud backend (optional)](#cloud-backend-optional)
- [Notes for Claude Code](#notes-for-claude-code)
- [Consent and acceptable use](#consent-and-acceptable-use)
- [License](#license)

---

## What it does

- **Characters.** A character is an album of reference images plus an optional trained LoRA. Photoreal (real people) or stylized (e.g. an original cartoon character) both work through the same pipeline.
- **Choose your cast.** Toggle one or more characters on. Active characters are auto-injected into your prompt. Two or more in one scene is supported (e.g. two people on a trip together).
- **Generate images and videos.** Plain-English prompt, pick image or video, generate. Video animates a still that already has the identity locked, so the face never drifts.
- **Local or cloud.** A single toggle. Local routes through ComfyUI on your own hardware (offline, unfiltered, nothing leaves the machine). Cloud routes through provider APIs with your own keys.

## How it works

The core design rule: **identity is solved at the image stage, never the video stage.** A still is generated with the character's trained LoRA (or multi-reference), and that finished frame is fed into an image-to-video model. The video model only adds motion. This is what makes max fidelity and "any character, any scene" compatible, and it makes the video backend swappable.

**Training is one-time per character.** Training compiles the album into a single `.safetensors` weight file. After that, every generation loads it in milliseconds. You only re-train if you change the album. The album is the durable asset; the LoRA is a compiled artifact you can recompile at higher quality later on better hardware without collecting new photos.

```
Album (20-30+ images)  --train once-->  character LoRA (.safetensors)
                                              |
Prompt + active characters  --->  FLUX + LoRA  --->  identity-locked still
                                                              |
                                              --->  Wan / LTX image-to-video  --->  video
```

## Hardware tiers

Local generation is an NVIDIA/CUDA world. Apple Silicon runs local **image** generation (slowly, via MPS); local **video** generation is not viable on Mac in 2026 (flip to cloud for video on a Mac). The 8GB tier runs **FLUX.1 dev (Q4 GGUF)**; **FLUX.2 needs 16GB+ or cloud** (it does not fit 8GB even quantized). All VRAM figures verified against ComfyUI's FLUX.1/FLUX.2 and video docs as of mid-2026; check the linked repos for current numbers.

| GPU VRAM | Image | Video | LoRA training | Notes |
|---|---|---|---|---|
| 8GB (e.g. RTX 3070) | FLUX.1 dev GGUF Q4_K_S (~6.8GB, `--lowvram`) | LTX-Video (stylized), Wan 1.3B (low-res photoreal) | Impractical locally (8GB VRAM / 16GB RAM); use cloud (fal) | FLUX.2 + multi-reference (2+ chars) need cloud or 16GB+ |
| 12-16GB | FLUX.2 Dev FP8 | Wan 14B (12GB with patience, 16GB comfortable), LTX | Local viable | Solid all-rounder |
| 24GB+ | FLUX.2 Dev FP8/full | Wan 14B, HunyuanVideo | Local fast | Full quality |
| Apple Silicon (M-series) | FLUX via MPS, slow | Not viable locally | Slow/nascent | Use cloud for video |

The backend toggle exists precisely so hardware limits are never a hard block: train and generate what your card handles locally, flip to cloud for the rest.

## Quick start

```bash
# 1. Clone
git clone https://github.com/<you>/SceneCraft.git
cd scenecraft

# 2. Build the app (see "Building the app" for prerequisites)
npm install
npm run tauri build      # or: npm run tauri dev   for development

# 3. Set up the generation engine for local use (see that section)
#    Then launch ComfyUI and point Scenecraft at http://127.0.0.1:8188

# 4. Create a character, train it, generate.
```

If you are building this from scratch with Claude Code, skip to [Notes for Claude Code](#notes-for-claude-code).

---

## Building the app

### Prerequisites

- **Node.js** 18+ and npm
- **Rust** stable (`rustup`) — Tauri's backend
- **Tauri 2.x** platform deps:
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Windows: Microsoft C++ Build Tools + WebView2 (preinstalled on Win11)
- See the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) for the current list per OS.

### Stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2.x (Rust + system webview) |
| Frontend | SolidJS + TypeScript + Vite |
| Styling | Plain CSS custom properties, light/dark via `prefers-color-scheme` |
| Local store | Folders + JSON on disk (no database) |
| Generation engine | ComfyUI (local endpoint) or cloud API |
| Training | ai-toolkit (local) or fal.ai (cloud) |

### Commands

```bash
npm install            # install frontend deps
npm run tauri dev      # run in development with hot reload
npm run tauri build    # produce a native binary (.dmg / .msi)
npm test               # run unit tests (routing logic, etc.)
```

The full architecture, data model, and ordered build plan live in [`CLAUDE.md`](./CLAUDE.md). Build in the 17 steps listed there, one at a time.

---

## Setting up the generation engine (ComfyUI)

This is required for the **local** backend. Skip it if you only use cloud. These steps are written to be executed directly (by you or by Claude Code, which should detect the OS and GPU and pick the right variant).

### 1. Install ComfyUI

**macOS / Linux:**

```bash
git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

PyTorch: on Apple Silicon, the default `pip install torch torchvision` uses the MPS backend. On NVIDIA, install the CUDA build matching your driver, e.g.:

```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
```

**Windows (NVIDIA):** the portable build is the least error-prone path. Download the portable ComfyUI release from the [ComfyUI repo](https://github.com/comfyanonymous/ComfyUI), unzip, and run `run_nvidia_gpu.bat`. Or clone and use a venv as above with the CUDA PyTorch wheel.

### 2. Install ComfyUI Manager

ComfyUI Manager installs models and custom nodes without hand-editing config. From `ComfyUI/custom_nodes/`:

```bash
git clone https://github.com/Comfy-Org/ComfyUI-Manager.git
```

Restart ComfyUI. The Manager button appears in the UI and is the easiest way to install everything below.

### 3. Download the image model

Pick the path for your card. **On 8GB (RTX 3070), use FLUX.1 dev (GGUF Q4_K_S).** FLUX.2 Dev needs ~18-24GB even quantized and will **not** run on 8GB; it is the 16GB+/cloud option.

#### 8GB (RTX 3070): FLUX.1 dev, GGUF Q4_K_S

FLUX.1 uses **two** text encoders (CLIP-L + T5) and the FLUX.1 VAE. On 8GB you load a quantized GGUF build via city96's loader node.

1. Install the GGUF custom node from `ComfyUI/custom_nodes/`:
   ```bash
   git clone https://github.com/city96/ComfyUI-GGUF.git
   pip install -r ComfyUI-GGUF/requirements.txt
   ```
2. Download four files into three folders (the verified 8GB set):
   ```
   ComfyUI/models/
     unet/            flux1-dev-Q4_K_S.gguf             # ~6.34GB diffusion model (GGUF)
     text_encoders/   t5-v1_1-xxl-encoder-Q5_K_M.gguf   # ~3.15GB quantized T5 (NOT fp16 ~9GB)
     text_encoders/   clip_l.safetensors                # ~235MB second encoder (FLUX is dual-encoder)
     vae/             ae.safetensors                    # ~335MB FLUX.1 VAE
   ```
   (Older ComfyUI puts encoders in `clip/` instead of `text_encoders/`.) Use **Unet Loader (GGUF)** for the diffusion model and **DualCLIPLoader (GGUF)** (type `flux`) for the two encoders.

> Exact filenames/links change — pull current ones at build time. Sources: diffusion model from the [city96/FLUX.1-dev-gguf](https://huggingface.co/city96/FLUX.1-dev-gguf) card; the T5 GGUF from [city96/t5-v1_1-xxl-encoder-gguf](https://huggingface.co/city96/t5-v1_1-xxl-encoder-gguf); `clip_l.safetensors` from [comfyanonymous/flux_text_encoders](https://huggingface.co/comfyanonymous/flux_text_encoders); and the FLUX.1 VAE `ae.safetensors` from the **ungated** [Comfy-Org/z_image_turbo](https://huggingface.co/Comfy-Org/z_image_turbo) mirror at `split_files/vae/ae.safetensors` (the official Black Forest Labs FLUX.1 repos gate the VAE behind a login).

**Operational notes for 8GB (important):**
- Launch ComfyUI with `--lowvram` (see step 5).
- Start at **768×768**; only go larger once that works.
- **Close background GPU apps first.** Browsers, Discord, and overlays can hold ~2.5GB of your 8GB — the difference between fitting and an out-of-memory error.
- FLUX sampling: **CFG/guidance 1.0**, **empty negative prompt**, sampler **euler** + scheduler **simple**, **20-30 steps**.

#### 16GB+ / 24GB (and cloud): FLUX.2 Dev

FLUX.2 needs **three** files in three folders. It uses a Mistral text encoder (not the old T5/CLIP) and a FLUX.2-specific VAE, repackaged in the `Comfy-Org/flux2-dev` Hugging Face repo in the layout ComfyUI expects.

```
ComfyUI/models/
  diffusion_models/   flux2_dev_fp8mixed.safetensors      # ~35GB FP8, fits 24GB cards
  text_encoders/      mistral_3_small_flux2_fp8.safetensors
  vae/                flux2-vae.safetensors
```

- **24GB+:** FP8 mixed (`flux2_dev_fp8mixed.safetensors`).
- **12-16GB:** FLUX.2 Dev FP8, or **FLUX.2 Klein 4B** (purpose-built for smaller cards; distilled, slightly lower fidelity ceiling).

FLUX.2 is also what the **cloud backend** uses, and it is the only path with native **multi-reference** (needed for the 2+ character routing case and for a single character without a trained LoRA). On 8GB local, those paths route to cloud.

> Download links and exact filenames change as Black Forest Labs and ComfyUI ship updates. Get current files from the [ComfyUI FLUX.2 Dev tutorial](https://docs.comfy.org/tutorials/flux/flux-2-dev) rather than hardcoding URLs.

### 4. Download the video models

Install via ComfyUI Manager (search the model name) or place weights per each repo's instructions. Both run image-to-video.

- **LTX-Video** (stylized, runs on 8GB): [Lightricks/LTX-Video](https://github.com/Lightricks/LTX-Video). Node pack: search "LTX" in ComfyUI Manager.
- **Wan 2.2** (photoreal, 14B wants 16GB+, 1.3B fits 8GB): node pack [ComfyUI-WanVideoWrapper (kijai)](https://github.com/kijai/ComfyUI-WanVideoWrapper).

### 5. Launch ComfyUI

```bash
# from the ComfyUI dir, venv active
python main.py --listen 127.0.0.1 --port 8188
# 8GB cards: add  --lowvram --cpu-vae
```

The API is now at `http://127.0.0.1:8188`. Confirm a manual generation works in the browser UI before pointing Scenecraft at it.

**FLUX-specific settings that trip people up:** CFG/guidance = 1.0 (FLUX uses embedded guidance; high CFG oversaturates), no negative prompt (FLUX ignores it), sampler `euler` + scheduler `simple`, 20-30 steps as the baseline. On 8GB, start at 768×768 and close background GPU apps first (see step 3).

### 6. Set up LoRA training (one-time per character)

**Local (ai-toolkit):**

```bash
git clone https://github.com/ostris/ai-toolkit.git
cd ai-toolkit
pip install -r requirements.txt
# Configure a FLUX.1 character LoRA training run (see ai-toolkit's FLUX config examples),
# point it at characters/<id>/refs/, output the .safetensors to characters/<id>/lora/
```

Local LoRA training is **impractical on 8GB VRAM + 16GB system RAM** — treat this local path as for 16GB+ cards. On 8GB, use the cloud (fal) trainer below; generation still runs locally.

**Cloud (fal.ai), the default for 8GB:** use fal's **FLUX.1 dev LoRA trainer** with your API key, then download the resulting `.safetensors` into the character's `lora/` folder. Match the trainer's base to what you generate on: for 8GB local generation that is **FLUX.1 dev**, so train a FLUX.1 LoRA (a FLUX.2 LoRA will not load on local FLUX.1). Pick the current trainer slug from [fal's model list](https://fal.ai/models) at build time. Scenecraft generates locally afterward; only the one-time training touched the cloud. (If you generate on FLUX.2 via the cloud backend, train a FLUX.2 LoRA instead.)

> NSFW note: the local FLUX.1 dev weights have no inference-time API filter and nothing is logged or transmitted, but the base Dev model ships trained on filtered data and is not built for explicit content. Community fine-tunes/LoRAs change that and load like any other LoRA. See [acceptable use](#consent-and-acceptable-use) for the hard limits that apply regardless of where you run.

---

## Configuring Scenecraft

Open Settings:

- **Backend:** Local or Cloud.
- **ComfyUI endpoint:** default `http://127.0.0.1:8188`. Can point at another machine on your network (e.g. app on Mac, ComfyUI on your NVIDIA PC).
- **Cloud keys:** stored in the OS keychain, never in plaintext config.
- **Training backend:** Local (ai-toolkit) or Cloud (fal).
- **Output folder.**

## Using Scenecraft

1. **Create a character.** Click "+ New character", name it, drop 20-30+ reference images, set type (photoreal/stylized).
2. **Train it.** Click Train. This is one-time. When done, the character shows a trained LoRA.
3. **Pick your cast.** Toggle one or more characters on in the left panel.
4. **Describe the scene.** Plain English. Don't type trigger tokens; the app injects them. Example: "walking along the Great Wall of China at sunrise, wide shot."
5. **Generate.** Choose image or video, click Generate. Outputs land in the gallery and your output folder.

Routing is automatic: one trained character uses its LoRA; two or more characters in one scene use multi-reference to avoid identity bleed.

## Cloud backend (optional)

Set Backend to Cloud and add keys. Image/training: Black Forest Labs or fal.ai. Video: Kling, Veo, or Runway. **Do not** expect Sora; it was discontinued (API ends Sept 24, 2026). Cloud providers filter content at inference and may log prompts/outputs per their terms; use Local for anything you want unfiltered and private.

---

## Notes for Claude Code

You are building this app from this repo. Workflow:

1. Read [`CLAUDE.md`](./CLAUDE.md) fully. It is the source of truth for architecture, data model, backend interfaces, routing logic, and the ordered 17-step build plan.
2. Build **one numbered step at a time.** Steps 1-7 produce a working UI against stubbed backends. Do not touch ComfyUI until step 8.
3. At step 8, follow [Setting up the generation engine](#setting-up-the-generation-engine-comfyui) on this machine: detect OS and GPU/VRAM, install ComfyUI, pick the model variant for the detected tier, get one manual image out before automating the client (FLUX.1 dev on 8GB; FLUX.2 on 16GB+).
4. The fast-moving specifics (FLUX.1/FLUX.2 node names, exact model filenames, current video node packs) should be pulled fresh from the linked ComfyUI/city96 docs at build time, not assumed from this README.
5. Keep the app's responsibility narrow: it talks to a ComfyUI endpoint and cloud APIs. It does not install or manage ComfyUI.
6. Honor the stack and conventions in `CLAUDE.md` (SolidJS prop access without destructuring, keys in the keychain, no telemetry).

To start: open a terminal in this folder, run Claude Code, and instruct it to begin at step 1 of the `CLAUDE.md` build plan.

---

## Consent and acceptable use

Scenecraft generates likenesses from user-supplied references. By using it you agree:

- Generate only likenesses you **own or have explicit consent** to use.
- **Never** generate sexual or intimate imagery of a real person without their consent. This is illegal in many jurisdictions.
- **Never** generate sexual content involving minors. This is illegal everywhere and absolutely prohibited. Running locally does not change this.
- You are solely responsible for the content you generate and for complying with the terms of any cloud provider you configure.

Running fully local removes provider content filters and logging; it does **not** remove these legal and ethical limits. They apply regardless of where generation happens.

## License

MIT. See [LICENSE](./LICENSE). The acceptable-use notice above is a usage disclosure and an in-app first-run acknowledgement, not a restriction on the code license.
