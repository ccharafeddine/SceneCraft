// Shared fake-job engine for the Step 5 backend stubs. It simulates the
// queued -> running -> done lifecycle over a few seconds and produces a
// visible placeholder so Step 6's gallery + progress bars have something real
// to render. Deleted once the real Local (Step 9) and Cloud (Step 12) backends
// land.
import type {
  ImageRequest,
  JobHandle,
  JobOutput,
  JobStatus,
  VideoRequest,
} from "./types";

interface SimJob {
  id: string;
  kind: "image" | "video";
  startedAt: number;
  durationMs: number;
  req: ImageRequest | VideoRequest;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** A neutral placeholder image (SVG data URL) labelled as a stub. */
function placeholderSvg(job: SimJob, backendLabel: string): string {
  const req = job.req as ImageRequest;
  const w = req.width || 768;
  const h = req.height || 768;
  const promptRaw = job.req.prompt.trim() || "(no prompt)";
  const prompt = escapeXml(
    promptRaw.length > 48 ? promptRaw.slice(0, 47) + "…" : promptRaw,
  );
  const kindLabel = job.kind === "video" ? "VIDEO (stub)" : "IMAGE (stub)";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="100%" height="100%" fill="#2a2d34"/>
  <text x="50%" y="42%" fill="#7c8089" font-family="sans-serif" font-size="${Math.round(w / 16)}" font-weight="700" text-anchor="middle">${kindLabel}</text>
  <text x="50%" y="52%" fill="#9aa0aa" font-family="sans-serif" font-size="${Math.round(w / 26)}" text-anchor="middle">${escapeXml(backendLabel)}</text>
  <text x="50%" y="60%" fill="#6b7079" font-family="sans-serif" font-size="${Math.round(w / 30)}" text-anchor="middle">${prompt}</text>
  <text x="50%" y="66%" fill="#5a5f68" font-family="sans-serif" font-size="${Math.round(w / 34)}" text-anchor="middle">${w}×${h}</text>
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export class SimulatedJobs {
  private jobs = new Map<string, SimJob>();

  constructor(private backendLabel: string) {}

  enqueueImage(req: ImageRequest): JobHandle {
    const id = nextId("img");
    this.jobs.set(id, {
      id,
      kind: "image",
      startedAt: Date.now(),
      durationMs: 2500,
      req,
    });
    return { id, kind: "image" };
  }

  enqueueVideo(req: VideoRequest): JobHandle {
    const id = nextId("vid");
    this.jobs.set(id, {
      id,
      kind: "video",
      startedAt: Date.now(),
      durationMs: 5000,
      req,
    });
    return { id, kind: "video" };
  }

  poll(id: string): JobStatus {
    const job = this.jobs.get(id);
    if (!job) {
      return { id, state: "error", progress: 0, error: `unknown job '${id}'` };
    }
    const elapsed = Date.now() - job.startedAt;
    const progress = Math.min(1, elapsed / job.durationMs);

    if (elapsed < 400) {
      return { id, state: "queued", progress: 0, message: "Queued" };
    }
    if (progress < 1) {
      const message =
        job.kind === "video"
          ? progress < 0.5
            ? "Generating identity-locked still"
            : "Animating"
          : "Generating image";
      return { id, state: "running", progress, message };
    }
    return {
      id,
      state: "done",
      progress: 1,
      message: "Done",
      outputs: [this.output(job)],
    };
  }

  private output(job: SimJob): JobOutput {
    const placeholder = placeholderSvg(job, this.backendLabel);
    return job.kind === "video"
      ? { type: "video", url: "", poster: placeholder }
      : { type: "image", url: placeholder };
  }
}
