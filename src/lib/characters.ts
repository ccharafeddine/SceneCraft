// Typed wrappers around the Rust `characters` commands. Every component talks
// to disk through this module, never `invoke` directly.
//
// Tauri v2 maps camelCase argument keys from JS to snake_case Rust params, so
// `char_type` is passed as `charType` and `ref_path` as `refPath`.
import { invoke } from "@tauri-apps/api/core";

export type CharacterType = "photoreal" | "stylized";

/** Mirrors the Rust `Character` struct / `character.json` on disk. */
export interface Character {
  id: string;
  name: string;
  type: CharacterType;
  trigger: string;
  lora_path: string | null;
  lora_strength: number;
  base_model: string;
  ref_images: string[];
  created_at: string;
}

export function listCharacters(): Promise<Character[]> {
  return invoke("list_characters");
}

export function getCharacter(id: string): Promise<Character> {
  return invoke("get_character", { id });
}

export function createCharacter(
  name: string,
  type: CharacterType,
  trigger?: string,
): Promise<Character> {
  return invoke("create_character", {
    name,
    charType: type,
    trigger: trigger ?? null,
  });
}

export function updateCharacter(character: Character): Promise<Character> {
  return invoke("update_character", { character });
}

export function deleteCharacter(id: string): Promise<void> {
  return invoke("delete_character", { id });
}

export function importRefs(id: string, paths: string[]): Promise<Character> {
  return invoke("import_refs", { id, paths });
}

export function setThumb(id: string, refPath: string): Promise<void> {
  return invoke("set_thumb", { id, refPath });
}

export function getThumbnail(id: string): Promise<string | null> {
  return invoke("get_thumbnail", { id });
}

export function getRefImage(id: string, refPath: string): Promise<string | null> {
  return invoke("get_ref_image", { id, refPath });
}
