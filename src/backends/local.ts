// LocalBackend: talks to a ComfyUI endpoint set in settings (default
// 127.0.0.1:8188).
//
// Images and video are both real and local now:
//   - image: build the FLUX graph from the proven template + registry.
//   - video: build the two-stage still-then-animate graph (FLUX still -> LTX
//     img2vid in one prompt). One "Generate video" button; two stages under
//     the hood. The video model only adds motion — identity is solved at the
//     still, so the same routing/conditioning applies (multiref still blocked).
//
// Both paths POST a complete graph to the Rust `comfy_generate_image` command
// (POST /prompt -> poll /history -> GET /view), which returns whatever the
// graph produced — a PNG for image, an animated WEBP for video — as a data URL.
// Live step progress arrives over a WebSocket opened here.
import { invoke } from "@tauri-apps/api/core";
import type {
  GenerationBackend,
  ImageRequest,
  JobHandle,
  JobStatus,
  VideoRequest,
} from "./types";
import { buildImageGraph, buildVideoGraph, LocalUnsupportedError } from "./graph";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8188";

interface ComfyImageResult {
  data_url: string;
  filename: string;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

function messageFor(err: unknown): string {
  return err instanceof LocalUnsupportedError ? err.message : String(err);
}

export class LocalBackend implements GenerationBackend {
  readonly name = "local";
  private endpoint: string;
  private jobs = new Map<string, JobStatus>();
  private sockets = new Map<string, WebSocket>();

  constructor(endpoint: string = DEFAULT_ENDPOINT) {
    this.endpoint = endpoint;
  }

  /** Point at a different ComfyUI endpoint (from Settings). */
  setEndpoint(url: string) {
    this.endpoint = url.trim() || DEFAULT_ENDPOINT;
  }

  async generateImage(req: ImageRequest): Promise<JobHandle> {
    const id = nextId("img");
    try {
      const inputName = req.inputImage ? await this.upload(req.inputImage) : undefined;
      this.submit(id, buildImageGraph(req, inputName), "image");
    } catch (err) {
      this.jobs.set(id, { id, state: "error", progress: 0, error: messageFor(err) });
    }
    return { id, kind: "image" };
  }

  async generateVideo(req: VideoRequest): Promise<JobHandle> {
    const id = nextId("vid");
    try {
      const inputName = req.inputImage ? await this.upload(req.inputImage) : undefined;
      this.submit(id, buildVideoGraph(req, inputName), "video");
    } catch (err) {
      this.jobs.set(id, { id, state: "error", progress: 0, error: messageFor(err) });
    }
    return { id, kind: "video" };
  }

  /** Upload a data-URL image to ComfyUI's input folder; returns the filename
   *  a LoadImage node references. */
  private upload(dataUrl: string): Promise<string> {
    return invoke<string>("comfy_upload_image", { endpoint: this.endpoint, dataUrl });
  }

  async pollJob(id: string): Promise<JobStatus> {
    return this.jobs.get(id) ?? { id, state: "error", progress: 0, error: `unknown job '${id}'` };
  }

  /** Submit a complete graph: open progress WS, fire the Rust round-trip, and
   *  resolve the job to the returned image/clip (or an error). */
  private submit(id: string, graph: unknown, outputType: "image" | "video") {
    const clientId = crypto.randomUUID();
    this.jobs.set(id, { id, state: "queued", progress: 0, message: "Submitting" });
    this.openProgressSocket(id, clientId);

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
          outputs: [{ type: outputType, url: res.data_url }],
        });
      })
      .catch((err) => {
        this.jobs.set(id, { id, state: "error", progress: 0, error: String(err) });
      })
      .finally(() => this.closeSocket(id));
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
      /* progress is best-effort; the invoke still returns the final result */
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
