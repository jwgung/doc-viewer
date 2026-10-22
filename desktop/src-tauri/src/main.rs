// 윈도우 셸: 창 하나에 문서를 탭으로 연다. 사용자가 연 파일만 번호를 붙여 doc 스킴으로 웹 렌더러에 내주고,
// 폴더 탐색기는 사용자가 고른 폴더 아래만 읽는다.
// 주소 규칙은 Android ViewerWebClient와 같다: <주소>?length → 길이, ?start=&end= → 구간(end 미포함), 그 밖에는 파일 전체.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod detect;

use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

use serde::{Deserialize, Serialize};
use tauri::{
    http::{header, Request, Response, StatusCode},
    AppHandle, DragDropEvent, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

// WebView2는 사용자 스킴을 http://<스킴>.localhost로 부른다. 웹 렌더러 CSP도 이 출처를 허용한다(scripts/build-front.js).
#[cfg(windows)]
const DOC_ORIGIN: &str = "http://doc.localhost";
#[cfg(not(windows))]
const DOC_ORIGIN: &str = "doc://localhost";
#[cfg(windows)]
const APP_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(windows))]
const APP_ORIGIN: &str = "tauri://localhost";

const MAIN_WINDOW: &str = "main";
/// 마지막으로 연 폴더를 적어 두는 파일(앱 설정 폴더 안)
const FOLDER_FILE: &str = "folder.txt";
/// 닫을 때 열려 있던 탭(파일 경로와 탭마다 보던 상태)을 적어 두는 파일(앱 설정 폴더 안)
const SESSION_FILE: &str = "session.json";

#[derive(Default)]
struct Documents {
    next_id: AtomicU64,
    /// 탭에 열린 문서(번호 → 파일). doc 스킴은 이것만 내주고, 탭을 닫으면 지운다.
    open: Mutex<HashMap<u64, PathBuf>>,
    /// 셸이 아직 받아 가지 않은 문서(실행 인자·두 번째 실행·끌어다 놓기). 셸은 'documents' 알림을 받거나 처음 뜰 때 가져간다.
    pending: Mutex<Vec<Opened>>,
    /// 사용자가 고른 폴더. 탐색기는 이 아래만 읽고 연다.
    folder: Mutex<Option<PathBuf>>,
}

/// 셸(src/shell.js)에 넘기는 문서: 탭 번호, 렌더러가 읽을 주소, 파일 이름과 내용으로 가린 형식.
/// 셸은 contentFmt → 확장자 → textFmt 순으로 형식을 정한다(Android DocFormat.detect와 같은 순서).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Opened {
    id: u64,
    src: String,
    name: String,
    content_fmt: Option<&'static str>,
    text_fmt: Option<&'static str>,
}

/// 탐색기 항목
#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    dir: bool,
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// 문서에 번호를 붙인다. 이미 연 파일이면 그 번호를 돌려줘 셸이 그 탭으로 간다.
fn register(app: &AppHandle, path: PathBuf) -> Opened {
    let path = dunce::canonicalize(&path).unwrap_or(path);
    let docs = app.state::<Documents>();
    let mut open = docs.open.lock().unwrap();
    let id = match open.iter().find(|(_, p)| **p == path) {
        Some((id, _)) => *id,
        None => {
            let id = docs.next_id.fetch_add(1, Ordering::Relaxed) + 1;
            open.insert(id, path.clone());
            id
        }
    };
    let detected = detect::detect(&path);
    Opened { id, src: format!("{DOC_ORIGIN}/{id}"), name: file_name(&path), content_fmt: detected.content, text_fmt: detected.text }
}

