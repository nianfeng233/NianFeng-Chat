#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
// 项目全称：念风 Chat（NianFeng-Chat）
// 仓库：https://github.com/nianfeng233/NianFeng-Chat

mod app_assets;

use app_assets::{APP_FILES, BUILD_ID, NODE_EXE};
use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    window::WindowBuilder,
};
#[cfg(target_os = "windows")]
use tao::platform::windows::{WindowBuilderExtWindows, WindowExtWindows};
use wry::{http::Request, WebViewBuilder};

const APP_TITLE: &str = "念风chat";
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const WINDOW_ICON_RGBA: &[u8] = include_bytes!("../app.rgba");
const WINDOW_ICON_SIZE: u32 = 64;
/// 系统托盘通知（Shell_NotifyIcon）使用的固定图标 ID，避免重复通知互相覆盖。
#[cfg(target_os = "windows")]
const TRAY_ICON_ID: u32 = 0xF1;

#[derive(Debug, Clone)]
enum UserEvent {
    WindowAction(String),
    /// 前端通知服务通过 IPC 送来的系统通知（桌面宿主直接弹 Windows 通知）
    Notify {
        title: String,
        body: String,
        /// 64×64 PNG 的 base64（角色头像 / 念风 logo），由前端 canvas 生成
        icon: String,
    },
    /// 「关闭窗口时最小化」开关
    SetMinimizeOnClose(bool),
    /// 设置页保存 WebUI 监听配置后的一键重启（重启整个 exe）
    Restart,
}

/// 创建 WebView2 视图；独立成函数便于“安装 WebView2 后重试一次”。
fn build_webview(
    window: &tao::window::Window,
    url: String,
    init_script: String,
    proxy: EventLoopProxy<UserEvent>,
) -> Result<wry::WebView, Box<dyn std::error::Error>> {
    let view = WebViewBuilder::new()
        .with_url(url)
        .with_initialization_script(init_script)
        .with_accept_first_mouse(true)
        .with_ipc_handler(move |request: Request<String>| {
            let body = request.body().trim();
            if let Some(action) = body.strip_prefix("wind:") {
                if action == "restart" {
                    let _ = proxy.send_event(UserEvent::Restart);
                } else if let Some(value) = action.strip_prefix("minimize-on-close:") {
                    let _ = proxy.send_event(UserEvent::SetMinimizeOnClose(value == "1"));
                } else {
                    let _ = proxy.send_event(UserEvent::WindowAction(action.to_string()));
                }
                return;
            }
            if let Some(payload) = body.strip_prefix("notify:") {
                // 前端约定：kind\u0001title\u0001body；kind 由前端决定标题内容，宿主只负责弹系统通知。
                let mut parts = payload.split('\u{1}');
                let _kind = parts.next().unwrap_or("system");
                let title = parts.next().unwrap_or("念风").to_string();
                let body = parts.next().unwrap_or("").to_string();
                let icon = parts.next().unwrap_or("").to_string();
                let _ = proxy.send_event(UserEvent::Notify { title, body, icon });
            }
        })
        .build(window)?;
    Ok(view)
}

/// 判断 WebView2 初始化失败是否属于“Runtime 缺失/找不到文件”，避免其它错误也触发下载安装。
fn looks_like_webview2_missing(error: &str) -> bool {
    let text = error.to_lowercase();
    text.contains("0x80070002")
        || error.contains("系统找不到指定的文件")
        || text.contains("file not found")
        || text.contains("cannot find")
        || text.contains("webview2")
}

/// WebView2 安装器下载地址：优先国内加速镜像，官方作为兜底；环境变量可覆盖。
fn webview2_installer_urls() -> Vec<String> {
    let mut urls = Vec::new();
    if let Ok(value) = std::env::var("NIANFENG_WEBVIEW2_INSTALLER_URL") {
        let value = value.trim();
        if !value.is_empty() {
            urls.push(value.to_string());
        }
    }
    // 国内可访问性通常更好的加速代理（按顺序尝试）。
    for proxy in ["https://ghproxy.net/", "https://gh-proxy.com/", "https://mirror.ghproxy.com/"] {
        urls.push(format!("{proxy}https://go.microsoft.com/fwlink/p/?LinkId=2124703"));
    }
    // 官方兜底
    urls.push("https://go.microsoft.com/fwlink/p/?LinkId=2124703".to_string());
    urls
}

