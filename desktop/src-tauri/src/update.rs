// 앱 업데이트: 셸이 처음 뜰 때 새 버전을 확인하고(check_update), 사용자가 '지금 업데이트'를 누르면 받아서 설치한 뒤
// 다시 시작한다(install_update). 새 버전 정보는 GitHub Release의 latest.json(tauri.conf.json plugins.updater)에서 읽고,
// 받은 설치 파일은 앱에 넣은 공개 키로 서명을 확인한다. Windows는 설치 프로그램이 앱을 닫고 설치한 뒤 다시 띄운다.
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::MAIN_WINDOW;

/// 확인한 새 버전. install_update가 다시 확인하지 않고 이것을 받는다.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// 시험·개발 빌드(0.0.x: 손으로 돌린 CI 빌드와 로컬 빌드)는 확인하지 않는다. 정식 버전이 늘 더 높아 보여, 더 새 코드를
/// 이전 정식 버전으로 되돌리라고 권하게 된다.
fn is_release(app: &AppHandle) -> bool {
    let version = &app.package_info().version;
    version.major > 0 || version.minor > 0
}

/// 새 버전이 있으면 그 버전을, 없거나 확인할 수 없으면(오프라인, 이 설치 형식의 업데이트 파일이 없음 등) None을 돌려준다.
#[tauri::command]
pub async fn check_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    if !is_release(&app) {
        return Ok(None);
    }
    let update = match app.updater().map_err(|e| e.to_string())?.check().await {
        Ok(update) => update,
        Err(_) => return Ok(None),
    };
    let info = update.as_ref().map(|u| UpdateInfo { version: u.version.clone() });
    *pending.0.lock().unwrap() = update;
    Ok(info)
}

/// 확인해 둔 새 버전을 받아(진행은 'update-progress' 알림) 설치하고 다시 시작한다. 실패하면 오류 글을 돌려준다.
#[tauri::command]
pub async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("확인한 업데이트가 없습니다")?;
    let mut downloaded = 0u64;
    let emitter = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = emitter.emit_to(MAIN_WINDOW, "update-progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    // Windows는 위에서 설치 프로그램을 띄우고 앱을 끝내므로 여기까지 오지 않는다.
    app.restart();
}

/// main.rs가 부른다: 업데이트 플러그인과 상태를 붙인다.
pub fn init<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.plugin(tauri_plugin_updater::Builder::new().build()).manage(PendingUpdate::default())
}
