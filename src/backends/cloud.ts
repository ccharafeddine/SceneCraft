// CloudBackend: BYOK generation via provider APIs (image/training via Black
// Forest Labs or fal.ai; video via Kling/Veo/Runway). Keys live in the OS
// keychain, never in plaintext config. Sora is intentionally NOT wired
// (discontinued).
//
// STUB (Step 5): returns fake, progressing jobs via the shared simulator. The
// real BYOK clients + keychain storage land in Step 12.
import type {
  GenerationBackend,
  ImageRequest,
  JobHandle,
  JobStatus,
  VideoRequest,
} from "./types";
import { SimulatedJobs } from "./stub";

export class CloudBackend implements GenerationBackend {
  readonly name = "cloud";
  private sim = new SimulatedJobs("Cloud (stub)");

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