/// 用 curl / PowerShell 下载文件；只接受大于 500KB 的安装器，避免下载到错误页面。
fn download_file(url: &str, path: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let curl = Command::new("curl.exe")
            .args([
                "-L",
                "--fail",
                "--silent",
                "--show-error",
                "--connect-timeout",
                "15",
                "--max-time",
                "300",
                "-o",
            ])
            .arg(path)
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        if matches!(curl, Ok(status) if status.success()) {
            if fs::metadata(path).map(|meta| meta.len() > 500_000).unwrap_or(false) {
                return true;
            }
        }
        let escaped_url = url.replace('\'', "''");
        let escaped_path = path.to_string_lossy().replace('\'', "''");
        let command = format!(
            "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '{escaped_url}' -OutFile '{escaped_path}'"
        );
        let powershell = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &command])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        return matches!(powershell, Ok(status) if status.success())
            && fs::metadata(path).map(|meta| meta.len() > 500_000).unwrap_or(false);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (url, path);
        false
    }
}

/// 自动下载并静默安装 WebView2 Evergreen Bootstrapper。返回是否尝试过安装（调用方会重试 build）。
fn try_install_webview2(base_dir: &Path) -> bool {
    let dir = base_dir.join("webview2");
    let _ = fs::create_dir_all(&dir);
    let installer = dir.join("MicrosoftEdgeWebview2Setup.exe");
    let mut downloaded = fs::metadata(&installer).map(|meta| meta.len() > 500_000).unwrap_or(false);
    if !downloaded {
        // 离线场景：允许用户提前把安装器放到本机，并通过环境变量指定路径。
        if let Ok(local) = std::env::var("NIANFENG_WEBVIEW2_INSTALLER_PATH") {
            let local_path = PathBuf::from(local.trim());
            if local_path.is_file() && fs::metadata(&local_path).map(|meta| meta.len() > 500_000).unwrap_or(false) {
                let _ = fs::copy(&local_path, &installer);
                downloaded = fs::metadata(&installer).map(|meta| meta.len() > 500_000).unwrap_or(false);
            }
        }
    }
    if !downloaded {
        for url in webview2_installer_urls() {
            append_error_log(base_dir, &format!("正在下载 WebView2 安装器：{url}"));
            if download_file(&url, &installer) {
                downloaded = true;
                break;
            }
        }
    }
    if !downloaded {
        append_error_log(base_dir, "WebView2 安装器下载失败（可设置 NIANFENG_WEBVIEW2_INSTALLER_URL 指定镜像）");
        return false;
    }
    append_error_log(base_dir, "正在静默安装 WebView2 Runtime（可能需要 1~3 分钟）…");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let status = Command::new(&installer)
            .args(["/silent", "/install"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        append_error_log(base_dir, &format!("WebView2 安装器退出状态：{status:?}"));
        return true;
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

fn main() {
    if let Err(err) = run() {
        fail(&err.to_string());
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let base_dir = prepare_base_dir()?;
    // 按 BUILD_ID 使用独立运行时目录：升级 exe 时旧版本 node.exe 可能仍在运行，
    // 覆盖 runtime/node.exe 会触发“文件被占用(os error 32)”导致双击无反应。
    // 每个构建号一个目录，互不冲突；旧目录会尽力清理，清理失败不影响本次启动。
    let runtime_dir = base_dir.join(format!("runtime-{BUILD_ID}"));
    extract_app(&runtime_dir)?;
    cleanup_old_runtimes(&base_dir, &runtime_dir);

    let app_dir = runtime_dir.join("app");
    let node_path = runtime_dir.join("node.exe");
    // 把 WebView2 的用户数据目录也固定到可写位置，避免依赖系统 LOCALAPPDATA 权限。
    let webview_data_dir = base_dir.join("webview2");
    fs::create_dir_all(&webview_data_dir)?;
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_data_dir);

    // 桌面版支持在设置中固定 WebUI 端口：优先沿用上次实际端口；Node 会把最终端口写到 .webui-port。
    let preferred_port = fs::read_to_string(base_dir.join(".webui-port"))
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|value| *value > 0);
    let initial_port = preferred_port.unwrap_or(free_port()?);
    // NIANFENG_HOME_DIR 让后端把“本部署的数据目录指针”写到 base_dir/user_data；
    // 首次启动后端会按既有逻辑读取 %APPDATA%\nianfeng\instance.json 的历史目录，
    // 之后只认自己的指针，避免每次启动都覆盖数据目录。
    let mut child = spawn_node(&node_path, &app_dir, &base_dir, initial_port)?;
    let port = wait_runtime_port(&base_dir, initial_port, Duration::from_secs(6));

    if !wait_backend(port, READY_TIMEOUT) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("本地服务启动超时（端口 {port}）").into());
    }

    // 访问令牌不再以明文写入 .webui-token。哈希模式启动时 Node 也拿不到明文，
    // WebView 直接打开本机地址；若后端要求令牌且没有可用 Cookie，会显示令牌输入页。
    let webview_url = format!("http://127.0.0.1:{port}/");

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let proxy_for_ipc = proxy.clone();

    let window_icon = tao::window::Icon::from_rgba(
        WINDOW_ICON_RGBA.to_vec(),
        WINDOW_ICON_SIZE,
        WINDOW_ICON_SIZE,
    )
    .ok();
    let _taskbar_icon = window_icon.clone();
    let mut window_builder = WindowBuilder::new()
        .with_title(APP_TITLE)
        .with_decorations(false)
        .with_resizable(true)
        .with_window_icon(window_icon)
        .with_inner_size(LogicalSize::new(1280.0, 820.0))
        .with_min_inner_size(LogicalSize::new(980.0, 640.0));
    #[cfg(target_os = "windows")]
    {
        window_builder = window_builder.with_taskbar_icon(_taskbar_icon);
    }
    let window = window_builder.build(&event_loop)?;

    // 供前端读取：windHost 负责窗口按钮 / 拖动；WebView2 原生 app-region 也支持拖动。
    let init_script = r#"
      (function () {
        function post(message) {
          try {
            if (window.ipc && typeof window.ipc.postMessage === 'function') window.ipc.postMessage(message);
            else if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') window.chrome.webview.postMessage(message);
          } catch (_) {}
        }
        window.windHost = {
          window: function (action) { post('wind:' + String(action || '')); },
          setMinimizeOnClose: function (value) { post('wind:minimize-on-close:' + (value ? '1' : '0')); },
          minimize: function () { post('wind:min'); },
          maximize: function () { post('wind:max'); },
          restart: function () { post('wind:restart'); },
          notify: function (payload) {
            try {
              var p = payload || {};
              var clean = function (value) { return String(value == null ? '' : value).replace(/[\u0001\r\n]/g, ' '); };
              post('notify:' + clean(p.kind || 'system') + '\u0001' + clean(p.title || '念风') + '\u0001' + clean(p.body || '') + '\u0001' + String(p.icon || '').replace(/[^A-Za-z0-9+/=]/g, ''));
            } catch (_) {}
          },
        };
        document.addEventListener('mousedown', function (event) {
          if (event.button !== 0 || !event.target || !event.target.closest) return;
          if (event.target.closest('input, textarea, select, button, a, .win-btn, .sig-input')) return;
          if (!event.target.closest('.titlebar')) return;
          event.preventDefault();
          post('wind:drag');
        }, true);
      })();
    "#;

    // 云服务器 / Windows Server 通常没有 WebView2 Runtime。此时不再直接闪退，
    // 而是回退到“默认浏览器 + Node 后台继续运行”，保证 WebUI 仍然可用。
    let force_browser = std::env::args().any(|arg| arg == "--browser" || arg == "--no-webview")
        || matches!(
            std::env::var("NIANFENG_FORCE_BROWSER").ok().as_deref(),
            Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
        );
    let mut webview: Option<wry::WebView> = None;
    let mut fallback_detail = String::new();
    let no_install = std::env::args().any(|arg| arg == "--no-webview-install")
        || matches!(std::env::var("NIANFENG_NO_WEBVIEW_INSTALL").ok().as_deref(), Some("1") | Some("true") | Some("TRUE"));
    if force_browser {
        fallback_detail.push_str("已通过 --browser / NIANFENG_FORCE_BROWSER 强制使用浏览器模式。");
    } else {
        match build_webview(&window, webview_url.clone(), init_script.to_string(), proxy_for_ipc.clone()) {
            Ok(view) => webview = Some(view),
            Err(err) => {
                let err_text = err.to_string();
                fallback_detail = format!("WebView2 初始化失败：{err_text}");
                // 云服务器最常见的失败是缺少 WebView2 Runtime（HRESULT 0x80070002）。
                // 先尝试自动下载安装器并静默安装（国内镜像优先），安装成功后重试一次。
                if !no_install && looks_like_webview2_missing(&err_text) {
                    append_error_log(&base_dir, "检测到 WebView2 不可用，尝试自动下载并安装（优先国内镜像）…");
                    if try_install_webview2(&base_dir) {
                        match build_webview(&window, webview_url.clone(), init_script.to_string(), proxy_for_ipc.clone()) {
                            Ok(view) => {
                                webview = Some(view);
                                fallback_detail.clear();
                            }
                            Err(retry_err) => {
                                fallback_detail = format!("{fallback_detail}；自动安装后重试仍失败：{retry_err}");
                            }
                        }
                    } else {
                        fallback_detail.push_str("；WebView2 自动安装失败");
                    }
                }
            }
        }
    }

    if webview.is_none() {
        // 没有 WebView2 时退回浏览器；Node 服务继续后台运行。
        let _ = window.set_visible(false);
        append_error_log(&base_dir, &format!("WebView2 不可用，已回退到浏览器模式：{fallback_detail}"));
        let fallback_test = matches!(
            std::env::var("NIANFENG_FALLBACK_TEST").ok().as_deref(),
            Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
        );
        if !fallback_test {
            let opened = open_external_browser(&webview_url);
            show_browser_fallback(&fallback_detail, &webview_url, opened);
        }
        wait_child_exit(&mut child);
        return Ok(());
    }

    // window / webview / node 子进程都必须在事件循环期间保持存活。
    let window = Some(window);
    let mut webview = webview;
    let mut child = Some(child);
    // 「关闭窗口时最小化」：由前端设置页通过 IPC 同步，决定关闭按钮是否退出程序。
    let mut minimize_on_close = false;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                if minimize_on_close {
                    if let Some(window) = window.as_ref() {
                        window.set_minimized(true);
                    }
                    return;
                }
                if let Some(window) = window.as_ref() { window.set_visible(false); }
                stop_child(&mut child);
                let _ = webview.take();
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::WindowAction(action)) if action == "close" => {
                if minimize_on_close {
                    if let Some(window) = window.as_ref() {
                        window.set_minimized(true);
                    }
                    return;
                }
                if let Some(window) = window.as_ref() { window.set_visible(false); }
                stop_child(&mut child);
                let _ = webview.take();
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::SetMinimizeOnClose(value)) => {
                minimize_on_close = value;
            }
            Event::UserEvent(UserEvent::Restart) => {
                if let Some(window) = window.as_ref() { window.set_visible(false); }
                stop_child(&mut child);
                let _ = webview.take();
                if let Ok(exe) = std::env::current_exe() {
                    let _ = Command::new(exe).spawn();
                }
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::Notify { title, body, icon }) => {
                #[cfg(target_os = "windows")]
                if let Some(window) = window.as_ref() {
                    show_windows_notification(window.hwnd(), &title, &body, &icon);
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = (title, body, icon);
                }
            }
            Event::UserEvent(UserEvent::WindowAction(action)) => {
                let Some(window) = window.as_ref() else { return };
                match action.as_str() {
                    "min" => window.set_minimized(true),
                    "max" => window.set_maximized(!window.is_maximized()),
                    "drag" => {
                        let _ = window.drag_window();
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    })
}

