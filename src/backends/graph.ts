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
import { defaultLocalImageModel, modelById, MODELS } from "../lib/models";
import type { Conditioning, ImageRequest } from "./types";

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

export function buildImageGraph(req: ImageRequest): Graph {
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

  if (req.conditioning.kind === "lora") {
    injectLora(graph, req.conditioning, posId);
  }

  return graph;
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
