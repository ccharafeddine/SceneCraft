// LocalBackend: talks to a ComfyUI endpoint set in settings.
//
// STUB (Step 5): returns fake, progressing jobs via the shared simulator. The
// real client (POST /prompt, WebSocket progress, /history + /view, and the
// /system_stats health check) is implemented in Step 9. The app never owns
// ComfyUI's lifecycle; it only talks to an endpoint that already exists.
import type {
  GenerationBackend,
  ImageRequest,
  JobHandle,
  JobStatus,
  VideoRequest,
} from "./types";
import { SimulatedJobs } from "./stub";

export class LocalBackend implements GenerationBackend {
  readonly name = "local";
  private sim = new SimulatedJobs("Local (stub)");

  async generateImage(req: ImageRequest): Promise<JobHandle> {
    return this.sim.enqueueImage(req);
  }

  async generateVideo(req: VideoRequest): Promise<JobHandle> {
    return this.sim.enqueueVideo(req);
  }

  async pollJob(id: string): Promise<JobStatus> {
    return this.sim.poll(id);
  }
}
