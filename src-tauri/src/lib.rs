mod characters;
mod cloud;
mod comfy;
mod keychain;
mod outputs;
mod training;

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
            comfy::comfy_upload_image,
            keychain::set_api_key,
            keychain::has_api_key,
            keychain::delete_api_key,
            cloud::cloud_generate_image,
            training::train_cloud,
            training::train_local,
            outputs::save_output,
            outputs::list_outputs,
            outputs::read_output,
            outputs::delete_output,
            outputs::default_output_folder,
            outputs::reveal_output,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
