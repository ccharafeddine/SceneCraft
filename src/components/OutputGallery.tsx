import { createResource, For, Match, Show, Switch } from "solid-js";
import type { JobOutput, JobStatus } from "../backends/types";
import { readOutput, type SavedOutput } from "../lib/outputs";
import "./OutputGallery.css";

/** View model for a gallery item: an in-flight/just-finished job, and — once
 *  persisted — its saved metadata (which drives display + actions). */
export interface JobView {
  id: string;
  kind: "image" | "video" | "lora";
  prompt: string;
  status: JobStatus;
  createdAt: number;
  /** Session-only: the request used + which backend, so we can persist on done. */
  request?: unknown;
  backendName?: string;
  /** Present once written to disk. */
  saved?: SavedOutput;
}

interface GalleryProps {
  jobs: JobView[];
  outputFolder: string;
  onRerun: (saved: SavedOutput) => void;
  onDelete: (saved: SavedOutput) => void;
  onReveal: (saved: SavedOutput) => void;
  onAnimate: (saved: SavedOutput) => void;
  onRetry: (job: JobView) => void;
  onDismiss: (job: JobView) => void;
}

function mediaTag(url: string) {
  return url.startsWith("data:video/") ? (
    <video class="job__media-img" src={url} controls loop muted playsinline />
  ) : (
    <img class="job__media-img" src={url} alt="" />
  );
}

/** Render a JobOutput (in-session, before/without persistence). */
function OutputView(props: { output: JobOutput }) {
  const o = () => props.output;
  return (
    <>
      <Show
        when={o().url}
        fallback={<Show when={o().poster}>{mediaTag(o().poster!)}</Show>}
      >
        {mediaTag(o().url)}
      </Show>
      <Show when={o().type === "video"}>
        <span class="job__badge">clip</span>
      </Show>
    </>
  );
}

/** A persisted item: loads from disk, shows metadata + actions. */
function SavedCard(props: {
  saved: SavedOutput;
  folder: string;
  onRerun: (s: SavedOutput) => void;
  onDelete: (s: SavedOutput) => void;
  onReveal: (s: SavedOutput) => void;
  onAnimate: (s: SavedOutput) => void;
}) {
  const [src] = createResource(
    () => props.saved.filename,
    (f) => readOutput(props.folder, f),
  );
  const meta = () => {
    const r = props.saved.request;
    const bits = [
      `${r.width}×${r.height}`,
      `${r.steps} steps`,
      r.seed !== undefined ? `seed ${r.seed}` : null,
      r.baseModel,
    ].filter(Boolean);
    return bits.join(" · ");
  };
  return (
    <>
      <div class="job__media">
        <Show
          when={src()}
          fallback={
            <div class="job__progress-wrap">
              <span class="job__stage">Loading…</span>
            </div>
          }
        >
          {mediaTag(src()!)}
        </Show>
        <Show when={props.saved.kind === "video"}>
          <span class="job__badge">clip</span>
        </Show>
      </div>
      <div class="job__meta">
        <span class="job__kind">
          {props.saved.kind} · {props.saved.backend}
        </span>
        <span class="job__prompt" title={props.saved.prompt}>
          {props.saved.prompt}
        </span>
        <span class="job__submeta">{meta()}</span>
        <div class="job__actions">
          <Show when={props.saved.kind === "image"}>
            <button type="button" onClick={() => props.onAnimate(props.saved)}>Animate</button>
          </Show>
          <button type="button" onClick={() => props.onReveal(props.saved)}>Open location</button>
          <button type="button" onClick={() => props.onRerun(props.saved)}>Re-run</button>
          <button type="button" class="job__delete" onClick={() => props.onDelete(props.saved)}>
            Delete
          </button>
        </div>
      </div>
    </>
  );
}

/** An in-flight / just-finished (not-yet-persisted) job. */
function InFlightCard(props: {
  job: JobView;
  onRetry: (j: JobView) => void;
  onDismiss: (j: JobView) => void;
}) {
  const s = () => props.job.status;
  return (
    <>
      <div class="job__media">
        <Switch>
          <Match when={s().state === "error"}>
            <div class="job__error">{s().error ?? "Generation failed"}</div>
          </Match>
          <Match when={s().state === "done"}>
            <For each={s().outputs ?? []}>{(out) => <OutputView output={out} />}</For>
          </Match>
          <Match when={true}>
            <div class="job__progress-wrap">
              <div class="job__progress">
                <div
                  class="job__progress-bar"
                  style={{ width: `${Math.round(s().progress * 100)}%` }}
                />
              </div>
              <span class="job__stage">{s().message ?? s().state}</span>
            </div>
          </Match>
        </Switch>
      </div>
      <div class="job__meta">
        <span class="job__kind">{props.job.kind}</span>
        <span class="job__prompt" title={props.job.prompt}>
          {props.job.prompt}
        </span>
        <Show when={s().state === "error"}>
          <div class="job__actions">
            <Show when={props.job.request}>
              <button type="button" onClick={() => props.onRetry(props.job)}>Retry</button>
            </Show>
            <button type="button" class="job__delete" onClick={() => props.onDismiss(props.job)}>
              Dismiss
            </button>
          </div>
        </Show>
      </div>
    </>
  );
}

export function OutputGallery(props: GalleryProps) {
  return (
    <div class="gallery">
      <Show
        when={props.jobs.length > 0}
        fallback={<div class="gallery__empty">Your generations will appear here.</div>}
      >
        <div class="gallery__grid">
          <For each={props.jobs}>
            {(job) => (
              <div class="job">
                <Show
                  when={job.saved}
                  fallback={
                    <InFlightCard job={job} onRetry={props.onRetry} onDismiss={props.onDismiss} />
                  }
                >
                  <SavedCard
                    saved={job.saved!}
                    folder={props.outputFolder}
                    onRerun={props.onRerun}
                    onDelete={props.onDelete}
                    onReveal={props.onReveal}
                    onAnimate={props.onAnimate}
                  />
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
