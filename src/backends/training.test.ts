import { describe, expect, it } from "vitest";
import {
  CloudTrainingBackend,
  LocalTrainingBackend,
  MIN_ALBUM,
  recommendedTrainer,
  trainerFor,
} from "./training";
import type { TrainingRequest } from "./types";

function req(refCount: number): TrainingRequest {
  return {
    characterId: "joe",
    refImagePaths: Array.from({ length: refCount }, (_, i) => `joe/refs/${i}.jpg`),
    trigger: "j03_token",
    baseModel: "flux1-dev",
  };
}

describe("recommendedTrainer", () => {
  it("defaults to cloud below 16GB (8GB) and when VRAM is unknown", () => {
    expect(recommendedTrainer(8)).toBe("cloud");
    expect(recommendedTrainer(undefined)).toBe("cloud");
  });
  it("allows local at 16GB+", () => {
    expect(recommendedTrainer(16)).toBe("local");
    expect(recommendedTrainer(24)).toBe("local");
  });
});

describe("trainerFor", () => {
  it("returns the matching backend implementation", () => {
    expect(trainerFor("cloud").name).toBe("cloud");
    expect(trainerFor("local").name).toBe("local");
  });
});

describe("training guards (no fake results)", () => {
  it("cloud: too-small album fails with a clear, actionable message", async () => {
    const t = new CloudTrainingBackend();
    const h = await t.startTraining(req(3));
    const s = await t.pollJob(h.id);
    expect(s.state).toBe("error");
    expect(s.error).toMatch(new RegExp(`at least ${MIN_ALBUM}`));
  });

  it("local: too-small album fails with a clear message", async () => {
    const t = new LocalTrainingBackend();
    const h = await t.startTraining(req(5));
    const s = await t.pollJob(h.id);
    expect(s.state).toBe("error");
    expect(s.error).toMatch(new RegExp(`at least ${MIN_ALBUM}`));
  });

  it("cloud: a full album with no fal key points at Settings (no key in test env)", async () => {
    // invoke() has no Tauri host in the test env, so has_api_key resolves false.
    const t = new CloudTrainingBackend();
    const h = await t.startTraining(req(20));
    const s = await t.pollJob(h.id);
    expect(s.state).toBe("error");
    expect(s.error).toMatch(/fal\.ai API key/);
  });
});
