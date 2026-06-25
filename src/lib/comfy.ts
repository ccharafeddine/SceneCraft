// Connection check for the local ComfyUI engine: ping /system_stats (via the
// Rust comfy_health command), read GPU + VRAM, and map it to a hardware tier
// from the registry so the user knows what's runnable. The app never manages
// ComfyUI — on failure it points at the README.
import { invoke } from "@tauri-apps/api/core";
import { modelById, tierForVram, type Tier } from "./models";

interface SystemStats {
  system?: { comfyui_version?: string };
  devices?: Array<{ name?: string; type?: string; vram_total?: number }>;
}

export interface ComfyStatus {
  ok: boolean;
  error?: string;
  version?: string;
  gpu?: string;
  vramGb?: number;
  tier?: Tier;
  imageModelName?: string;
}

/** Trim ComfyUI's verbose device label to just the GPU name. */
function cleanGpu(name: string | undefined): string | undefined {
  return name
    ?.replace(/^cuda:\d+\s*/i, "")
    .replace(/\s*:\s*cudaMallocAsync$/i, "")
    .trim();
}

export async function checkComfy(endpoint: string): Promise<ComfyStatus> {
  try {
    const stats = await invoke<SystemStats>("comfy_health", { endpoint });
    const dev = stats.devices?.find((d) => d.type && d.type !== "cpu") ?? stats.devices?.[0];
    const vramGb = dev?.vram_total ? dev.vram_total / 1024 ** 3 : undefined;
    const tier = vramGb !== undefined ? tierForVram(Math.round(vramGb)) : undefined;
    return {
      ok: true,
      version: stats.system?.comfyui_version,
      gpu: cleanGpu(dev?.name),
      vramGb,
      tier,
      imageModelName: tier ? modelById(tier.imageModel)?.name : undefined,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
