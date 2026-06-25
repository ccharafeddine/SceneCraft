import { For, Match, Show, Switch } from "solid-js";
import type { JobOutput, JobStatus } from "../backends/types";
import "./OutputGallery.css";

/** View model for a job tracked in the gallery. */
export interface JobView {
  id: string;
  kind: "image" | "video";
  prompt: string;
  status: JobStatus;
  createdAt: number;
}

function OutputView(props: { output: JobOutput }) {
  const o = () => props.output;
  return (
    <Show
      when={o().type === "video"}
      fallback={<img class="job__media-img" src={o().url} alt="" />}
    >
      <Show
        when={o().url}
        fallback={
          <div class="job__video-stub">
            <Show when={o().poster}>
              <img class="job__media-img" src={o().poster!} alt="" />
            </Show>
            <span class="job__badge">video</span>
          </div>
        }
      >
        <video class="job__media-img" src={o().url} controls />
      </Show>
    </Show>
  );
}

function JobCard(props: { job: JobView }) {
  const s = () => props.job.status;
  return (
    <div class="job">
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
      </div>
    </div>
  );
}

export function OutputGallery(props: { jobs: JobView[] }) {
  return (
    <div class="gallery">
      <Show
        when={props.jobs.length > 0}
        fallback={<div class="gallery__empty">Your generations will appear here.</div>}
      >
        <div class="gallery__grid">
          <For each={props.jobs}>{(job) => <JobCard job={job} />}</For>
        </div>
      </Show>
    </div>
  );
}
