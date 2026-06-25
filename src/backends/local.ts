// LocalBackend: talks to a ComfyUI endpoint set in settings (default
// 127.0.0.1:8188).
//
// Images are real (Step 9): the graph is built from the proven FLUX.1 template
// + registry, the HTTP round-trip (POST /prompt -> poll /history -> GET /view)
// runs in Rust (`comfy_generate_image`) to dodge webview CORS, and live step
// progress arrives over a WebSocket opened here. Video stays on the simulator
// until a later step. LoRA / multi-reference conditioning is not wired yet.
import { invoke } from "@tauri-apps/api/core";
import type {
  GenerationBackend,
  ImageRequest,
  JobHandle,
  JobStatus,
  VideoRequest,
} from "./types";
import { buildImageGraph } from "./graph";
import { SimulatedJobs } from "./stub";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8188";

interface ComfyImageResult {
  data_url: string;
  filename: string;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `img-${Date.now().toString(36)}-${counter}`;
}

export class LocalBackend implements GenerationBackend {
  readonly name = "local";
  private endpoint: string;
  private video = new SimulatedJobs("Local video (stub)");
  private jobs = new Map<string, JobStatus>();
  private sockets = new Map<string, WebSocket>();

  constructor(endpoint: string = DEFAULT_ENDPOINT) {
    this.endpoint = endpoint;
  }

  async generateImage(req: ImageRequest): Promise<JobHandle> {
    const id = nextId();
    const clientId = crypto.randomUUID();
    this.jobs.set(id, { id, state: "queued", progress: 0, message: "Submitting" });

    const graph = buildImageGraph(req);
    this.openProgressSocket(id, clientId);

    // Fire the (blocking) Rust round-trip; resolve/reject updates job state.
    // Not awaited here so the call returns a handle immediately, matching the
    // poll-based interface the UI already drives.
    invoke<ComfyImageResult>("comfy_generate_image", {
      endpoint: this.endpoint,
      graph,
      clientId,
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
      })
      .finally(() => this.closeSocket(id));

    return { id, kind: "image" };
  }

  async generateVideo(req: VideoRequest): Promise<JobHandle> {
    // Video still uses the simulator; the real i2v flow lands in a later step.
    return this.video.enqueueVideo(req);
  }

  async pollJob(id: string): Promise<JobStatus> {
    return this.jobs.get(id) ?? this.video.poll(id);
  }

  /** Best-effort live progress: ComfyUI routes a job's messages to the WS that
   *  shares its clientId. Failure here never blocks the final result. */
  private openProgressSocket(jobId: string, clientId: string) {
    try {
      const wsUrl = `${this.endpoint.replace(/^http/, "ws")}/ws?clientId=${clientId}`;
      const ws = new WebSocket(wsUrl);
      this.sockets.set(jobId, ws);
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return; // skip binary preview frames
        let msg: { type?: string; data?: { value?: number; max?: number; node?: unknown } };
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        const cur = this.jobs.get(jobId);
        if (!cur || cur.state === "done" || cur.state === "error") return;
        if (msg.type === "progress" && msg.data && typeof msg.data.max === "number") {
          const value = msg.data.value ?? 0;
          const max = msg.data.max || 1;
          this.jobs.set(jobId, {
            ...cur,
            state: "running",
            progress: value / max,
            message: `Step ${value}/${max}`,
          });
        } else if (msg.type === "executing" && msg.data?.node) {
          this.jobs.set(jobId, { ...cur, state: "running", message: cur.message ?? "Running" });
        }
      };
      ws.onerror = () => {
        /* progress is best-effort */
      };
    } catch {
      /* progress is best-effort; the invoke still returns the final image */
    }
  }

  private closeSocket(jobId: string) {
    const ws = this.sockets.get(jobId);
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      this.sockets.delete(jobId);
    }
  }
}