/// 셸 밖에서 들어온 문서를 셸에 넘긴다: 쌓아 두고 알린다(셸이 아직 뜨는 중이면 뜬 뒤 take_documents로 가져간다).
fn deliver(app: &AppHandle, paths: impl IntoIterator<Item = PathBuf>) {
    let opened: Vec<Opened> = paths.into_iter().filter(|p| p.is_file()).map(|p| register(app, p)).collect();
    if opened.is_empty() {
        return;
    }
    app.state::<Documents>().pending.lock().unwrap().extend(opened);
    let _ = app.emit_to(MAIN_WINDOW, "documents", ());
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 실행 인자 가운데 파일들(탐색기 '연결 프로그램'·더블클릭은 경로를 넘긴다). 상대 경로는 실행한 폴더 기준이다.
fn path_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter().skip(1).filter(|a| !a.starts_with('-')).map(|a| cwd.join(a)).filter(|p| p.is_file()).collect()
}

/// path가 root 아래(또는 root)인가. 둘 다 실제 경로로 바꿔 '..'·바로가기로 벗어나지 못하게 한다.
fn is_within(root: &Path, path: &Path) -> Option<PathBuf> {
    let path = dunce::canonicalize(path).ok()?;
    path.starts_with(dunce::canonicalize(root).ok()?).then_some(path)
}

/// 폴더 안의 하위 폴더와 확장자가 맞는 파일. 숨김 항목은 빼고, 폴더 먼저 이름순으로 둔다.
fn list_entries(dir: &Path, extensions: &[String]) -> std::io::Result<Vec<Entry>> {
    let mut entries: Vec<Entry> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.starts_with("~$") {
                return None; // 숨김 파일, 오피스 임시 파일
            }
            let path = entry.path();
            let dir = path.is_dir();
            let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase());
            (dir || ext.is_some_and(|e| extensions.contains(&e))).then(|| Entry { name, path: path.to_string_lossy().into_owned(), dir })
        })
        .collect();
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

#[derive(Serialize)]
struct Folder {
    path: String,
    name: String,
}

fn folder_info(path: &Path) -> Folder {
    Folder { path: path.to_string_lossy().into_owned(), name: file_name(path) }
}

fn config_file(app: &AppHandle, name: &str) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(name))
}

fn write_config(app: &AppHandle, name: &str, contents: &[u8]) {
    if let Some(file) = config_file(app, name) {
        let _ = std::fs::create_dir_all(file.parent().unwrap()).and_then(|_| std::fs::write(&file, contents));
    }
}

/// 셸이 알려 주는 탭 상태. view(보기 방식·맞춤·확대·읽던 자리)는 셸이 정하는 모양이라 그대로 적고 돌려준다.
#[derive(Deserialize)]
struct TabState {
    id: u64,
    view: serde_json::Value,
}

#[derive(Serialize, Deserialize)]
struct SavedTab {
    path: PathBuf,
    view: serde_json::Value,
}

#[derive(Serialize, Deserialize, Default)]
struct Session {
    tabs: Vec<SavedTab>,
    active: Option<usize>,
}

#[derive(Serialize)]
struct RestoredTab {
    opened: Opened,
    view: serde_json::Value,
}

#[derive(Serialize)]
struct Restored {
    tabs: Vec<RestoredTab>,
    active: Option<u64>,
}

// ---- 셸이 부르는 명령

/// 셸 밖에서 들어온(실행 인자·끌어다 놓기·두 번째 실행) 아직 탭으로 열지 않은 문서
#[tauri::command]
fn take_documents(docs: State<Documents>) -> Vec<Opened> {
    std::mem::take(&mut *docs.pending.lock().unwrap())
}

/// 탭을 닫았다. 그 문서 주소는 더 이상 읽히지 않는다.
#[tauri::command]
fn close_document(id: u64, docs: State<Documents>) {
    docs.open.lock().unwrap().remove(&id);
}

/// 폴더 고르기(대화상자가 끝날 때까지 기다리므로 async, 주 스레드 밖). 고른 폴더는 다음 실행 때도 연다.
#[tauri::command]
async fn pick_folder(window: WebviewWindow) -> Option<Folder> {
    let path = window.dialog().file().set_parent(&window).blocking_pick_folder()?.into_path().ok()?;
    let path = dunce::canonicalize(&path).unwrap_or(path);
    let app = window.app_handle();
    write_config(app, FOLDER_FILE, path.to_string_lossy().as_bytes());
    let info = folder_info(&path);
    *app.state::<Documents>().folder.lock().unwrap() = Some(path);
    Some(info)
}

