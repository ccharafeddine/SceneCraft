// Persisted outputs: every generation is saved to the chosen folder as a real
// file with a metadata sidecar, so the gallery survives restarts and supports
// re-run / open-location / delete. Keys/secrets are never involved.
import { invoke } from "@tauri-apps/api/core";
import type { ImageRequest, VideoRequest } from "../backends/types";

export interface SavedOutput {
  id: string;
  filename: string;
  kind: "image" | "video";
  prompt: string;
  backend: string;
  created_at: string;
  /** The full request used, for faithful re-run. */
  request: ImageRequest | VideoRequest;
}

export function defaultOutputFolder(): Promise<string> {
  return invoke("default_output_folder");
}

export function saveOutput(
  folder: string,
  dataUrl: string,
  kind: "image" | "video",
  prompt: string,
  backend: string,
  request: ImageRequest | VideoRequest,
): Promise<SavedOutput> {
  return invoke("save_output", { folder, dataUrl, kind, prompt, backend, request });
}

export function listOutputs(folder: string): Promise<SavedOutput[]> {
  return invoke("list_outputs", { folder });
}

export function readOutput(folder: string, filename: string): Promise<string> {
  return invoke("read_output", { folder, filename });
}

export function deleteOutput(folder: string, filename: string): Promise<void> {
  return invoke("delete_output", { folder, filename });
}

export function revealOutput(folder: string, filename: string): Promise<void> {
  return invoke("reveal_output", { folder, filename });
}

/** Free space (GB) on the output folder's drive. */
export function diskFreeGb(folder: string): Promise<number> {
  return invoke("disk_free_gb", { folder });
}
