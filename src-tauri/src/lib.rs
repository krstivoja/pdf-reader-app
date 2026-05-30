use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const TTS_LOG_MAX_BYTES: u64 = 1_000_000;
const TTS_RESTART_DELAY: Duration = Duration::from_secs(2);

#[derive(Default)]
struct TtsInner {
    child: Option<Child>,
    port: Option<u16>,
    log_path: Option<PathBuf>,
    last_error: Option<String>,
    stopping: bool,
}

struct TtsProcess(Mutex<TtsInner>);

impl Drop for TtsProcess {
    fn drop(&mut self) {
        stop_tts(self);
    }
}

fn stop_tts(process: &TtsProcess) {
    let (child, log_path) = {
        let mut inner = process.0.lock().unwrap();
        inner.stopping = true;
        inner.port = None;
        (inner.child.take(), inner.log_path.clone())
    };
    if let Some(mut child) = child {
        append_tts_log(&log_path, "Stopping voice engine");
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn append_tts_log(log_path: &Option<PathBuf>, message: &str) {
    let Some(log_path) = log_path else {
        return;
    };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "[{}] {message}", unix_timestamp());
    }
}

fn tts_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_log_dir()
        .map(|directory| directory.join("tts.log"))
        .map_err(|error| error.to_string())
}

fn open_tts_log(app: &AppHandle) -> Result<(File, PathBuf), String> {
    let log_path = tts_log_path(app)?;
    if let Some(directory) = log_path.parent() {
        fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    }
    if fs::metadata(&log_path)
        .map(|metadata| metadata.len() > TTS_LOG_MAX_BYTES)
        .unwrap_or(false)
    {
        let backup = log_path.with_extension("log.1");
        let _ = fs::remove_file(&backup);
        fs::rename(&log_path, backup).map_err(|error| error.to_string())?;
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| error.to_string())?;
    Ok((file, log_path))
}

// The koko binary was built against espeak-rs which bakes the espeak-ng-data
// path at compile time. The build directory was on /private/tmp and is now
// gone. Until we rebuild koko with a runtime-configurable path, we recreate
// that exact directory and symlink it to the data we bundle inside the .app.
const BAKED_ESPEAK_PATH: &str =
    "/private/tmp/tts-build/kokoros/target/release/build/espeak-rs-sys-0f013096c4de56bb/out/share/espeak-ng-data";

fn ensure_espeak_data_at_baked_path(bundled_data: &Path) -> Result<(), String> {
    let baked = PathBuf::from(BAKED_ESPEAK_PATH);
    if let Ok(metadata) = fs::symlink_metadata(&baked) {
        if metadata.file_type().is_symlink() {
            if let Ok(target) = fs::read_link(&baked) {
                if target == bundled_data {
                    return Ok(());
                }
            }
            let _ = fs::remove_file(&baked);
        } else if metadata.is_dir() {
            return Ok(());
        } else {
            let _ = fs::remove_file(&baked);
        }
    }
    if let Some(parent) = baked.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("create espeak parent: {error}"))?;
    }
    std::os::unix::fs::symlink(bundled_data, &baked)
        .map_err(|error| format!("symlink espeak data: {error}"))
}

fn available_tts_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Could not reserve a voice engine port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Could not inspect the voice engine port: {error}"))
}

fn spawn_tts(app: &AppHandle) -> Result<(Child, u16, PathBuf), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("resources")
        .join("tts");
    let binary = resource_dir.join("koko");
    let model = resource_dir.join("model.onnx");
    let voices = resource_dir.join("voices.bin");
    let espeak_data = resource_dir.join("espeak-ng-data");
    for path in [&binary, &model, &voices, &espeak_data] {
        if !path.exists() {
            return Err(format!(
                "Voice engine resource missing at {}",
                path.display()
            ));
        }
    }
    ensure_espeak_data_at_baked_path(&espeak_data)?;
    let port = available_tts_port()?;
    let (mut log, log_path) = open_tts_log(app)?;
    let _ = writeln!(
        log,
        "[{}] Starting voice engine on 127.0.0.1:{port}",
        unix_timestamp()
    );
    let stderr = log.try_clone().map_err(|error| error.to_string())?;
    let child = Command::new(&binary)
        .env("PIPER_ESPEAKNG_DATA_DIRECTORY", &espeak_data)
        .arg("--model")
        .arg(&model)
        .arg("--data")
        .arg(&voices)
        .args(["--style", "af_kore", "openai", "--ip", "127.0.0.1", "--port"])
        .arg(port.to_string())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| format!("Could not start voice engine: {error}"))?;
    Ok((child, port, log_path))
}