/// 지난번에 고른 폴더(아직 있으면)
#[tauri::command]
fn current_folder(docs: State<Documents>) -> Option<Folder> {
    docs.folder.lock().unwrap().as_deref().map(folder_info)
}

/// 열린 탭을 적어 둔다(탭을 열고 닫거나 보던 자리가 바뀔 때마다 셸이 부른다). 경로는 탭 번호로 Rust가 찾는다.
#[tauri::command]
fn save_session(app: AppHandle, tabs: Vec<TabState>, active: Option<u64>, docs: State<Documents>) {
    let open = docs.open.lock().unwrap();
    let saved: Vec<(u64, SavedTab)> =
        tabs.into_iter().filter_map(|tab| open.get(&tab.id).map(|path| (tab.id, SavedTab { path: path.clone(), view: tab.view }))).collect();
    let active = saved.iter().position(|(id, _)| Some(*id) == active);
    let session = Session { tabs: saved.into_iter().map(|(_, tab)| tab).collect(), active };
    if let Ok(json) = serde_json::to_vec(&session) {
        write_config(&app, SESSION_FILE, &json);
    }
}

/// 지난번에 열려 있던 탭(아직 있는 파일만)을 다시 연다. 셸이 시작할 때 한 번 부른다.
#[tauri::command]
fn restore_session(app: AppHandle) -> Restored {
    let session: Session =
        config_file(&app, SESSION_FILE).and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let active_path = session.active.and_then(|i| session.tabs.get(i)).map(|tab| tab.path.clone());
    let mut active = None;
    let tabs = session
        .tabs
        .into_iter()
        .filter(|tab| tab.path.is_file())
        .map(|tab| {
            let opened = register(&app, tab.path.clone());
            if Some(&tab.path) == active_path.as_ref() {
                active = Some(opened.id);
            }
            RestoredTab { opened, view: tab.view }
        })
        .collect();
    Restored { tabs, active }
}

/// 고른 폴더 아래의 한 폴더 내용
#[tauri::command]
fn list_folder(path: String, extensions: Vec<String>, docs: State<Documents>) -> Result<Vec<Entry>, String> {
    let root = docs.folder.lock().unwrap().clone().ok_or("no folder")?;
    let dir = is_within(&root, Path::new(&path)).ok_or("outside folder")?;
    list_entries(&dir, &extensions).map_err(|e| e.to_string())
}

/// 이름 바꾸기·지우기·탐색기에서 보기의 대상. 부모 폴더가 고른 폴더 아래여야 한다(폴더 자신과 밖은 거부).
/// 부모 폴더만 실제 경로로 풀고 이름은 그대로 붙인다: 바로가기(심볼릭 링크·정션)를 고르면 링크가 가리키는 파일이 아니라
/// 링크 자체를 바꾸거나 지운다.
fn entry_path(docs: &Documents, path: &str) -> Result<PathBuf, String> {
    let root = docs.folder.lock().unwrap().clone().ok_or("no folder")?;
    let root = dunce::canonicalize(&root).map_err(|e| e.to_string())?;
    let path = Path::new(path);
    let name = path.file_name().ok_or("invalid")?;
    let parent = is_within(&root, path.parent().ok_or("invalid")?).ok_or("outside folder")?;
    let entry = parent.join(name);
    if entry.symlink_metadata().is_err() {
        return Err("not found".into());
    }
    Ok(entry)
}

/// 이름 바꾸기·지우기로 바뀐 항목과 그 안의 파일을 연 탭 번호들
#[derive(Serialize)]
struct Changed {
    path: String,
    ids: Vec<u64>,
}

/// 파일 이름으로 쓸 수 없는 이름(Windows 금지 글자, 빈 이름, '.'·'..')
fn invalid_name(name: &str) -> bool {
    name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
}

