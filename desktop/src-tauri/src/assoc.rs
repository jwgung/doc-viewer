// Windows 파일 연결 복구. 예전 설치 프로그램(Tauri 기본 파일 연결)은 `Software\Classes\.<확장자>`의 기본값을 이 앱의 ProgID로
// 덮었다. 탐색기 "새로 만들기"는 그 기본값이 가리키는 ProgID 아래 ShellNew를 찾으므로, Office·한글 같은 앱의 새로 만들기 항목이
// 사라졌다. 지금 설치 프로그램은 OpenWithProgids에만 이 앱을 더하고, 설치·업데이트 때 이 앱을
// `--repair-file-associations <확장자...>`로 불러 덮인 기본값을 되돌린다(windows/file-icons.nsh·.wxs, scripts/make-file-icons.js).
// 판단 로직(decide)은 어디서나 테스트하지만 레지스트리를 고치는 쪽은 Windows에만 있다.
#![cfg_attr(not(windows), allow(dead_code))]

/// 설치 프로그램이 앱을 이 인자로 부르면 창을 띄우지 않고 연결만 고친 뒤 끝낸다.
pub const REPAIR_FLAG: &str = "--repair-file-associations";

/// 예전 설치 프로그램이 확장자 기본값에 쓴 ProgID인가(exe는 "DocViewer.<형식>", msi는 "Doc Viewer.<확장자>")
pub fn is_ours(prog_id: &str) -> bool {
    let id = prog_id.to_ascii_lowercase();
    id.starts_with("docviewer.") || id.starts_with("doc viewer.")
}

/// 확장자 키 하나에 할 일
#[derive(Debug, PartialEq, Eq)]
pub enum Fix {
    /// 그대로 둔다
    Keep,
    /// 기본값을 이 ProgID로 되돌린다
    Restore(String),
    /// 기본값을 지운다(사용자 키라면 컴퓨터 전체 키의 값이 다시 보인다)
    Clear,
}

/// Windows가 처음부터 정해 둔 확장자 기본값. ShellNew를 확장자 키에 바로 두어 하위 ProgID로 찾을 수 없는 것들이다.
/// 컴퓨터 전체 키(HKLM)에만 쓴다: 사용자 키는 지우면 컴퓨터 전체 키의 값이 보이므로 지운다.
pub fn stock_default(ext: &str) -> Option<&'static str> {
    match ext {
        "txt" | "log" => Some("txtfile"),
        "xml" => Some("xmlfile"),
        _ => None,
    }
}

/// 확장자 키의 기본값(`current`), 예전 설치 프로그램이 남긴 백업 값들(`backups`), 그 키 아래 ShellNew를 가진 하위 키 이름들
/// (`shell_new_owners`, 새로 만들기를 등록한 ProgID), Windows 기본값(`stock`)으로 할 일을 정한다. 다른 앱이 기본값을 가지고
/// 있으면 건드리지 않는다. 기본값이 비어 있어도 ShellNew를 가진 ProgID가 있으면 되돌린다: 예전 msi를 지울 때 기본값만 지워졌을 수
/// 있고, 하위 ProgID의 ShellNew는 그 ProgID가 기본값일 때만 쓰이므로 원래 기본값이었다고 볼 수 있다.
pub fn decide(current: Option<&str>, backups: &[String], shell_new_owners: &[String], stock: Option<&str>) -> Fix {
    let current = current.unwrap_or("");
    if !current.is_empty() && !is_ours(current) {
        return Fix::Keep;
    }
    let other = |id: &&String| !id.is_empty() && !is_ours(id);
    if let Some(id) = backups.iter().find(other).or_else(|| shell_new_owners.iter().find(other)) {
        return Fix::Restore(id.clone());
    }
    match stock {
        Some(id) => Fix::Restore(id.to_owned()),
        None if current.is_empty() => Fix::Keep,
        None => Fix::Clear,
    }
}

/// 복구 인자면 고칠 확장자 목록(점 없이, 영숫자만)을 준다.
pub fn repair_args(mut args: impl Iterator<Item = String>) -> Option<Vec<String>> {
    args.next();
    if args.next().as_deref() != Some(REPAIR_FLAG) {
        return None;
    }
    Some(
        args.map(|a| a.trim_start_matches('.').to_ascii_lowercase())
            .filter(|a| !a.is_empty() && a.chars().all(|c| c.is_ascii_alphanumeric()))
            .collect(),
    )
}