fn prepare_base_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let new_dir = PathBuf::from(&local).join("NianFengChat");
        let old_dir = PathBuf::from(&local).join("FengyuChat");
        // 兼容旧品牌目录：旧数据存在且新目录还没建立时，先继续用旧目录，避免升级后丢历史。
        if old_dir.join("user_data").exists() && !new_dir.exists() {
            candidates.push(old_dir);
        }
        candidates.push(new_dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(".nianfeng"));
        }
    }
    candidates.push(std::env::temp_dir().join("NianFengChat"));

    for candidate in candidates {
        if fs::create_dir_all(&candidate).is_ok() {
            return Ok(candidate);
        }
    }
    Err("无法创建运行数据目录（LOCALAPPDATA / exe 同级 / TEMP 均不可写）".into())
}

fn fail(message: &str) -> ! {
    let line = format!("[{}] {message}\n", now_string());
    for dir in [
        std::env::var("LOCALAPPDATA").ok().map(|local| PathBuf::from(local).join("NianFengChat")),
        std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join(".nianfeng"))),
        Some(std::env::temp_dir().join("NianFengChat")),
    ]
    .into_iter()
    .flatten()
    {
        if fs::create_dir_all(&dir).is_ok() && fs::write(dir.join("error.log"), &line).is_ok() {
            break;
        }
    }
    show_fatal_message(&line);
    eprintln!("{line}");
    std::process::exit(1);
}