/// 탐색기 항목 이름 바꾸기(같은 폴더 안). 그 파일(폴더면 그 안)을 연 탭은 새 경로를 따라간다.
/// 바로가기는 링크 자체의 이름만 바뀌고, 링크로 연 탭(가리키는 파일 경로로 열린다)은 그대로 둔다.
#[tauri::command]
fn rename_entry(path: String, name: String, docs: State<Documents>) -> Result<Changed, String> {
    let from = entry_path(&docs, &path)?;
    let name = name.trim();
    if invalid_name(name) {
        return Err("invalid".into());
    }
    let to = from.parent().ok_or("invalid")?.join(name);
    if to.symlink_metadata().is_ok() && !only_case_changes(&from, &to) {
        return Err("exists".into());
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
    let mut open = docs.open.lock().unwrap();
    let mut ids = Vec::new();
    for (id, p) in open.iter_mut().filter(|(_, p)| p.starts_with(&from)) {
        *p = to.join(p.strip_prefix(&from).unwrap());
        ids.push(*id);
    }
    Ok(Changed { path: to.to_string_lossy().into_owned(), ids })
}

/// to가 이미 있어도 from의 대소문자만 바꾸는 것인지(Windows는 같은 파일로 본다. É→é처럼 영문 밖 글자 포함).
/// 어느 쪽이든 링크면 예외로 두지 않는다: 대소문자를 구분하는 폴더에서 링크 이름을 그 링크가 가리키는 파일 이름으로 바꾸면
/// 실제 파일을 링크로 덮어쓰게 된다.
fn only_case_changes(from: &Path, to: &Path) -> bool {
    let is_link = |p: &Path| p.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false);
    let lower = |p: &Path| p.file_name().map(|n| n.to_string_lossy().to_lowercase());
    !is_link(from) && !is_link(to) && lower(from) == lower(to) && dunce::canonicalize(from).ok() == dunce::canonicalize(to).ok()
}

/// 탐색기 항목을 휴지통으로 보낸다(묻는 문구는 셸이 화면 언어로 준다). 취소하면 None.
#[tauri::command]
async fn trash_entry(window: WebviewWindow, path: String, title: String, message: String) -> Result<Option<Changed>, String> {
    let app = window.app_handle();
    let docs = app.state::<Documents>();
    let target = entry_path(&docs, &path)?;
    let confirmed = window
        .dialog()
        .message(message)
        .title(title)
        .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
        .parent(&window)
        .blocking_show();
    if !confirmed {
        return Ok(None);
    }
    trash::delete(&target).map_err(|e| e.to_string())?;
    let mut open = docs.open.lock().unwrap();
    let ids: Vec<u64> = open.iter().filter(|(_, p)| p.starts_with(&target)).map(|(id, _)| *id).collect();
    for id in &ids {
        open.remove(id);
    }
    Ok(Some(Changed { path, ids }))
}

/// Windows 탐색기에서 그 항목을 골라 보여 준다.
#[tauri::command]
fn reveal_entry(path: String, docs: State<Documents>) -> Result<(), String> {
    let target = entry_path(&docs, &path)?;
    // explorer는 인자를 쉼표로 나눠 읽으므로 경로를 따옴표로 감싸 그대로 넘긴다(Windows 파일 이름에는 " 가 들어갈 수 없다).
    #[cfg(windows)]
    let result = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer").raw_arg(format!("/select,\"{}\"", target.display())).spawn()
    };
    #[cfg(not(windows))]
    let result = std::process::Command::new("xdg-open").arg(target.parent().unwrap_or(&target)).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// 탐색기에서 고른 파일을 연다(고른 폴더 아래만).
#[tauri::command]
fn open_file(app: AppHandle, path: String, docs: State<Documents>) -> Result<Opened, String> {
    let root = docs.folder.lock().unwrap().clone().ok_or("no folder")?;
    let path = is_within(&root, Path::new(&path)).filter(|p| p.is_file()).ok_or("outside folder")?;
    Ok(register(&app, path))
}

// ---- doc 스킴

