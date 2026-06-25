// Typed access to the model registry (`models.json` at the repo root) — the
// single source of truth for model + hardware-tier facts. The local backend
// (which base model to request) and the connection/tier check (VRAM -> tier ->
// models) read through here instead of hardcoding. README's hardware-tiers
// table is kept in sync with the same registry.
import registry from "../../models.json";

export type ModelType = "image" | "video" | "encoder" | "vae";
export type Backend = "local" | "cloud";

export interface ModelSource {
  repo: string | null;
  filename: string | null;
}

/** Cloud provider facts (fal.ai), for models that have a cloud entry. */
export interface CloudFacts {
  provider: string;
  /** fal slug for plain text-to-image. */
  textModel: string;
  /** fal slug for image-with-references (multi-reference identity). */
  editModel: string;
}

export interface ModelEntry {
  id: string;
  name: string;
  type: ModelType;
  backends: Backend[];
  quant: string | null;
  minVramGb: number | null;
  source: ModelSource;
  targetFolder: string | null;
  graphTemplates: string[];
  cloud?: CloudFacts;
  sizeGb: number | null;
  verified: boolean;
  notes: string;
}

export interface Tier {
  id: string;
  label: string;
  minVramGb: number;
  imageModel: string;
  videoModels: string[];
  training: Backend;
  notes: string;
}

interface Registry {
  version: number;
  models: ModelEntry[];
  tiers: Tier[];
}

const reg = registry as unknown as Registry;

export const MODELS: ModelEntry[] = reg.models;
export const TIERS: Tier[] = reg.tiers;

export function modelById(id: string): ModelEntry | undefined {
  return MODELS.find((m) => m.id === id);
}

/** Best local tier the card's VRAM satisfies; the cloud tier if none do. */
export function tierForVram(vramGb: number): Tier {
  const local = TIERS.filter((t) => t.id !== "cloud" && t.minVramGb <= vramGb).sort(
    (a, b) => b.minVramGb - a.minVramGb,
  );
  return local[0] ?? TIERS.find((t) => t.id === "cloud")!;
}

/** Image model for a detected VRAM amount (8GB -> FLUX.1, 16GB+ -> FLUX.2). */
export function imageModelForVram(vramGb: number): ModelEntry {
  return modelById(tierForVram(vramGb).imageModel)!;
}

/**
 * Default local image model when VRAM is unknown: the smallest local tier
 * (8GB -> FLUX.1 dev). Replaced by `imageModelForVram` once the connection
 * check reads actual VRAM (Step 13).
 */
export function defaultLocalImageModel(): ModelEntry {
  const smallest = TIERS.filter((t) => t.id !== "cloud").sort(
    (a, b) => a.minVramGb - b.minVramGb,
  )[0];
  return modelById(smallest.imageModel)!;
}

/** Files a model needs on disk, resolved for download/placement. */
export function localFilesForTier(vramGb: number): ModelEntry[] {
  const tier = tierForVram(vramGb);
  const imageId = tier.imageModel;
  // The image model plus its encoders + vae that share a graph template.
  const img = modelById(imageId);
  if (!img) return [];
  const templates = new Set(img.graphTemplates);
  return MODELS.filter(
    (m) =>
      m.backends.includes("local") &&
      (m.id === imageId ||
        ((m.type === "encoder" || m.type === "vae") &&
          m.graphTemplates.some((t) => templates.has(t)))),
  );
}