#[cfg(target_os = "windows")]
fn show_fatal_message(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND};
    let title: Vec<u16> = "念风chat 启动失败\0".encode_utf16().collect();
    let body: Vec<u16> = format!("{message}\n\n日志目录：%LOCALAPPDATA%\\NianFengChat\\error.log\0")
        .encode_utf16()
        .collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn show_fatal_message(_message: &str) {}

/// 用系统默认浏览器打开地址。避免 `cmd /c start` 对 URL 中 `&` 的二次解释，Windows 下走 ShellExecuteW。
fn open_external_browser(url: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let operation: Vec<u16> = "open\0".encode_utf16().collect();
        let file: Vec<u16> = format!("{url}\0").encode_utf16().collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        return result as isize > 32;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        Command::new(opener)
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok()
    }
}

/// 把浏览器回退 / WebView2 错误写进日志，方便云服务器排查。
fn append_error_log(base_dir: &Path, message: &str) {
    let path = base_dir.join("error.log");
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[{}] {message}", now_string());
    }
}

#[cfg(target_os = "windows")]
fn show_browser_fallback(detail: &str, url: &str, opened: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND, MB_TOPMOST,
    };
    let action = if opened {
        "已尝试用系统默认浏览器打开"
    } else {
        "浏览器没有自动打开，请手动在浏览器中访问"
    };
    let text = format!(
        "未能创建桌面窗口：当前系统没有可用的 Microsoft Edge WebView2 Runtime。\n\n{detail}\n\n{action}：\n{url}\n\n云服务器建议使用 Web 版「启动念风-无浏览器.cmd」，不需要 WebView2。\n\n念风服务会继续在后台运行；要停止，请在任务管理器中结束“念风Chat.exe”和 node.exe。\0"
    );
    let title: Vec<u16> = "念风chat · 已回退到浏览器模式\0".encode_utf16().collect();
    let body: Vec<u16> = text.encode_utf16().collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn show_browser_fallback(_detail: &str, _url: &str, _opened: bool) {}