fn respond(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        // 셸 출처와 doc 스킴 출처가 달라 렌더러의 fetch가 읽을 수 있게 허용한다.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, APP_ORIGIN)
        .body(body)
        .unwrap()
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    respond(code, "text/plain", code.canonical_reason().unwrap_or_default().as_bytes().to_vec())
}

fn read_range(path: &Path, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut buffer = Vec::new();
    file.take(end - start).read_to_end(&mut buffer)?;
    Ok(buffer)
}

fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let id = request.uri().path().trim_start_matches('/').parse::<u64>().ok();
    match id.and_then(|id| app.state::<Documents>().open.lock().unwrap().get(&id).cloned()) {
        Some(path) => serve_file(&path, request.uri().query().unwrap_or_default()),
        None => status(StatusCode::NOT_FOUND),
    }
}

fn serve_file(path: &Path, query: &str) -> Response<Vec<u8>> {
    let params: HashMap<&str, &str> = query.split('&').map(|p| p.split_once('=').unwrap_or((p, ""))).collect();
    let octets = |bytes| respond(StatusCode::OK, "application/octet-stream", bytes);
    let result = if params.contains_key("length") {
        std::fs::metadata(path).map(|m| respond(StatusCode::OK, "text/plain", m.len().to_string().into_bytes()))
    } else if params.contains_key("start") {
        let start = params.get("start").and_then(|v| v.parse::<u64>().ok());
        let end = params.get("end").and_then(|v| v.parse::<u64>().ok());
        match (start, end) {
            (Some(start), Some(end)) if start <= end => read_range(path, start, end).map(octets),
            _ => return status(StatusCode::BAD_REQUEST),
        }
    } else {
        std::fs::read(path).map(octets)
    };
    result.unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}

