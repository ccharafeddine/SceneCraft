import { createSignal, For, Show } from "solid-js";
import type { Character } from "../lib/characters";
import type { VideoModel } from "../backends/types";
import "./PromptPanel.css";

export interface GenerateInput {
  prompt: string;
  mode: "image" | "video";
  width: number;
  height: number;
  steps: number;
  videoModel: VideoModel;
  frames: number;
  fps: number;
}

interface PromptPanelProps {
  activeCharacters: Character[];
  onGenerate: (input: GenerateInput) => void;
}

const SIZE_PRESETS = [
  { label: "Square · 768", w: 768, h: 768 },
  { label: "Square · 1024", w: 1024, h: 1024 },
  { label: "Portrait · 768×1024", w: 768, h: 1024 },
  { label: "Landscape · 1024×768", w: 1024, h: 768 },
  { label: "Small · 512", w: 512, h: 512 },
];

export function PromptPanel(props: PromptPanelProps) {
  const [prompt, setPrompt] = createSignal("");
  const [mode, setMode] = createSignal<"image" | "video">("image");
  const [showSettings, setShowSettings] = createSignal(false);
  const [sizeIdx, setSizeIdx] = createSignal(0);
  const [steps, setSteps] = createSignal(20);
  const [videoModel, setVideoModel] = createSignal<VideoModel>("ltx");
  const [frames, setFrames] = createSignal(49);
  const [fps] = createSignal(24);

  const canGenerate = () =>
    prompt().trim().length > 0 || props.activeCharacters.length > 0;

  // FLUX.1 local can only generate a character that has a trained LoRA, and only
  // one at a time. Anything else (untrained, or 2+) needs cloud/16GB+ FLUX.2.
  const localBlocked = () => {
    const cast = props.activeCharacters;
    if (cast.length === 0) return false;
    if (cast.length === 1 && cast[0].lora_path) return false;
    return true;
  };

  function submit() {
    if (!canGenerate()) return;
    const size = SIZE_PRESETS[sizeIdx()];
    props.onGenerate({
      prompt: prompt().trim(),
      mode: mode(),
      width: size.w,
      height: size.h,
      steps: steps(),
      videoModel: videoModel(),
      frames: frames(),
      fps: fps(),
    });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <section class="prompt">
      {/* Active cast is auto-injected into the generation by routing; the user
          never types trigger tokens. */}
      <div class="prompt__cast">
        <Show
          when={props.activeCharacters.length > 0}
          fallback={<span class="prompt__cast-hint">No characters active — plain text-to-image.</span>}
        >
          <span class="prompt__cast-label">In scene:</span>
          <For each={props.activeCharacters}>
            {(c) => <span class="chip">{c.name}</span>}
          </For>
        </Show>
      </div>

      <Show when={localBlocked()}>
        <p class="prompt__warning">
          FLUX.1 (local) can't render this cast: a character needs a trained LoRA, and
          only one at a time. Untrained or 2+ characters need the Cloud backend (FLUX.2).
          Train the character, or generate with none active for plain text-to-image.
        </p>
      </Show>

      <textarea
        class="prompt__box"
        placeholder="Describe the scene… e.g. walking along the Great Wall at sunrise, wide shot"
        rows={3}
        value={prompt()}
        onInput={(e) => setPrompt(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />

      <div class="prompt__controls">
        <div class="segmented" role="tablist">
          <button
            type="button"
            class="segmented__btn"
            classList={{ "segmented__btn--active": mode() === "image" }}
            onClick={() => setMode("image")}
          >
            Image
          </button>
          <button
            type="button"
            class="segmented__btn"
            classList={{ "segmented__btn--active": mode() === "video" }}
            onClick={() => setMode("video")}
          >
            Video
          </button>
        </div>

        <button type="button" class="prompt__disclosure" onClick={() => setShowSettings((v) => !v)}>
          {showSettings() ? "Hide" : "Output settings"}
        </button>

        <span class="prompt__spacer" />

        <button type="button" class="btn btn--primary" disabled={!canGenerate()} onClick={submit}>
          {mode() === "image" ? "Generate image" : "Generate video"}
        </button>
      </div>

      <Show when={showSettings()}>
        <div class="settings-grid">
          <label class="field-row">
            <span class="field-row__label">Size</span>
            <select
              class="field"
              value={sizeIdx()}
              onChange={(e) => setSizeIdx(Number(e.currentTarget.value))}
            >
              <For each={SIZE_PRESETS}>
                {(p, i) => <option value={i()}>{p.label}</option>}
              </For>
            </select>
          </label>

          <label class="field-row">
            <span class="field-row__label">Steps <span class="field-row__value">{steps()}</span></span>
            <input
              class="slider"
              type="range"
              min="1"
              max="50"
              step="1"
              value={steps()}
              onInput={(e) => setSteps(Number(e.currentTarget.value))}
            />
          </label>

          <Show when={mode() === "video"}>
            <label class="field-row">
              <span class="field-row__label">Video model</span>
              <select
                class="field"
                value={videoModel()}
                onChange={(e) => setVideoModel(e.currentTarget.value as VideoModel)}
              >
                <option value="ltx">LTX-Video (stylized)</option>
                <option value="wan">Wan 2.2 (photoreal)</option>
              </select>
            </label>

            <label class="field-row">
              <span class="field-row__label">
                Length <span class="field-row__value">{frames()}f · {(frames() / fps()).toFixed(1)}s</span>
              </span>
              <input
                class="slider"
                type="range"
                min="9"
                max="121"
                step="4"
                value={frames()}
                onInput={(e) => setFrames(Number(e.currentTarget.value))}
              />
            </label>
          </Show>
        </div>
      </Show>
    </section>
  );
}