/// 浏览器回退模式下等待 Node 子进程退出，避免 exe 提前结束导致服务停掉。
fn wait_child_exit(child: &mut Child) {
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => break,
            Ok(None) => thread::sleep(Duration::from_millis(250)),
        }
    }
}

fn now_string() -> String {
    // 避免引入时间库：使用 systemtime 转 unix 秒；日志只用于排查。
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn extract_app(base_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let app_dir = base_dir.join("app");
    let marker = base_dir.join(".build-id");
    if fs::read_to_string(&marker).ok().as_deref() == Some(BUILD_ID) && app_dir.exists() {
        return Ok(());
    }

    let _ = fs::remove_dir_all(base_dir);
    fs::create_dir_all(&app_dir)?;
    for (relative, contents) in APP_FILES {
        let target = app_dir.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&target, contents)?;
    }
    fs::write(base_dir.join("node.exe"), NODE_EXE)?;
    fs::write(&marker, BUILD_ID)?;
    Ok(())
}

/// 尽力清理旧构建的运行时目录；删除失败（旧 node.exe 还在运行）就保留，不影响新版本启动。
fn cleanup_old_runtimes(base_dir: &Path, current: &Path) {
    if let Ok(entries) = fs::read_dir(base_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path == current || !path.is_dir() {
                continue;
            }
            let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("");
            if name.starts_with("runtime-") {
                let _ = fs::remove_dir_all(&path);
            }
        }
    }
    // 旧版本使用固定 runtime/；被占用时忽略，新版本使用 runtime-<BUILD_ID>。
    let _ = fs::remove_dir_all(base_dir.join("runtime"));
}