/// 사용자 키(HKCU)와 컴퓨터 전체 키(HKLM, 쓸 권한이 있을 때만)의 확장자 기본값을 고치고 탐색기에 알린다.
#[cfg(windows)]
pub fn repair(exts: &[String]) {
    use winreg::{
        enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE},
        RegKey,
    };

    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let classes = RegKey::predef(hive);
        for ext in exts {
            let path = format!("Software\\Classes\\.{ext}");
            let Ok(key) = classes.open_subkey_with_flags(&path, KEY_READ | KEY_WRITE) else { continue };
            let current: Option<String> = key.get_value("").ok();
            // Tauri NSIS FileAssociation.nsh(APP_ASSOCIATE)가 덮기 전 값을 "<ProgID>_backup"에 남겼다.
            let backup_names: Vec<String> =
                key.enum_values().filter_map(Result::ok).map(|(name, _)| name).filter(|name| name.ends_with("_backup") && is_ours(name)).collect();
            let backups: Vec<String> = backup_names.iter().filter_map(|name| key.get_value(name).ok()).collect();
            let owners: Vec<String> =
                key.enum_keys().filter_map(Result::ok).filter(|sub| key.open_subkey(format!("{sub}\\ShellNew")).is_ok()).collect();
            let stock = if hive == HKEY_LOCAL_MACHINE { stock_default(ext) } else { None };
            match decide(current.as_deref(), &backups, &owners, stock) {
                Fix::Keep => {}
                Fix::Restore(id) => {
                    let _ = key.set_value("", &id);
                }
                Fix::Clear => {
                    let _ = key.delete_value("");
                }
            }
            for name in backup_names {
                let _ = key.delete_value(name);
            }
        }
    }
    // 새로 만들기 메뉴·아이콘 캐시를 다시 읽게 한다(SHCNE_ASSOCCHANGED)
    unsafe { windows_sys::Win32::UI::Shell::SHChangeNotify(0x0800_0000, 0, std::ptr::null(), std::ptr::null()) };
}

/// Windows 밖에는 고칠 것이 없다.
#[cfg(not(windows))]
pub fn repair(_exts: &[String]) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn other_apps_default_is_kept() {
        assert_eq!(decide(Some("Word.Document.12"), &ids(&["DocViewer.docx"]), &ids(&["Word.Document.12"]), None), Fix::Keep);
        assert_eq!(decide(Some("txtfile"), &[], &[], Some("txtfile")), Fix::Keep);
    }

    #[test]
    fn ours_is_replaced_by_backup_first() {
        let fix = decide(Some("DocViewer.docx"), &ids(&["Word.Document.12"]), &ids(&["Other.Doc"]), None);
        assert_eq!(fix, Fix::Restore("Word.Document.12".into()));
    }

    #[test]
    fn backup_overwritten_by_update_falls_back_to_shell_new_owner() {
        // 업데이트마다 백업이 우리 ProgID로 다시 덮인다
        let fix = decide(Some("DocViewer.docx"), &ids(&["DocViewer.docx", ""]), &ids(&["Word.Document.12"]), None);
        assert_eq!(fix, Fix::Restore("Word.Document.12".into()));
    }

    #[test]
    fn msi_progid_is_ours_too() {
        let fix = decide(Some("Doc Viewer.xlsx"), &[], &ids(&["Doc Viewer.xlsx", "Excel.Sheet.12"]), None);
        assert_eq!(fix, Fix::Restore("Excel.Sheet.12".into()));
    }

    #[test]
    fn ours_without_anything_to_restore_is_cleared() {
        // 사용자 키(HKCU): 지우면 컴퓨터 전체 키의 Office 값이 다시 보인다
        assert_eq!(decide(Some("DocViewer.md"), &ids(&[""]), &[], None), Fix::Clear);
    }

    #[test]
    fn empty_default_is_restored_only_from_shell_new_owner() {
        assert_eq!(decide(None, &[], &ids(&["PowerPoint.Show.12"]), None), Fix::Restore("PowerPoint.Show.12".into()));
        assert_eq!(decide(Some(""), &[], &[], None), Fix::Keep);
        assert_eq!(decide(None, &[], &ids(&["DocViewer.pptx"]), None), Fix::Keep);
    }

    #[test]
    fn machine_key_without_shell_new_owner_gets_the_windows_default() {
        // .txt는 ShellNew를 확장자 키에 바로 둔다. 예전 msi가 덮은 HKLM .txt를 비우면 메모장 연결까지 사라진다.
        assert_eq!(decide(Some("Doc Viewer.txt"), &[], &[], stock_default("txt")), Fix::Restore("txtfile".into()));
        assert_eq!(decide(None, &[], &[], stock_default("xml")), Fix::Restore("xmlfile".into()));
        assert_eq!(decide(Some("Doc Viewer.log"), &[], &ids(&["Other.Log"]), stock_default("log")), Fix::Restore("Other.Log".into()));
        assert_eq!(stock_default("json"), None);
    }

    #[test]
    fn repair_args_need_the_flag_right_after_the_exe() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter();
        assert_eq!(repair_args(args(&["app.exe", REPAIR_FLAG, "docx", ".PDF", "a\\b", ""])), Some(ids(&["docx", "pdf"])));
        assert_eq!(repair_args(args(&["app.exe", "a.docx", REPAIR_FLAG])), None);
        assert_eq!(repair_args(args(&["app.exe"])), None);
    }
}
