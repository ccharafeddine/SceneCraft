import { describe, expect, it } from "vitest";
import { buildImageGraph, buildVideoGraph, LocalUnsupportedError, type GraphNode } from "./graph";
import type { ImageRequest, VideoRequest } from "./types";

const base: Omit<ImageRequest, "conditioning"> = {
  prompt: "a serene mountain lake at dawn",
  baseModel: "flux1-dev",
  width: 832,
  height: 576,
  steps: 22,
  seed: 42,
};

const byClass = (g: Record<string, GraphNode>, c: string): GraphNode | undefined =>
  Object.values(g).find((n) => n.class_type === c);

describe("buildImageGraph — 0 characters (none) = plain text-to-image", () => {
  const g = buildImageGraph({ ...base, conditioning: { kind: "none" } });

  it("injects registry model filenames (basenamed to on-disk names)", () => {
    expect(byClass(g, "UnetLoaderGGUF")!.inputs.unet_name).toBe("flux1-dev-Q4_K_S.gguf");
    expect(byClass(g, "DualCLIPLoaderGGUF")!.inputs.clip_name1).toBe(
      "t5-v1_1-xxl-encoder-Q5_K_M.gguf",
    );
    expect(byClass(g, "DualCLIPLoaderGGUF")!.inputs.clip_name2).toBe("clip_l.safetensors");
    expect(byClass(g, "VAELoader")!.inputs.vae_name).toBe("ae.safetensors");
  });

  it("applies request params and the plain prompt", () => {
    expect(byClass(g, "EmptySD3LatentImage")!.inputs.width).toBe(832);
    expect(byClass(g, "KSampler")!.inputs.steps).toBe(22);
    expect(byClass(g, "KSampler")!.inputs.seed).toBe(42);
    const fg = byClass(g, "FluxGuidance")!;
    const posId = (fg.inputs.conditioning as [string, number])[0];
    expect(g[posId].inputs.text).toBe("a serene mountain lake at dawn");
  });

  it("has NO LoRA node and the sampler reads straight from the UNet loader", () => {
    expect(byClass(g, "LoraLoaderModelOnly")).toBeUndefined();
    const unetId = Object.entries(g).find(([, n]) => n.class_type === "UnetLoaderGGUF")![0];
    expect(byClass(g, "KSampler")!.inputs.model).toEqual([unetId, 0]);
  });

  it("preserves the proven FLUX settings (cfg 1.0, euler/simple, guidance 3.5)", () => {
    const ks = byClass(g, "KSampler")!;
    expect(ks.inputs.cfg).toBe(1);
    expect(ks.inputs.sampler_name).toBe("euler");
    expect(ks.inputs.scheduler).toBe("simple");
    expect(byClass(g, "FluxGuidance")!.inputs.guidance).toBe(3.5);
  });
});

describe("buildImageGraph — 1 trained character (lora) injects LoRA + trigger", () => {
  // Hypothetical trained character (no real .safetensors exists yet — JSON only).
  const g = buildImageGraph({
    ...base,
    conditioning: {
      kind: "lora",
      loraPath: "joe/lora/joe.safetensors",
      trigger: "j03_token",
      strength: 0.85,
    },
  });

  it("splices a LoraLoaderModelOnly between the UNet loader and the sampler", () => {
    const lora = byClass(g, "LoraLoaderModelOnly");
    expect(lora).toBeDefined();
    const unetId = Object.entries(g).find(([, n]) => n.class_type === "UnetLoaderGGUF")![0];
    // LoRA reads the UNet; sampler now reads the LoRA, not the UNet directly.
    expect(lora!.inputs.model).toEqual([unetId, 0]);
    const loraId = Object.entries(g).find(([, n]) => n.class_type === "LoraLoaderModelOnly")![0];
    expect(byClass(g, "KSampler")!.inputs.model).toEqual([loraId, 0]);
  });

  it("uses the LoRA basename and strength from the registry/character", () => {
    const lora = byClass(g, "LoraLoaderModelOnly")!;
    expect(lora.inputs.lora_name).toBe("joe.safetensors");
    expect(lora.inputs.strength_model).toBe(0.85);
  });

  it("auto-prepends the trigger token to the prompt (user never types it)", () => {
    const fg = byClass(g, "FluxGuidance")!;
    const posId = (fg.inputs.conditioning as [string, number])[0];
    expect(g[posId].inputs.text).toBe("j03_token, a serene mountain lake at dawn");
  });
});

