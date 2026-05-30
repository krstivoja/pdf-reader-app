use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredBook {
    id: String,
    name: String,
    size: u64,
    added_at: u64,
    current_page: usize,
    #[serde(default = "default_book_format")]
    format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thumbnail: Option<String>,
    #[serde(default)]
    bookmarks: Vec<usize>,
}

fn default_book_format() -> String {
    "pdf".into()
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
        return Err("Invalid book id".into());
    }
    Ok(())
}

fn metadata_path(directory: &Path, id: &str) -> PathBuf {
    directory.join(format!("{id}.json"))
}

fn validate_format(format: &str) -> Result<(), String> {
    if matches!(format, "pdf" | "epub") {
        Ok(())
    } else {
        Err("Unsupported book format".into())
    }
}

fn book_path(directory: &Path, id: &str, format: &str) -> PathBuf {
    directory.join(format!("{id}.{format}"))
}

fn read_metadata(directory: &Path, id: &str) -> Result<StoredBook, String> {
    serde_json::from_slice(
        &fs::read(metadata_path(directory, id)).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_book(
    app: AppHandle,
    name: String,
    format: String,
    bytes: Vec<u8>,
) -> Result<StoredBook, String> {
    validate_format(&format)?;
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
        .unwrap_or("Untitled book")
        .to_string();
    let stored_book = StoredBook {
        id,
        name,
        size: bytes.len() as u64,
        added_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis() as u64,
        current_page: 0,
        format,
        thumbnail: None,
        bookmarks: Vec::new(),
    };
    fs::write(
        book_path(&directory, &stored_book.id, &stored_book.format),
        bytes,
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        metadata_path(&directory, &stored_book.id),
        serde_json::to_vec(&stored_book).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(stored_book)
}

#[tauri::command]
fn list_books(app: AppHandle) -> Result<Vec<StoredBook>, String> {
    let directory = library_dir(&app)?;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut books = fs::read_dir(directory)
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
        .filter_map(|bytes| serde_json::from_slice::<StoredBook>(&bytes).ok())
        .collect::<Vec<_>>();
    books.sort_by(|left, right| right.added_at.cmp(&left.added_at));
    Ok(books)
}

#[tauri::command]
fn read_book(app: AppHandle, id: String) -> Result<Vec<u8>, String> {
    validate_id(&id)?;
    let directory = library_dir(&app)?;
    let stored_book = read_metadata(&directory, &id)?;
    validate_format(&stored_book.format)?;
    fs::read(book_path(&directory, &id, &stored_book.format)).map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_book(app: AppHandle, id: String) -> Result<(), String> {
    validate_id(&id)?;
    let directory = library_dir(&app)?;
    for path in [
        directory.join(format!("{id}.epub")),
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
fn update_book_progress(app: AppHandle, id: String, current_page: usize) -> Result<(), String> {
    validate_id(&id)?;
    let directory = library_dir(&app)?;
    let path = metadata_path(&directory, &id);
    let mut stored_book: StoredBook = read_metadata(&directory, &id)?;
    stored_book.current_page = current_page;
    fs::write(
        path,
        serde_json::to_vec(&stored_book).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn update_book_thumbnail(app: AppHandle, id: String, thumbnail: String) -> Result<(), String> {
    validate_id(&id)?;
    if !thumbnail.starts_with("data:image/") {
        return Err("Invalid book thumbnail".into());
    }
    let directory = library_dir(&app)?;
    let path = metadata_path(&directory, &id);
    let mut stored_book: StoredBook = read_metadata(&directory, &id)?;
    stored_book.thumbnail = Some(thumbnail);
    fs::write(
        path,
        serde_json::to_vec(&stored_book).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn update_book_bookmarks(
    app: AppHandle,
    id: String,
    mut bookmarks: Vec<usize>,
) -> Result<(), String> {
    validate_id(&id)?;
    bookmarks.sort_unstable();
    bookmarks.dedup();
    let directory = library_dir(&app)?;
    let path = metadata_path(&directory, &id);
    let mut stored_book: StoredBook = read_metadata(&directory, &id)?;
    stored_book.bookmarks = bookmarks;
    fs::write(
        path,
        serde_json::to_vec(&stored_book).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            save_book,
            list_books,
            read_book,
            remove_book,
            update_book_progress,
            update_book_thumbnail,
            update_book_bookmarks
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
