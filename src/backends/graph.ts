// Builds a ComfyUI image graph by parameterizing the proven FLUX.1 template
// (graphs/txt2img_flux.json — validated on the 3070 in Step 8) and injecting
// the cast conditioning produced by routing:
//
//   none    -> plain text-to-image (the path that works today)
//   lora    -> insert a LoraLoaderModelOnly + auto-inject the trigger token
//   multiref -> NOT runnable on FLUX.1 (no native multi-reference). Rejected
//               with a clear message; the cloud/16GB+ (FLUX.2) path plugs in
//               at Steps 10-12.
//
// Model filenames come from the registry (models.json), never hardcoded.
import graphTemplate from "../../graphs/txt2img_flux.json";
import ltxTemplate from "../../graphs/img2vid_ltx.json";
import { defaultLocalImageModel, modelById, MODELS } from "../lib/models";
import type { Conditioning, ImageRequest, VideoRequest } from "./types";

export interface GraphNode {
  class_type: string;
  inputs: Record<string, unknown>;
}
export type Graph = Record<string, GraphNode>;

export const MULTIREF_LOCAL_MESSAGE =
  "Multi-reference generation (an untrained character, or 2+ characters together) " +
  "isn't supported on FLUX.1 locally — it has no native multi-reference. Train the " +
  "character once to generate it locally with its LoRA, or switch to the Cloud backend " +
  "(FLUX.2) for multi-reference. (Cloud / 16GB+ path lands in Steps 10-12.)";

/** Thrown when the active cast needs a path FLUX.1 local can't run. */
export class LocalUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalUnsupportedError";
  }
}

/** ComfyUI lists models by their filename within a folder, so strip any path. */
function basename(path: string | null | undefined): string {
  return (path ?? "").split(/[\\/]/).pop() ?? "";
}

function findNodeId(graph: Graph, classType: string): string | undefined {
  return Object.entries(graph).find(([, n]) => n.class_type === classType)?.[0];
}

/** The positive prompt node = the CLIPTextEncode feeding FluxGuidance. */
function positiveNodeId(graph: Graph): string | undefined {
  const fluxGuidance = Object.values(graph).find((n) => n.class_type === "FluxGuidance");
  const ref = fluxGuidance?.inputs.conditioning as [string, number] | undefined;
  const id = ref?.[0];
  return id && graph[id]?.class_type === "CLIPTextEncode" ? id : undefined;
}

/**
 * Build the FLUX image graph. With `inputImageName` (an image already uploaded
 * to ComfyUI's input folder), it becomes img2img: the uploaded frame is encoded
 * to the starting latent and `denoise` controls how much it changes.
 */
export function buildImageGraph(req: ImageRequest, inputImageName?: string): Graph {
  if (req.conditioning.kind === "multiref") {
    // FLUX.1 local can't do this; surface it rather than build a wrong graph.
    throw new LocalUnsupportedError(MULTIREF_LOCAL_MESSAGE);
  }

  const graph = structuredClone(graphTemplate) as unknown as Graph;

  const image = modelById(req.baseModel) ?? defaultLocalImageModel();
  const t5 = MODELS.find(
    (m) => m.type === "encoder" && m.id.startsWith("t5") && m.backends.includes("local"),
  );
  const clip = modelById("clip-l");
  const vae = MODELS.find((m) => m.type === "vae" && m.backends.includes("local"));

  for (const node of Object.values(graph)) {
    switch (node.class_type) {
      case "UnetLoaderGGUF":
        node.inputs.unet_name = basename(image.source.filename);
        break;
      case "DualCLIPLoaderGGUF":
        node.inputs.clip_name1 = basename(t5?.source.filename);
        node.inputs.clip_name2 = basename(clip?.source.filename);
        break;
      case "VAELoader":
        node.inputs.vae_name = basename(vae?.source.filename);
        break;
      case "EmptySD3LatentImage":
        node.inputs.width = req.width;
        node.inputs.height = req.height;
        break;
      case "KSampler":
        node.inputs.seed = req.seed ?? Math.floor(Math.random() * 1_000_000_000_000);
        node.inputs.steps = req.steps;
        break;
    }
  }

  const posId = positiveNodeId(graph);
  if (posId) {
    graph[posId].inputs.text = req.prompt;
  }

  if (inputImageName) {
    injectImg2Img(graph, inputImageName, req.denoise ?? 0.7);
  }

  if (req.conditioning.kind === "lora") {
    injectLora(graph, req.conditioning, posId);
  }

  return graph;
}

/**
 * img2img: encode the uploaded frame to the starting latent (replacing the empty
 * latent) and set the sampler's denoise. denoise 1.0 ignores the input; lower
 * keeps more of it. The image is already uploaded to ComfyUI (LoadImage by name).
 */
function injectImg2Img(graph: Graph, inputImageName: string, denoise: number) {
  const vaeId = findNodeId(graph, "VAELoader");
  const ksId = findNodeId(graph, "KSampler");
  if (!vaeId || !ksId) return;

  const loadId = "img2img_load";
  const encId = "img2img_encode";
  graph[loadId] = { class_type: "LoadImage", inputs: { image: inputImageName } };
  graph[encId] = { class_type: "VAEEncode", inputs: { pixels: [loadId, 0], vae: [vaeId, 0] } };
  graph[ksId].inputs.latent_image = [encId, 0];
  graph[ksId].inputs.denoise = denoise;

  // The empty latent is now unused — drop it.
  const emptyId = findNodeId(graph, "EmptySD3LatentImage");
  if (emptyId) delete graph[emptyId];
}

