import { describe, expect, it } from "vitest";
import { buildImageGraph, type GraphNode } from "./graph";
import type { ImageRequest } from "./types";

const req: ImageRequest = {
  prompt: "a serene mountain lake at dawn",
  conditioning: { kind: "none" },
  baseModel: "flux1-dev",
  width: 832,
  height: 576,
  steps: 22,
  seed: 42,
};

describe("buildImageGraph (FLUX.1 template + registry)", () => {
  const g = buildImageGraph(req);
  const byClass = (c: string): GraphNode =>
    Object.values(g).find((n) => n.class_type === c)!;

  it("injects registry model filenames (basenamed to on-disk names)", () => {
    expect(byClass("UnetLoaderGGUF").inputs.unet_name).toBe("flux1-dev-Q4_K_S.gguf");
    expect(byClass("DualCLIPLoaderGGUF").inputs.clip_name1).toBe(
      "t5-v1_1-xxl-encoder-Q5_K_M.gguf",
    );
    expect(byClass("DualCLIPLoaderGGUF").inputs.clip_name2).toBe("clip_l.safetensors");
    // registry source is split_files/vae/ae.safetensors -> basename
    expect(byClass("VAELoader").inputs.vae_name).toBe("ae.safetensors");
  });

  it("applies request params (size, steps, seed, prompt)", () => {
    expect(byClass("EmptySD3LatentImage").inputs.width).toBe(832);
    expect(byClass("EmptySD3LatentImage").inputs.height).toBe(576);
    expect(byClass("KSampler").inputs.steps).toBe(22);
    expect(byClass("KSampler").inputs.seed).toBe(42);

    const fg = byClass("FluxGuidance");
    const posId = (fg.inputs.conditioning as [string, number])[0];
    expect(g[posId].class_type).toBe("CLIPTextEncode");
    expect(g[posId].inputs.text).toBe("a serene mountain lake at dawn");
  });

  it("preserves the proven FLUX settings (cfg 1.0, euler/simple, guidance 3.5)", () => {
    const ks = byClass("KSampler");
    expect(ks.inputs.cfg).toBe(1);
    expect(ks.inputs.sampler_name).toBe("euler");
    expect(ks.inputs.scheduler).toBe("simple");
    expect(byClass("FluxGuidance").inputs.guidance).toBe(3.5);
  });

  it("does not mutate the imported template across calls", () => {
    const a = buildImageGraph({ ...req, prompt: "first" });
    const b = buildImageGraph({ ...req, prompt: "second" });
    const textOf = (gr: typeof a) => {
      const fg = Object.values(gr).find((n) => n.class_type === "FluxGuidance")!;
      const id = (fg.inputs.conditioning as [string, number])[0];
      return gr[id].inputs.text;
    };
    expect(textOf(a)).toBe("first");
    expect(textOf(b)).toBe("second");
  });
});