describe("buildImageGraph — multi-reference is rejected on FLUX.1 local", () => {
  it("throws LocalUnsupportedError for a single untrained character / 2+ characters", () => {
    expect(() =>
      buildImageGraph({
        ...base,
        conditioning: { kind: "multiref", refImagePaths: ["mia/refs/01.jpg"] },
      }),
    ).toThrow(LocalUnsupportedError);
  });

  it("the message points at training or the cloud backend", () => {
    try {
      buildImageGraph({ ...base, conditioning: { kind: "multiref", refImagePaths: [] } });
      throw new Error("should have thrown");
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/Train the character|Cloud backend/);
    }
  });
});

const videoBase: VideoRequest = {
  prompt: "a lighthouse on a cliff at sunset",
  conditioning: { kind: "none" },
  baseModel: "flux1-dev",
  width: 768,
  height: 768,
  steps: 20,
  seed: 7,
  videoModel: "ltx",
  frames: 49,
  fps: 24,
};

describe("buildVideoGraph — 0 characters: LTX still-then-animate", () => {
  const g = buildVideoGraph(videoBase);
  const has = (c: string) => Object.values(g).some((n) => n.class_type === c);

  it("contains both stages (FLUX still + LTX img2vid + clip output)", () => {
    expect(has("UnetLoaderGGUF")).toBe(true);
    expect(has("LTXVImgToVideo")).toBe(true);
    expect(has("SaveAnimatedWEBP")).toBe(true);
  });

  it("feeds the still's decoded frame into LTX (identity solved at the still)", () => {
    const i2v = byClass(g, "LTXVImgToVideo")!;
    const imgRef = i2v.inputs.image as [string, number];
    expect(g[imgRef[0]].class_type).toBe("VAEDecode");
  });

  it("drops the still's SaveImage so the only image output is the clip", () => {
    expect(has("SaveImage")).toBe(false);
  });

  it("pulls the LTX model from the registry and reuses the T5 GGUF", () => {
    expect(byClass(g, "CheckpointLoaderSimple")!.inputs.ckpt_name).toBe(
      "ltxv-2b-0.9.8-distilled-fp8.safetensors",
    );
    expect(byClass(g, "CLIPLoaderGGUF")!.inputs.clip_name).toBe(
      "t5-v1_1-xxl-encoder-Q5_K_M.gguf",
    );
  });

  it("clamps LTX length to (n*8+1) and dimensions to /32", () => {
    const i2v = byClass(g, "LTXVImgToVideo")!;
    expect(((i2v.inputs.length as number) - 1) % 8).toBe(0);
    expect((i2v.inputs.width as number) % 32).toBe(0);
    expect((i2v.inputs.height as number) % 32).toBe(0);
  });
});

describe("buildVideoGraph — Wan / character video rejected locally", () => {
  it("Wan video throws (16GB+ / cloud only)", () => {
    expect(() => buildVideoGraph({ ...videoBase, videoModel: "wan" })).toThrow(
      LocalUnsupportedError,
    );
  });

  it("untrained / 2+ character video throws via the still (multiref)", () => {
    expect(() =>
      buildVideoGraph({
        ...videoBase,
        conditioning: { kind: "multiref", refImagePaths: ["a/refs/01.jpg"] },
      }),
    ).toThrow(LocalUnsupportedError);
  });
});
