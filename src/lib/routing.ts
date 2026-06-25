// Identity + multi-character routing.
//
// Maps the active cast to a `Conditioning` the backend consumes. This is where
// the core fidelity decisions live (CLAUDE.md "Identity + routing logic"):
//
//   0 characters .......... plain text-to-image (no conditioning)
//   1, has a LoRA ......... inject LoRA + trigger token   (max fidelity, default)
//   1, no LoRA ............ multi-reference (up to 10 refs)
//   2+ characters ......... ALWAYS multi-reference, never stacked LoRAs
//                           (stacking LoRAs bleeds one identity onto another)
//
// Pure and side-effect free so it is trivially unit-testable. Paths it emits
// are relative to the characters root (`<id>/<rel>`); the backend resolves them
// to absolute paths against the machine running ComfyUI (Steps 9-10).

import type { Character } from "./characters";
import type { Conditioning } from "../backends/types";

export const MAX_MULTIREF = 10;

/**
 * Collect reference paths across the active characters, round-robin so every
 * character is represented, capped at `max`. For a single character this is
 * just its first `max` refs in order.
 */
export function collectRefs(active: Character[], max = MAX_MULTIREF): string[] {
  const out: string[] = [];
  let i = 0;
  // Keep cycling ref index until we hit the cap or every album is exhausted.
  for (;;) {
    let addedThisRound = false;
    for (const c of active) {
      if (i < c.ref_images.length) {
        out.push(`${c.id}/${c.ref_images[i]}`);
        addedThisRound = true;
        if (out.length >= max) return out;
      }
    }
    if (!addedThisRound) return out;
    i += 1;
  }
}

/** Decide how to condition a generation on the active cast. */
export function routeConditioning(active: Character[]): Conditioning {
  if (active.length === 0) {
    return { kind: "none" };
  }

  if (active.length === 1) {
    const c = active[0];
    if (c.lora_path) {
      return {
        kind: "lora",
        loraPath: `${c.id}/${c.lora_path}`,
        trigger: c.trigger,
        strength: c.lora_strength,
      };
    }
    return { kind: "multiref", refImagePaths: collectRefs(active) };
  }

  // 2+ characters in one frame: multi-reference only, to avoid identity bleed.
  return { kind: "multiref", refImagePaths: collectRefs(active) };
}