fn main() {
    tauri::Builder::default()
        // 이미 떠 있으면 새 프로세스 대신 기존 창에 탭으로 연다. 문서 없이 실행하면 창을 앞으로 가져온다.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths = path_args(args, Path::new(&cwd));
            if paths.is_empty() {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            deliver(app, paths);
        }))
        .plugin(tauri_plugin_dialog::init())
        // 창 크기·위치·최대화를 기억해 다음에 그대로 연다.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Documents::default())
        // 큰 문서(통째로 읽는 형식)를 읽는 동안 창이 멈추지 않게 따로 스레드에서 읽는다.
        .register_asynchronous_uri_scheme_protocol("doc", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || responder.respond(serve(&app, &request)));
        })
        .invoke_handler(tauri::generate_handler![
            take_documents,
            close_document,
            save_session,
            restore_session,
            pick_folder,
            current_folder,
            list_folder,
            open_file,
            rename_entry,
            trash_entry,
            reveal_entry
        ])
        // 끌어다 놓은 파일을 모두 탭으로 연다.
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                deliver(window.app_handle(), paths.clone());
            }
        })
        .setup(|app| {
            let handle = app.handle();
            let saved = config_file(handle, FOLDER_FILE).and_then(|f| std::fs::read_to_string(f).ok()).map(PathBuf::from).filter(|p| p.is_dir());
            *handle.state::<Documents>().folder.lock().unwrap() = saved;
            let cwd = std::env::current_dir().unwrap_or_default();
            let paths = path_args(std::env::args_os().map(|a| a.to_string_lossy().into_owned()), &cwd);
            handle.state::<Documents>().pending.lock().unwrap().extend(paths.into_iter().map(|p| register(handle, p)));
            WebviewWindowBuilder::new(handle, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
                .title("Doc Viewer")
                .inner_size(1280.0, 860.0)
                .min_inner_size(480.0, 360.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Doc Viewer를 시작하지 못했습니다");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 테스트가 동시에 돌므로 테스트마다 다른 파일을 쓴다.
    fn sample(test: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("doc-viewer-{test}-{}.bin", std::process::id()));
        std::fs::write(&path, b"0123456789").unwrap();
        path
    }

    #[test]
    fn serves_length_range_and_whole_file() {
        let path = sample("serves_length_range_and_whole_file");
        assert_eq!(serve_file(&path, "length").body(), b"10");
        assert_eq!(serve_file(&path, "start=2&end=5").body(), b"234");
        // 끝을 넘는 구간은 있는 만큼만 준다(pdf.js 마지막 구간).
        assert_eq!(serve_file(&path, "start=8&end=20").body(), b"89");
        assert_eq!(serve_file(&path, "").body(), b"0123456789");
        let response = serve_file(&path, "");
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], APP_ORIGIN);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_bad_ranges() {
        let path = sample("rejects_bad_ranges");
        assert_eq!(serve_file(&path, "start=5&end=2").status(), StatusCode::BAD_REQUEST);
        assert_eq!(serve_file(&path, "start=x&end=2").status(), StatusCode::BAD_REQUEST);
        assert_eq!(serve_file(&path, "start=1").status(), StatusCode::BAD_REQUEST);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_invalid_file_names() {
        for name in ["", ".", "..", "a/b", "a\\b", "a:b", "a?.pdf", "<x>"] {
            assert!(invalid_name(name), "{name}");
        }
        assert!(!invalid_name("보고서 (최종).hwp"));
    }

    #[test]
    fn explorer_stays_inside_folder_and_lists_documents() {
        let root = std::env::temp_dir().join(format!("doc-viewer-explorer-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub")).unwrap();
        for name in ["b.PDF", "a.docx", "note.exe", ".hidden.pdf", "~$a.docx"] {
            std::fs::write(root.join(name), b"x").unwrap();
        }
        let names: Vec<String> = list_entries(&root, &["pdf".into(), "docx".into()]).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["sub", "a.docx", "b.PDF"]);
        assert!(is_within(&root, &root.join("sub")).is_some());
        assert!(is_within(&root, &root.join("sub/../a.docx")).is_some());
        assert!(is_within(&root.join("sub"), &root.join("sub/../a.docx")).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn entry_path_keeps_links_and_stays_inside() {
        let root = std::env::temp_dir().join(format!("doc-viewer-entry-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/real.pdf"), b"x").unwrap();
        std::os::unix::fs::symlink(root.join("sub/real.pdf"), root.join("link.pdf")).unwrap();
        let docs = Documents::default();
        *docs.folder.lock().unwrap() = Some(root.clone());
        let canonical = dunce::canonicalize(&root).unwrap();
        // 링크를 고르면 링크가 대상이다(가리키는 sub/real.pdf가 아니라).
        assert_eq!(entry_path(&docs, &root.join("link.pdf").to_string_lossy()).unwrap(), canonical.join("link.pdf"));
        assert_eq!(entry_path(&docs, &root.join("sub/real.pdf").to_string_lossy()).unwrap(), canonical.join("sub/real.pdf"));
        assert!(entry_path(&docs, &root.to_string_lossy()).is_err(), "고른 폴더 자체는 안 된다");
        assert!(entry_path(&docs, &root.join("sub/..").to_string_lossy()).is_err());
        assert!(entry_path(&docs, &root.join("missing.pdf").to_string_lossy()).is_err());
        // 링크 이름을 그 링크가 가리키는 파일 이름으로 바꾸는 것은 대소문자만 바꾸는 것으로 보지 않는다(실제 파일을 덮어쓴다).
        std::os::unix::fs::symlink(root.join("sub/real.pdf"), root.join("sub/REAL.pdf")).unwrap();
        assert!(!only_case_changes(&root.join("sub/REAL.pdf"), &root.join("sub/real.pdf")));
        assert!(!only_case_changes(&root.join("sub/real.pdf"), &root.join("link.pdf")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn path_args_skip_exe_and_flags() {
        let path = sample("path_args_skip_exe_and_flags");
        let dir = path.parent().unwrap();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let args = ["app.exe".to_owned(), "--flag".to_owned(), name];
        assert_eq!(path_args(args, dir), vec![path.clone()]);
        assert!(path_args(["app.exe".to_owned()], dir).is_empty());
        std::fs::remove_file(path).unwrap();
    }
}
