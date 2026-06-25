// Backend contracts. The character library and prompt flow are identical
// regardless of which backend is active; only these implementations differ.
//
// Real implementations arrive later:
//   - LocalBackend (ComfyUI client) ....... Step 9
//   - CloudBackend (BYOK) ................. Step 12
//   - TrainingBackend (ai-toolkit / fal) .. Step 14
// Step 5 ships the interfaces plus stubs that return fake, progressing jobs.

export type BackendMode = "local" | "cloud";

/** How a generation is conditioned on the active cast (decided by routing, Step 7). */
export type Conditioning =
  /** No active characters: plain text-to-image. */
  | { kind: "none" }
  /** Exactly one character with a trained LoRA: max fidelity. */
  | { kind: "lora"; loraPath: string; trigger: string; strength: number }
  /** One character without a LoRA, or 2+ characters: multi-reference. */
  | { kind: "multiref"; refImagePaths: string[] };

export interface ImageRequest {
  prompt: string;
  conditioning: Conditioning;
  baseModel: string; // "flux1-dev" (local default) or "flux2-dev" (cloud/16GB+)
  width: number;
  height: number;
  steps: number;
  /** Omitted -> backend picks a random seed. */
  seed?: number;
}

export type VideoModel = "ltx" | "wan";

/**
 * Image-to-video. The backend runs the two-stage flow internally: generate an
 * identity-locked still (same conditioning as an image), then animate it. The
 * user sees one "Generate video" action.
 */
export interface VideoRequest {
  prompt: string;
  conditioning: Conditioning;
  baseModel: string;
  width: number;
  height: number;
  steps: number; // still stage
  seed?: number;
  videoModel: VideoModel;
  frames: number; // length in frames (length seconds = frames / fps)
  fps: number;
}

export interface JobHandle {
  id: string;
  kind: "image" | "video";
}

export type JobState = "queued" | "running" | "done" | "error";

export interface JobOutput {
  type: "image" | "video" | "lora";
  /** Displayable image/video src (data URL, asset URL, or file path). Empty for a stub video. */
  url: string;
  /** Optional still frame for a video. */
  poster?: string;
}

export interface JobStatus {
  id: string;
  state: JobState;
  /** 0..1 */
  progress: number;
  /** Human-readable stage or error summary. */
  message?: string;
  /** Present when state === "done". */
  outputs?: JobOutput[];
  /** Present when state === "error". */
  error?: string;
}

/** The heart of the app: one interface, two implementations behind a toggle. */
export interface GenerationBackend {
  /** Stable label for display/logging, e.g. "local" or "cloud". */
  readonly name: string;
  generateImage(req: ImageRequest): Promise<JobHandle>;
  /** Image-to-video; two-stage still-then-animate handled internally. */
  generateVideo(req: VideoRequest): Promise<JobHandle>;
  pollJob(id: string): Promise<JobStatus>;
}

export interface TrainingRequest {
  characterId: string;
  /** Absolute paths to the album images to compile. */
  refImagePaths: string[];
  trigger: string;
  baseModel: string;
}

/**
 * One-time-per-character LoRA training. Chosen independently of the generation
 * backend, so a fully-local generation user can still offload training to cloud.
 * On success the job's output is a `lora` written into the character's folder.
 * Implemented in Step 14.
 */
export interface TrainingBackend {
  readonly name: string;
  startTraining(req: TrainingRequest): Promise<JobHandle>;
  pollJob(id: string): Promise<JobStatus>;
}
