#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod data_location;
mod model_keys;
mod plugin_secrets;
use serde_json::{json, Value};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::Mutex,
};
use tauri::Manager;

struct Bridge {
    root: std::path::PathBuf,
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    #[cfg(windows)]
    job: isize,
}
impl Bridge {
    fn start(app: &tauri::AppHandle) -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|_| "无法定位 Launcher。")?;
        let portable = executable.parent().ok_or("无法定位运行目录。")?.join("runtime");
        let root = std::env::var_os("PERSPECTRA_LAUNCHER_DATA_DIR")
            .map(std::path::PathBuf::from).map(Ok)
            .unwrap_or_else(|| {
                let fallback = app.path().app_data_dir().map_err(|e| e.to_string())?;
                let config = app.path().app_config_dir().map_err(|e| e.to_string())?.join("launcher-location.json");
                data_location::load(&config, &fallback)
            })
            .map_err(|error| format!("无法取得本地数据目录：{error}"))?;
        let mut command;
        if portable.is_dir() {
            if !portable.join("node.exe").is_file() || !portable.join("launcher.mjs").is_file()
                || !portable.join("python/python.exe").is_file() || !portable.join("playtest.mjs").is_file() {
                return Err("便携包运行文件缺失，请重新完整解压测试包。".into());
            }
            command = Command::new(portable.join("node.exe"));
            command.current_dir(&portable).arg(portable.join("launcher.mjs"));
            command.env("PERSPECTRA_RUNTIME_ROOT", &portable)
                .env("HCW_HINDSIGHT_PYTHON", portable.join("python/python.exe"))
                .env("HCW_HINDSIGHT_CORE_DIR", portable.join("memory-core/python/core"))
                .env("HCW_HINDSIGHT_ONNX_DIR", portable.join("models/e5-small"))
                .env("HCW_HINDSIGHT_CACHE_DIR", root.join("memory-cache"))
                .env("PYTHONNOUSERSITE", "1").env("PYTHONDONTWRITEBYTECODE", "1")
                .env("HF_HUB_OFFLINE", "1").env("TRANSFORMERS_OFFLINE", "1")
                .env_remove("PYTHONHOME").env_remove("PYTHONPATH");
        } else if cfg!(debug_assertions) {
            let repository = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
            command = Command::new("node");
            command.current_dir(repository).args(["--import", "tsx", "desktop/launcher-entry.ts"])
                .env_remove("PERSPECTRA_RUNTIME_ROOT");
        } else {
            return Err("便携包 runtime 目录缺失，请完整解压后启动。".into());
        }
        command.arg(&root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|_| "无法启动本机运行时；请检查便携包是否完整或开发依赖是否可用。")?;
        #[cfg(windows)]
        let job = {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::JobObjects::*;
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if handle.is_null()
                    || SetInformationJobObject(
                        handle,
                        JobObjectExtendedLimitInformation,
                        &limits as *const _ as *const _,
                        std::mem::size_of_val(&limits) as u32,
                    ) == 0
                    || AssignProcessToJobObject(handle, child.as_raw_handle() as _) == 0
                {
                    child.kill().ok();
                    child.wait().ok();
                    if !handle.is_null() {
                        CloseHandle(handle);
                    }
                    return Err("无法建立 Core 子进程清理边界。".into());
                }
                handle as isize
            }
        };
        let input = child.stdin.take().ok_or("无法打开 Core 输入。")?;
        let output = BufReader::new(child.stdout.take().ok_or("无法打开 Core 输出。")?);
        Ok(Self {
            root,
            child,
            input,
            output,
            #[cfg(windows)]
            job,
        })
    }
    fn request(&mut self, request: Value) -> Result<Value, String> {
        serde_json::to_writer(&mut self.input, &request).map_err(|_| "Core 通信失败。")?;
        self.input
            .write_all(b"\n")
            .and_then(|_| self.input.flush())
            .map_err(|_| "Core 连接已关闭。")?;
        let mut line = String::new();
        self.output
            .read_line(&mut line)
            .map_err(|_| "Core 返回读取失败。")?;
        let reply: Value =
            serde_json::from_str(&line).map_err(|_| "Core 连接已关闭或返回无效。")?;
        if reply["ok"] != true {
            return Err(reply["error"].as_str().unwrap_or("本机操作失败。").into());
        }
        Ok(reply["result"].clone())
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.child.kill().ok();
        self.child.wait().ok();
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job as _);
        }
    }
}
#[derive(Default)]
struct Core(Mutex<Option<Bridge>>);
#[tauri::command]
async fn launcher_request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Value,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("操作仅在 Launcher 窗口可用。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Core>();
        let mut bridge = state.0.lock().map_err(|_| "Core 进程状态异常。")?;
        if bridge.is_none() {
            *bridge = Some(Bridge::start(&app)?);
        }
        let core = bridge.as_mut().unwrap();
        if matches!(request["operation"].as_str(), Some("data-location" | "data-location-save" | "data-folder-open")) {
            let config = app.path().app_config_dir().map_err(|_| "无法取得设置目录。")?.join("launcher-location.json");
            let locked = std::env::var_os("PERSPECTRA_LAUNCHER_DATA_DIR").is_some();
            if request["operation"] == "data-location-save" {
                if locked { return Err("数据目录由环境变量指定，请修改环境变量后重启。".into()); }
                if core.request(json!({"operation":"snapshot"}))?["core"]["state"] == "running" {
                    return Err("请先停止游戏再更改数据目录。".into());
                }
                let directory = request["directory"].as_str().ok_or("请选择数据目录。")?;
                data_location::save(&config, std::path::Path::new(directory), &core.root)?;
            }
            if request["operation"] == "data-folder-open" {
                let folder = match request["folder"].as_str() {
                    Some("root") => core.root.clone(),
                    Some("instances") => core.root.join("instances"),
                    _ => return Err("不支持的数据目录。".into()),
                };
                if !folder.is_dir() { return Err("此目录尚未创建，首次游玩后会自动生成。".into()); }
                #[cfg(windows)]
                Command::new("explorer.exe").arg(&folder).creation_flags(0x08000000)
                    .spawn().map_err(|_| "打开文件夹失败。")?;
            }
            let next = if locked { core.root.clone() } else { data_location::load(&config, &core.root)? };
            return Ok(json!({"current":core.root,"next":next,"locked":locked}));
        }
        let mut request = request;
        // A stored key must not follow its connection to another host; read the old address first.
        let previous_endpoint = if request["operation"] == "connection-save" {
            let snapshot = core.request(json!({"operation":"snapshot"}))?;
            let id = request["connection"]["id"].as_str().unwrap_or_default().to_string();
            snapshot["connections"].as_array().and_then(|list| list.iter().find(|c| c["id"] == id.as_str()))
                .and_then(|c| c["endpoint"].as_str().map(String::from))
        } else { None };
        // Plugin secrets must not follow a plugin ID to a removed entry or a different file.
        let previous_plugins = if request["operation"] == "preferences" {
            Some(core.request(json!({"operation":"snapshot"}))?)
        } else { None };
        match request["operation"].as_str() {
            Some("plugin-secret-set") => {
                let plugin = request["pluginId"].as_str().ok_or("插件标识无效。")?;
                let field = request["field"].as_str().ok_or("插件密钥标识无效。")?;
                let value = request["value"].as_str().ok_or("插件密钥无效。")?;
                plugin_secrets::set(plugin, field, value)?;
                return Ok(json!({ "saved": true }));
            }
            Some("plugin-secret-status") => {
                let plugin = request["pluginId"].as_str().ok_or("插件标识无效。")?;
                let fields = request["fields"].as_array().ok_or("插件密钥标识无效。")?;
                let stored: Vec<&str> = fields.iter().filter_map(Value::as_str).filter(|field| plugin_secrets::get(plugin, field).is_some()).collect();
                return Ok(json!({ "stored": stored }));
            }
            Some("connection-key-set") => {
                let id = request["connectionId"].as_str().ok_or("连接标识无效。")?;
                let key = request["apiKey"].as_str().ok_or("API Key 无效。")?;
                model_keys::set(id, key)?;
                return Ok(json!({ "saved": true }));
            }
            Some("connection-key-status") => {
                let ids = request["connectionIds"].as_array().ok_or("连接标识无效。")?;
                let stored: Vec<&str> = ids.iter().filter_map(Value::as_str).filter(|id| model_keys::get(id).is_some()).collect();
                return Ok(json!({ "stored": stored }));
            }
            Some("list-models" | "test-model") => {
                let ids: Vec<String> = request["connectionId"].as_str().map(|id| vec![id.to_string()]).unwrap_or_default();
                model_keys::inject(&mut request, &ids, model_keys::get);
            }
            Some("start") => {
                let snapshot = core.request(json!({"operation":"snapshot"}))?;
                let ids: Vec<String> = snapshot["connections"].as_array().map(|list| list.iter().filter_map(|c| c["id"].as_str().map(String::from)).collect()).unwrap_or_default();
                model_keys::inject(&mut request, &ids, model_keys::get);
                plugin_secrets::inject(&mut request, Some(&snapshot), plugin_secrets::get);
            }
            _ => model_keys::inject(&mut request, &[], |_| None),
        }
        if request["operation"] != "start" {
            plugin_secrets::inject(&mut request, None, |_, _| None);
        }
        let result = core.request(request.clone())?;
        if let (Some(old), Some(id)) = (previous_endpoint, request["connection"]["id"].as_str()) {
            let saved = result["connections"].as_array().and_then(|list| list.iter().find(|c| c["id"] == id)).and_then(|c| c["endpoint"].as_str());
            if saved.is_some_and(|new| !model_keys::same_origin(&old, new)) {
                model_keys::remove(id);
            }
        }
        if let Some(before) = previous_plugins {
            for (plugin, field) in plugin_secrets::stale(&before, &result) {
                plugin_secrets::remove(&plugin, &field);
            }
        }
        if request["operation"] == "connection-remove" {
            if let Some(id) = request["connectionId"].as_str() {
                model_keys::remove(id);
            }
        }
        if request["operation"] == "open" || request["operation"] == "open-creator" {
            let url = result["url"].as_str().ok_or("游戏地址无效。")?;
            let path = if request["operation"] == "open-creator" { "/creator/" } else { "/" };
            validated_local_url(url, path)?;
            #[cfg(windows)]
            {
                Command::new("rundll32.exe")
                    .args(["url.dll,FileProtocolHandler", url])
                    .creation_flags(0x08000000)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|_| "游戏已启动，但默认浏览器打开失败。")?;
            }
            #[cfg(not(windows))]
            return Err("本轮仅接通 Windows 浏览器打开。".into());
            return Ok(json!({ "opened": true }));
        }
        Ok(result)
    })
    .await
    .map_err(|_| "本机操作执行失败。")?
}
fn validated_local_url(url: &str, path: &str) -> Result<(), String> {
    let invalid = || "游戏地址无效。".to_string();
    if !matches!(path, "/" | "/creator/") { return Err(invalid()); }
    let suffix = format!("{path}#token=");
    let (base, token) = url.split_once(&suffix).ok_or_else(invalid)?;
    let port = base.strip_prefix("http://127.0.0.1:").ok_or_else(invalid)?;
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit())
        || port.parse::<u16>().ok().filter(|p| *p > 0).is_none()
        || token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod local_url_tests {
    use super::validated_local_url;
    #[test]
    fn allows_only_the_requested_host_page_and_loopback_port() {
        let token = "a".repeat(64);
        for path in ["/", "/creator/"] {
            for port in ["1", "65535"] {
                assert!(validated_local_url(&format!("http://127.0.0.1:{port}{path}#token={token}"), path).is_ok());
            }
            for base in ["https://127.0.0.1:1", "http://localhost:1", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:+1", "http://127.0.0.1:1@evil.test", "http://127.0.0.1:1/extra"] {
                assert!(validated_local_url(&format!("{base}{path}#token={token}"), path).is_err());
            }
            for bad_token in ["a".repeat(63), "g".repeat(64), format!("{token}&extra=1")] {
                assert!(validated_local_url(&format!("http://127.0.0.1:1{path}#token={bad_token}"), path).is_err());
            }
        }
        assert!(validated_local_url(&format!("http://127.0.0.1:1/creator/#token={token}"), "/").is_err());
        assert!(validated_local_url(&format!("http://127.0.0.1:1/#token={token}"), "/creator/").is_err());
    }
}

fn main() {
    if let Ok(executable) = std::env::current_exe() {
        if let Some(folder) = executable.parent() {
            let webview = folder.join("runtime/webview2");
            if webview.join("msedgewebview2.exe").is_file() {
                std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", webview);
            }
        }
    }
    tauri::Builder::default()
        .manage(Core::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![launcher_request])
        .build(tauri::generate_context!())
        .expect("Unable to start Perspectra Launcher")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Ok(mut bridge) = app.state::<Core>().0.lock() {
                    if let Some(core) = bridge.as_mut() {
                        // The child is killed right after, so close the pack lens first: it removes its temp copy.
                        core.request(json!({"operation":"lens-close"})).ok();
                        core.request(json!({"operation":"stop"})).ok();
                    }
                    *bridge = None;
                }
            }
        });
}