fn free_port() -> Result<u16, Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

#[cfg(target_os = "windows")]
fn spawn_node(
    node_path: &Path,
    app_dir: &Path,
    home_dir: &Path,
    port: u16,
) -> Result<Child, Box<dyn std::error::Error>> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let _ = fs::remove_file(home_dir.join(".webui-port"));
    let _ = fs::remove_file(home_dir.join(".webui-token"));
    // 本体更新服务需要知道宿主 EXE 路径与 PID，更新时才重启对应的桌面版。
    let desktop_exe = std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let child = Command::new(node_path)
        .arg("start.mjs")
        .arg("--serve")
        .arg("--no-open")
        .current_dir(app_dir)
        .env("PORT", port.to_string())
        .env("NIANFENG_HOME_DIR", home_dir)
        .env("NIANFENG_NO_OPEN", "1")
        .env("NIANFENG_DESKTOP_EXE", desktop_exe)
        .env("NIANFENG_DESKTOP_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?;
    Ok(child)
}

#[cfg(not(target_os = "windows"))]
fn spawn_node(
    node_path: &Path,
    app_dir: &Path,
    home_dir: &Path,
    port: u16,
) -> Result<Child, Box<dyn std::error::Error>> {
    let _ = fs::remove_file(home_dir.join(".webui-port"));
    let _ = fs::remove_file(home_dir.join(".webui-token"));
    // 本体更新服务需要知道宿主 EXE 路径与 PID，更新时才重启对应的桌面版。
    let desktop_exe = std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let child = Command::new(node_path)
        .arg("start.mjs")
        .arg("--serve")
        .arg("--no-open")
        .current_dir(app_dir)
        .env("PORT", port.to_string())
        .env("NIANFENG_HOME_DIR", home_dir)
        .env("NIANFENG_NO_OPEN", "1")
        .env("NIANFENG_DESKTOP_EXE", desktop_exe)
        .env("NIANFENG_DESKTOP_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(child)
}

/// Windows 系统通知：通过 Shell_NotifyIcon 的托盘气泡通道发送。
///
/// 为什么不用 Web Notification API：WebView2 里的 Notification 权限默认是
/// denied，wry 也没有暴露权限接管接口。改由宿主直接调 Win32，既不需要授权，
/// 也能稳定出现在 Windows 右下角通知区域（Win10/11 会进入操作中心）。
#[cfg(target_os = "windows")]
fn show_windows_notification(hwnd: isize, title: &str, body: &str, icon_base64: &str) {
    use std::{ffi::c_void, mem::size_of, ptr};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Shell::{
        Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_INFO, NIIF_LARGE_ICON,
        NIIF_NOSOUND, NIIF_USER, NIM_ADD, NIM_MODIFY, NOTIFYICONDATAW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateIconFromResourceEx, LoadImageW, HICON, IMAGE_ICON, LR_DEFAULTSIZE,
    };

    const WM_APP: u32 = 0x8000;
    const TEXT_LIMIT_TITLE: usize = 64;
    const TEXT_LIMIT_BODY: usize = 256;
    const TEXT_LIMIT_TIP: usize = 128;

    /// UTF-16 固定长度字段：截断 + NUL 填充
    fn fixed<const N: usize>(value: &str) -> [u16; N] {
        let mut out = [0u16; N];
        for (index, unit) in value.encode_utf16().take(N.saturating_sub(1)).enumerate() {
            out[index] = unit;
        }
        out
    }

    // 应用自身图标（build.rs 把 app.ico 以资源 ID 1 嵌入），用于托盘与通知应用图标。
    let app_icon = unsafe {
        LoadImageW(
            GetModuleHandleW(ptr::null()),
            1usize as windows_sys::core::PCWSTR,
            IMAGE_ICON,
            0,
            0,
            LR_DEFAULTSIZE,
        )
    } as HICON;

    // 角色头像：前端 canvas 生成的 64×64 PNG（RT_ICON 支持 PNG），失败时回退到应用图标。
    let avatar_icon: HICON = decode_base64(icon_base64)
        .filter(|png| png.len() >= 8 && png[..8] == *b"\x89PNG\r\n\x1a\n")
        .map(|png| unsafe {
            CreateIconFromResourceEx(
                png.as_ptr(),
                png.len() as u32,
                1,
                0x0003_0000,
                64,
                64,
                0,
            )
        })
        .filter(|icon| !icon.is_null())
        .unwrap_or(app_icon);

    let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    data.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
    data.hWnd = hwnd as *mut c_void;
    data.uID = TRAY_ICON_ID;
    data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_INFO;
    data.uCallbackMessage = WM_APP + 1;
    data.hIcon = app_icon;
    data.hBalloonIcon = avatar_icon;
    data.szTip = fixed::<TEXT_LIMIT_TIP>("念风chat");
    data.szInfoTitle = fixed::<TEXT_LIMIT_TITLE>(title);
    data.szInfo = fixed::<TEXT_LIMIT_BODY>(body);
    // 提示音由前端的「声音提示」开关统一控制，系统气泡本身静音，避免双重响声。
    data.dwInfoFlags = if avatar_icon.is_null() {
        NIIF_INFO | NIIF_NOSOUND
    } else {
        NIIF_USER | NIIF_LARGE_ICON | NIIF_NOSOUND
    };

    let added = unsafe { Shell_NotifyIconW(NIM_ADD, &data) };
    if added == 0 {
        // 图标已存在（之前的通知还没清理）时改为更新内容。
        unsafe {
            Shell_NotifyIconW(NIM_MODIFY, &data);
        }
    }
}

/// 轻量 base64 解码：只用于系统通知头像，容忍 dataURL 前缀与换行。
fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let data = input.rsplit(',').next().unwrap_or(input);
    let mut out = Vec::with_capacity(data.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for byte in data.bytes() {
        let value = match byte {
            b'A'..=b'Z' => (byte - b'A') as u32,
            b'a'..=b'z' => (byte - b'a' + 26) as u32,
            b'0'..=b'9' => (byte - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => continue,
        };
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xFF) as u8);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 读取 Node 写下的实际 WebUI 端口（等待一小段时间）；文件不存在时回退到启动端口。
fn wait_runtime_port(home: &Path, fallback: u16, timeout: Duration) -> u16 {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if let Ok(raw) = fs::read_to_string(home.join(".webui-port")) {
            if let Ok(value) = raw.trim().parse::<u16>() {
                if value > 0 {
                    return value;
                }
            }
        }
        thread::sleep(Duration::from_millis(80));
    }
    fallback
}

fn wait_backend(port: u16, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if health_ok(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(120));
    }
    false
}

fn health_ok(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(350)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let request = format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

fn stop_child(child: &mut Option<Child>) {
    if let Some(mut child) = child.take() {
        // Windows 下 Node 可能还会拉起子进程；用进程树结束避免留下占用端口的孤儿进程。
        // 旧实现会同步等待 taskkill 并闪出黑色控制台窗口，这里改为异步 + CREATE_NO_WINDOW。
        let pid = child.id();
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let pid_text = pid.to_string();
            let _ = Command::new("taskkill")
                .args(["/PID", pid_text.as_str(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let pid_text = pid.to_string();
            let _ = Command::new("kill").args(["-9", pid_text.as_str()]).status();
        }
        // 不 wait()：让 taskkill 在后台清理整棵进程树，关闭按钮立即响应。
        let _ = child.kill();
    }
}
