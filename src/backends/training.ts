// TrainingBackend: two implementations behind one interface, chosen
// independently of the generation backend (a local-generation user can offload
// training to cloud).
//
//   - CloudTrainingBackend (fal): the default for 8GB. fal trains a FLUX.1 LoRA
//     (matching the local generation base). Uses the BYOK keychain.
//   - LocalTrainingBackend (ai-toolkit): impractical on 8GB; generates a config.
//
// On success the Rust command writes the .safetensors into the character's
// lora/ folder and flips character.json's lora_path — which unblocks the LoRA
// generation path. The editor reloads the character to show "Trained".
import { invoke } from "@tauri-apps/api/core";
import { modelById } from "../lib/models";
import type { Character } from "../lib/characters";
import type { JobHandle, JobStatus, TrainingBackend, TrainingRequest } from "./types";

/** A character needs at least this many references to train a usable LoRA. */
export const MIN_ALBUM = 10;
/** Default cloud training steps (fal FLUX.1 LoRA). */
const DEFAULT_STEPS = 1500;

export type TrainerMode = "local" | "cloud";

/** Cloud (fal) is the default below 16GB — local training is impractical there. */
export function recommendedTrainer(vramGb?: number): TrainerMode {
  if (vramGb === undefined) return "cloud";
  return vramGb >= 16 ? "local" : "cloud";
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `train-${Date.now().toString(36)}-${counter}`;
}

abstract class BaseTrainer {
  protected jobs = new Map<string, JobStatus>();
  async pollJob(id: string): Promise<JobStatus> {
    return this.jobs.get(id) ?? { id, state: "error", progress: 0, error: `unknown job '${id}'` };
  }
  protected albumGuard(id: string, req: TrainingRequest): boolean {
    if (req.refImagePaths.length < MIN_ALBUM) {
      this.jobs.set(id, {
        id,
        state: "error",
        progress: 0,
        error: `Add at least ${MIN_ALBUM} reference images before training (have ${req.refImagePaths.length}).`,
      });
      return false;
    }
    return true;
  }
}

export class CloudTrainingBackend extends BaseTrainer implements TrainingBackend {
  readonly name = "cloud";

  async startTraining(req: TrainingRequest): Promise<JobHandle> {
    const id = nextId();
    if (!this.albumGuard(id, req)) return { id, kind: "lora" };

    let hasKey = false;
    try {
      hasKey = await invoke<boolean>("has_api_key", { provider: "fal" });
    } catch {
      hasKey = false;
    }
    if (!hasKey) {
      this.jobs.set(id, {
        id,
        state: "error",
        progress: 0,
        error: "Add your fal.ai API key in Settings to use cloud training.",
      });
      return { id, kind: "lora" };
    }

    const trainer = modelById("flux1-dev")?.cloudTrainer;
    if (!trainer) {
      this.jobs.set(id, {
        id,
        state: "error",
        progress: 0,
        error: "No cloud trainer is configured in models.json.",
      });
      return { id, kind: "lora" };
    }

    this.jobs.set(id, { id, state: "running", progress: 0, message: "Training on fal… (minutes)" });
    invoke<Character>("train_cloud", {
      characterId: req.characterId,
      trigger: req.trigger,
      refImagePaths: req.refImagePaths,
      falModel: trainer.model,
      steps: DEFAULT_STEPS,
    })
      .then(() => this.jobs.set(id, { id, state: "done", progress: 1, message: "Trained" }))
      .catch((e) => this.jobs.set(id, { id, state: "error", progress: 0, error: String(e) }));

    return { id, kind: "lora" };
  }
}

export class LocalTrainingBackend extends BaseTrainer implements TrainingBackend {
  readonly name = "local";

  async startTraining(req: TrainingRequest): Promise<JobHandle> {
    const id = nextId();
    if (!this.albumGuard(id, req)) return { id, kind: "lora" };

    this.jobs.set(id, { id, state: "running", progress: 0, message: "Preparing local training…" });
    invoke<Character>("train_local", {
      characterId: req.characterId,
      trigger: req.trigger,
    })
      .then(() => this.jobs.set(id, { id, state: "done", progress: 1, message: "Trained" }))
      .catch((e) => this.jobs.set(id, { id, state: "error", progress: 0, error: String(e) }));

    return { id, kind: "lora" };
  }
}

export function trainerFor(mode: TrainerMode): TrainingBackend {
  return mode === "cloud" ? new CloudTrainingBackend() : new LocalTrainingBackend();
}
