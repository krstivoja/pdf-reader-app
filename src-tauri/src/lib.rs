use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredPdf {
    id: String,
    name: String,
    size: u64,
    added_at: u64,
    current_page: usize,
}

fn library_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("library"))
        .map_err(|error| error.to_string())
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Invalid PDF id".into());
    }
    Ok(())
}

fn metadata_path(directory: &Path, id: &str) -> PathBuf {
    directory.join(format!("{id}.json"))
}

#[tauri::command]
fn save_pdf(app: AppHandle, name: String, bytes: Vec<u8>) -> Result<StoredPdf, String> {
    let directory = library_dir(&app)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos()
        .to_string();
    let name = Path::new(&name)
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .unwrap_or("Untitled PDF")
        .to_string();
    let stored_pdf = StoredPdf {
        id,
        name,
        size: bytes.len() as u64,
        added_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis() as u64,
        current_page: 0,
    };
    fs::write(directory.join(format!("{}.pdf", stored_pdf.id)), bytes)
        .map_err(|error| error.to_string())?;
    fs::write(
        metadata_path(&directory, &stored_pdf.id),
        serde_json::to_vec(&stored_pdf).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(stored_pdf)
}

#[tauri::command]
fn list_pdfs(app: AppHandle) -> Result<Vec<StoredPdf>, String> {
    let directory = library_dir(&app)?;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut pdfs = fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                == Some("json")
        })
        .filter_map(|entry| fs::read(entry.path()).ok())
        .filter_map(|bytes| serde_json::from_slice::<StoredPdf>(&bytes).ok())
        .collect::<Vec<_>>();
    pdfs.sort_by(|left, right| right.added_at.cmp(&left.added_at));
    Ok(pdfs)
}

#[tauri::command]
fn read_pdf(app: AppHandle, id: String) -> Result<Vec<u8>, String> {
    validate_id(&id)?;
    fs::read(library_dir(&app)?.join(format!("{id}.pdf"))).map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_pdf(app: AppHandle, id: String) -> Result<(), String> {
    validate_id(&id)?;
    let directory = library_dir(&app)?;
    for path in [
        directory.join(format!("{id}.pdf")),
        metadata_path(&directory, &id),
    ] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

#[tauri::command]
fn update_pdf_progress(app: AppHandle, id: String, current_page: usize) -> Result<(), String> {
    validate_id(&id)?;
    let directory = library_dir(&app)?;
    let path = metadata_path(&directory, &id);
    let mut stored_pdf: StoredPdf =
        serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    stored_pdf.current_page = current_page;
    fs::write(
        path,
        serde_json::to_vec(&stored_pdf).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            save_pdf,
            list_pdfs,
            read_pdf,
            remove_pdf,
            update_pdf_progress
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
