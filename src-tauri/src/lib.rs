mod characters;
mod comfy;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            characters::create_character,
            characters::list_characters,
            characters::get_character,
            characters::update_character,
            characters::delete_character,
            characters::import_refs,
            characters::set_thumb,
            characters::get_thumbnail,
            characters::get_ref_image,
            comfy::comfy_health,
            comfy::comfy_generate_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
