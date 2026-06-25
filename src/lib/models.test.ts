import { describe, expect, it } from "vitest";
import {
  defaultLocalImageModel,
  imageModelForVram,
  localFilesForTier,
  MODELS,
  modelById,
  tierForVram,
} from "./models";

describe("model registry tier selection", () => {
  it("8GB -> 8gb tier -> FLUX.1 dev", () => {
    expect(tierForVram(8).id).toBe("8gb");
    expect(imageModelForVram(8).id).toBe("flux1-dev");
  });

  it("12-16GB -> 16gb tier -> FLUX.2", () => {
    expect(tierForVram(16).id).toBe("16gb");
    expect(imageModelForVram(16).id).toBe("flux2-dev");
  });

  it("24GB -> 24gb tier -> FLUX.2", () => {
    expect(tierForVram(24).id).toBe("24gb");
    expect(imageModelForVram(24).id).toBe("flux2-dev");
  });

  it("below 8GB falls back to the cloud tier", () => {
    expect(tierForVram(6).id).toBe("cloud");
  });

  it("default local image model (unknown VRAM) is FLUX.1 dev", () => {
    expect(defaultLocalImageModel().id).toBe("flux1-dev");
  });
});

describe("model registry facts", () => {
  it("FLUX.1 set targets the correct ComfyUI folders and verified sources", () => {
    expect(modelById("flux1-dev")!.targetFolder).toBe("models/unet");
    expect(modelById("t5xxl-q5km")!.targetFolder).toBe("models/text_encoders");
    expect(modelById("clip-l")!.targetFolder).toBe("models/text_encoders");
    expect(modelById("flux1-vae")!.source.repo).toBe("Comfy-Org/z_image_turbo");
  });

  it("8GB local file set is the verified four (image + 2 encoders + vae)", () => {
    const ids = localFilesForTier(8).map((m) => m.id).sort();
    expect(ids).toEqual(["clip-l", "flux1-dev", "flux1-vae", "t5xxl-q5km"]);
    expect(localFilesForTier(8).every((m) => m.verified)).toBe(true);
  });

  it("FLUX.2 is the cloud/16GB+ entry and supports multi-reference", () => {
    const f2 = modelById("flux2-dev")!;
    expect(f2.backends).toContain("cloud");
    expect(f2.graphTemplates).toContain("txt2img_flux_multiref");
  });

  it("every model has the required registry fields", () => {
    for (const m of MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(["image", "video", "encoder", "vae"]).toContain(m.type);
      expect(m.backends.length).toBeGreaterThan(0);
      expect(m.graphTemplates.length).toBeGreaterThan(0);
    }
  });
});
