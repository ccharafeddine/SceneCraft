// Builds a ComfyUI image graph by parameterizing the proven FLUX.1 template
// (graphs/txt2img_flux.json — the exact graph validated on the 3070 in Step 8).
// Model filenames come from the registry (models.json), not hardcoded strings;
// only the prompt, seed, size, and steps vary per request. No LoRA / multi-ref
// yet — plain text-to-image (Step 9).
import graphTemplate from "../../graphs/txt2img_flux.json";
import { defaultLocalImageModel, modelById, MODELS } from "../lib/models";
import type { ImageRequest } from "./types";

export interface GraphNode {
  class_type: string;
  inputs: Record<string, unknown>;
}
export type Graph = Record<string, GraphNode>;

/** ComfyUI lists models by their filename within a folder, so strip any path. */
function basename(path: string | null | undefined): string {
  return (path ?? "").split(/[\\/]/).pop() ?? "";
}

export function buildImageGraph(req: ImageRequest): Graph {
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

  // Positive prompt = the CLIPTextEncode node feeding FluxGuidance.
  const fluxGuidance = Object.values(graph).find((n) => n.class_type === "FluxGuidance");
  const posRef = fluxGuidance?.inputs.conditioning as [string, number] | undefined;
  const posId = posRef?.[0];
  if (posId && graph[posId]?.class_type === "CLIPTextEncode") {
    graph[posId].inputs.text = req.prompt;
  }

  return graph;
}
