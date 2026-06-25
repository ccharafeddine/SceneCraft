import { describe, expect, it } from "vitest";
import type { Character } from "./characters";
import { collectRefs, MAX_MULTIREF, routeConditioning } from "./routing";

function mkChar(id: string, over: Partial<Character> = {}): Character {
  return {
    id,
    name: id,
    type: "photoreal",
    trigger: `${id}_token`,
    lora_path: null,
    lora_strength: 0.9,
    base_model: "flux2-dev",
    ref_images: [],
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

/** N relative ref paths: refs/01.jpg, refs/02.jpg, ... */
const refs = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `refs/${String(i + 1).padStart(2, "0")}.jpg`);

describe("routeConditioning", () => {
  it("0 characters -> none (plain text-to-image)", () => {
    expect(routeConditioning([]).kind).toBe("none");
  });

  it("1 character with a LoRA -> lora + trigger token, paths rooted by id", () => {
    const c = mkChar("joe", {
      lora_path: "lora/joe.safetensors",
      lora_strength: 0.85,
      trigger: "j03",
      ref_images: refs(20),
    });
    const cond = routeConditioning([c]);
    expect(cond.kind).toBe("lora");
    if (cond.kind === "lora") {
      expect(cond.loraPath).toBe("joe/lora/joe.safetensors");
      expect(cond.trigger).toBe("j03");
      expect(cond.strength).toBe(0.85);
    }
  });

  it("1 character without a LoRA -> multiref, capped at 10 refs", () => {
    const c = mkChar("mia", { ref_images: refs(12) });
    const cond = routeConditioning([c]);
    expect(cond.kind).toBe("multiref");
    if (cond.kind === "multiref") {
      expect(cond.refImagePaths.length).toBe(MAX_MULTIREF);
      expect(cond.refImagePaths[0]).toBe("mia/refs/01.jpg");
      expect(cond.refImagePaths[9]).toBe("mia/refs/10.jpg");
    }
  });

  it("2+ characters -> multiref even when both have LoRAs (no identity bleed)", () => {
    const a = mkChar("a", { lora_path: "lora/a.safetensors", ref_images: refs(6) });
    const b = mkChar("b", { lora_path: "lora/b.safetensors", ref_images: refs(6) });
    const cond = routeConditioning([a, b]);
    expect(cond.kind).toBe("multiref");
    if (cond.kind === "multiref") {
      expect(cond.refImagePaths.length).toBe(10);
      // Balanced + interleaved: a/01, b/01, a/02, b/02, ...
      expect(cond.refImagePaths[0]).toBe("a/refs/01.jpg");
      expect(cond.refImagePaths[1]).toBe("b/refs/01.jpg");
      const aCount = cond.refImagePaths.filter((p) => p.startsWith("a/")).length;
      const bCount = cond.refImagePaths.filter((p) => p.startsWith("b/")).length;
      expect(aCount).toBe(5);
      expect(bCount).toBe(5);
    }
  });

  it("3 characters -> round-robin distribution (4/3/3)", () => {
    const cs = ["a", "b", "c"].map((id) => mkChar(id, { ref_images: refs(5) }));
    const cond = routeConditioning(cs);
    expect(cond.kind).toBe("multiref");
    if (cond.kind === "multiref") {
      expect(cond.refImagePaths.length).toBe(10);
      const count = (p: string) =>
        cond.refImagePaths.filter((x) => x.startsWith(p)).length;
      expect(count("a/")).toBe(4);
      expect(count("b/")).toBe(3);
      expect(count("c/")).toBe(3);
    }
  });

  it("single character with no LoRA and no refs -> empty multiref", () => {
    const cond = routeConditioning([mkChar("x")]);
    expect(cond.kind).toBe("multiref");
    if (cond.kind === "multiref") {
      expect(cond.refImagePaths).toEqual([]);
    }
  });
});

describe("collectRefs", () => {
  it("respects a custom cap and exhausts short albums", () => {
    const a = mkChar("a", { ref_images: refs(2) });
    const b = mkChar("b", { ref_images: refs(2) });
    expect(collectRefs([a, b], 3)).toEqual(["a/refs/01.jpg", "b/refs/01.jpg", "a/refs/02.jpg"]);
    // Only 4 refs exist total, so a cap of 10 returns all 4.
    expect(collectRefs([a, b], 10).length).toBe(4);
  });
});
