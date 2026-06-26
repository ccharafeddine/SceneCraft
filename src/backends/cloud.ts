// CloudBackend: BYOK generation via fal.ai. Same GenerationBackend interface as
// LocalBackend, so the app/library/routing don't change — only the backend
// swaps. Cloud handles what FLUX.1 local can't: FLUX.2 multi-reference (group
// scenes, untrained-single via references).
//
// Keys live in the OS keychain and never enter JS — the Rust `cloud_generate_image`
// command reads the key itself and calls fal. Provider/model facts come from the
// registry (models.json). The video provider is intentionally left swappable and
// not wired yet (honest message). Sora is never wired (discontinued).
import { invoke } from "@tauri-apps/api/core";
import { modelById } from "../lib/models";
import type {
  GenerationBackend,
  ImageRequest,
  JobHandle,
  JobStatus,
  VideoRequest,
} from "./types";

interface CloudImageResult {
  data_url: string;
  filename: string;
}

const NO_KEY_MESSAGE = "Add your fal.ai API key in Settings to use the Cloud backend.";

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export class CloudBackend implements GenerationBackend {
  readonly name = "cloud";
  private jobs = new Map<string, JobStatus>();

  async generateImage(req: ImageRequest): Promise<JobHandle> {
    const id = nextId("cimg");
    this.jobs.set(id, { id, state: "queued", progress: 0, message: "Submitting to fal" });

    // No-key state: a clear, non-crashing pointer to Settings — never a fake result.
    const hasKey = await invoke<boolean>("has_api_key", { provider: "fal" }).catch(() => false);
    if (!hasKey) {
      this.jobs.set(id, { id, state: "error", progress: 0, error: NO_KEY_MESSAGE });
      return { id, kind: "image" };
    }

    const cloud = modelById("flux2-dev")?.cloud;
    if (!cloud) {
      this.jobs.set(id, {
        id,
        state: "error",
        progress: 0,
        error: "No cloud image model is configured in models.json.",
      });
      return { id, kind: "image" };
    }

    // multiref -> the edit model with reference images; otherwise text-to-image.
    const refImagePaths =
      req.conditioning.kind === "multiref" ? req.conditioning.refImagePaths : [];
    // Uploaded image (image-input feature) becomes a reference for FLUX.2.
    const refDataUrls = req.inputImage ? [req.inputImage] : [];
    const useEdit = refImagePaths.length > 0 || refDataUrls.length > 0;
    const model = useEdit ? cloud.editModel : cloud.textModel;

    this.jobs.set(id, { id, state: "running", progress: 0, message: "Generating on fal…" });
    invoke<CloudImageResult>("cloud_generate_image", {
      model,
      prompt: req.prompt,
      refImagePaths,
      refDataUrls,
      width: req.width,
      height: req.height,
      steps: req.steps,
      seed: req.seed ?? null,
    })
      .then((res) => {
        this.jobs.set(id, {
          id,
          state: "done",
          progress: 1,
          message: "Done",
          outputs: [{ type: "image", url: res.data_url }],
        });
      })
      .catch((err) => {
        this.jobs.set(id, { id, state: "error", progress: 0, error: String(err) });
      });

    return { id, kind: "image" };
  }

  async generateVideo(_req: VideoRequest): Promise<JobHandle> {
    const id = nextId("cvid");
    // Cloud video provider (Kling / Veo / Runway) is kept swappable and not
    // wired yet — an honest message, not a fake clip. Use Local (LTX) for video.
    this.jobs.set(id, {
      id,
      state: "error",
      progress: 0,
      error:
        "Cloud video isn't configured yet — a provider (Kling / Veo / Runway) plugs in here in a " +
        "later step. Use the Local backend (LTX) for video for now.",
    });
    return { id, kind: "video" };
  }

  async pollJob(id: string): Promise<JobStatus> {
    return this.jobs.get(id) ?? { id, state: "error", progress: 0, error: `unknown job '${id}'` };
  }
}