/**
 * Single trained character: splice a LoraLoaderModelOnly between the UNet loader
 * and the sampler, and auto-prepend the trigger token to the prompt (the user
 * never types it). Untested end-to-end until a real `.safetensors` exists
 * (training, Step 14) and is placed in ComfyUI/models/loras/; the JSON is
 * correct and unit-tested now.
 */
function injectLora(graph: Graph, cond: Extract<Conditioning, { kind: "lora" }>, posId?: string) {
  const unetId = findNodeId(graph, "UnetLoaderGGUF");
  const ksId = findNodeId(graph, "KSampler");
  if (!unetId || !ksId) return;

  const loraId = "lora_model";
  graph[loraId] = {
    class_type: "LoraLoaderModelOnly",
    inputs: {
      model: [unetId, 0],
      lora_name: basename(cond.loraPath),
      strength_model: cond.strength,
    },
  };
  graph[ksId].inputs.model = [loraId, 0];

  if (posId) {
    const userText = String(graph[posId].inputs.text ?? "");
    graph[posId].inputs.text = [cond.trigger, userText].filter(Boolean).join(", ");
  }
}

// --- video (image-to-video) ---

/** Round to a multiple of 32 (LTX requires it), clamped to an 8GB-safe range. */
function round32(n: number, min = 256, max = 512): number {
  const clamped = Math.min(max, Math.max(min, n));
  return Math.max(min, Math.round(clamped / 32) * 32);
}

/** LTX frame count must be (n*8 + 1). Clamp to an 8GB-safe length. */
function ltxLength(frames: number): number {
  const n = Math.round((Math.min(97, Math.max(9, frames)) - 1) / 8);
  return n * 8 + 1;
}

/**
 * Two stages in one ComfyUI prompt: generate the identity-locked still (the
 * exact FLUX image graph, conditioning and all), then feed its decoded frame
 * straight into LTX img2vid. The models load sequentially, so 8GB never has to
 * hold both. The video model only adds motion — identity is solved at the
 * still. Reuses buildImageGraph, so character video inherits the same honest
 * routing: 0 chars -> plain still, trained LoRA -> lora still, multiref ->
 * throws (blocked). Verified end-to-end in Step 11.
 */
/** Fill the LTX template from the registry + request (everything but the input
 *  frame, which the caller wires). */
function fillLtxTemplate(req: VideoRequest): Graph {
  const ltx = structuredClone(ltxTemplate) as unknown as Graph;
  const ltxModel = modelById("ltx-video");
  const t5 = MODELS.find(
    (m) => m.type === "encoder" && m.id.startsWith("t5") && m.backends.includes("local"),
  );
  for (const node of Object.values(ltx)) {
    switch (node.class_type) {
      case "CheckpointLoaderSimple":
        node.inputs.ckpt_name = basename(ltxModel?.source.filename);
        break;
      case "CLIPLoaderGGUF":
        node.inputs.clip_name = basename(t5?.source.filename);
        break;
      case "LTXVImgToVideo":
        node.inputs.width = round32(req.width);
        node.inputs.height = round32(req.height);
        node.inputs.length = ltxLength(req.frames);
        break;
      case "LTXVConditioning":
        node.inputs.frame_rate = req.fps;
        break;
      case "SamplerCustom":
        node.inputs.noise_seed = req.seed ?? Math.floor(Math.random() * 1_000_000_000_000);
        break;
      case "SaveAnimatedWEBP":
        node.inputs.fps = req.fps;
        break;
    }
  }
  const i2v = Object.values(ltx).find((n) => n.class_type === "LTXVImgToVideo");
  const ltxPosRef = i2v?.inputs.positive as [string, number] | undefined;
  const ltxPosId = ltxPosRef?.[0];
  if (ltxPosId && ltx[ltxPosId]?.class_type === "CLIPTextEncode" && req.prompt) {
    ltx[ltxPosId].inputs.text = req.prompt;
  }
  return ltx;
}

/**
 * Image-to-video (LTX). Two sources for the input frame, same animate path:
 *   - `inputImageName` set: animate the user's uploaded frame directly (the
 *     image-input feature). Identity comes from the upload, so no still stage.
 *   - otherwise: generate the identity-locked FLUX still first, then animate it
 *     (text-to-video; the still inherits character conditioning).
 */
export function buildVideoGraph(req: VideoRequest, inputImageName?: string): Graph {
  if (req.videoModel !== "ltx") {
    // Wan (and any photoreal large model) is 16GB+/cloud, not local 8GB.
    throw new LocalUnsupportedError(
      "Local video is LTX-Video only. Wan (photoreal) needs a 16GB+ card or the " +
        "Cloud backend. Switch the video model to LTX for local generation.",
    );
  }

  const ltx = fillLtxTemplate(req);
  const i2v = findNodeId(ltx, "LTXVImgToVideo")!;

  if (inputImageName) {
    // Animate the uploaded frame directly — no FLUX still.
    const loadId = "video_load";
    ltx[i2v].inputs.image = [loadId, 0];
    return {
      [loadId]: { class_type: "LoadImage", inputs: { image: inputImageName } },
      ...ltx,
    };
  }

  // Text-to-video: FLUX still (inherits conditioning; throws for multiref) -> LTX.
  const still = buildImageGraph({
    prompt: req.prompt,
    conditioning: req.conditioning,
    baseModel: req.baseModel,
    width: req.width,
    height: req.height,
    steps: req.steps,
    seed: req.seed,
  });
  const saveId = findNodeId(still, "SaveImage");
  if (saveId) delete still[saveId];
  ltx[i2v].inputs.image = [findNodeId(still, "VAEDecode")!, 0];

  return { ...still, ...ltx };
}