fn record_tts_error(app: &AppHandle, process: &TtsProcess, error: String) {
    let log_path = tts_log_path(app).ok();
    append_tts_log(&log_path, &error);
    let mut inner = process.0.lock().unwrap();
    inner.log_path = log_path;
    inner.last_error = Some(error);
}

fn start_tts(app: &AppHandle, process: &TtsProcess) -> Result<(), String> {
    let (mut child, port, log_path) = spawn_tts(app)?;
    let mut inner = process.0.lock().unwrap();
    if inner.stopping {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Voice engine shutdown is already in progress".into());
    }
    inner.child = Some(child);
    inner.port = Some(port);
    inner.log_path = Some(log_path);
    inner.last_error = None;
    Ok(())
}

fn monitor_tts(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(TTS_RESTART_DELAY);
        let state = app.state::<TtsProcess>();
        let (restart, log_path, event) = {
            let mut inner = state.0.lock().unwrap();
            if inner.stopping {
                return;
            }
            let event = match inner.child.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => Some(format!("Voice engine exited unexpectedly: {status}")),
                    Ok(None) => None,
                    Err(error) => Some(format!("Could not inspect voice engine process: {error}")),
                },
                None => Some("Voice engine is not running".into()),
            };
            if let Some(error) = &event {
                inner.child = None;
                inner.port = None;
                inner.last_error = Some(error.clone());
            }
            (event.is_some(), inner.log_path.clone(), event)
        };
        if let Some(event) = event {
            append_tts_log(&log_path, &event);
        }
        if restart {
            append_tts_log(&log_path, "Restarting voice engine");
            if let Err(error) = start_tts(&app, &state) {
                record_tts_error(&app, &state, error);
            }
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TtsStatus {
    running: bool,
    port: Option<u16>,
    log_path: Option<String>,
    last_error: Option<String>,
}

#[tauri::command]
fn tts_status(state: tauri::State<'_, TtsProcess>) -> TtsStatus {
    let inner = state.0.lock().unwrap();
    TtsStatus {
        running: inner.child.is_some(),
        port: inner.port,
        log_path: inner
            .log_path
            .as_ref()
            .map(|path| path.display().to_string()),
        last_error: inner.last_error.clone(),
    }
}

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

fn cache_path(directory: &Path, id: &str) -> PathBuf {
    directory.join(format!("{id}.cache.json"))
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
        cache_path(&directory, &id),
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

#[tauri::command]
fn read_book_cache(app: AppHandle, id: String) -> Result<Option<String>, String> {
    validate_id(&id)?;
    let path = cache_path(&library_dir(&app)?, &id);
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn write_book_cache(app: AppHandle, id: String, data: String) -> Result<(), String> {
    validate_id(&id)?;
    let directory = library_dir(&app)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::write(cache_path(&directory, &id), data).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(TtsProcess(Mutex::new(TtsInner::default())))
        .setup(|app| {
            let handle = app.handle().clone();
            let state = handle.state::<TtsProcess>();
            if let Err(error) = start_tts(&handle, &state) {
                eprintln!("TTS startup failed: {error}");
                record_tts_error(&handle, &state, error);
            }
            monitor_tts(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.try_state::<TtsProcess>() {
                    stop_tts(&state);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            save_book,
            list_books,
            read_book,
            remove_book,
            update_book_progress,
            update_book_thumbnail,
            update_book_bookmarks,
            read_book_cache,
            write_book_cache,
            tts_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
