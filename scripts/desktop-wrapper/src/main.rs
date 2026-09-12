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
    event_loop::{ControlFlow, EventLoopBuilder},
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

    // 启用 WebUI 访问令牌后，Node 会把 token 写到 <HOME>/.webui-token；
    // WebView 需要先带 ?token= 打开一次，以便后端下发访问 Cookie。
    let webui_token = fs::read_to_string(base_dir.join(".webui-token"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let webview_url = match &webui_token {
        Some(token) => format!("http://127.0.0.1:{port}/?token={}", encode_token(token)),
        None => format!("http://127.0.0.1:{port}/"),
    };

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

    let webview = WebViewBuilder::new()
        .with_url(webview_url)
        .with_initialization_script(init_script)
        .with_accept_first_mouse(true)
        .with_ipc_handler(move |request: Request<String>| {
            let body = request.body().trim();
            if let Some(action) = body.strip_prefix("wind:") {
                if action == "restart" {
                    let _ = proxy_for_ipc.send_event(UserEvent::Restart);
                } else if let Some(value) = action.strip_prefix("minimize-on-close:") {
                    let _ = proxy_for_ipc.send_event(UserEvent::SetMinimizeOnClose(value == "1"));
                } else {
                    let _ = proxy_for_ipc.send_event(UserEvent::WindowAction(action.to_string()));
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
                let _ = proxy_for_ipc.send_event(UserEvent::Notify { title, body, icon });
            }
        })
        .build(&window)?;

    // window / webview / node 子进程都必须在事件循环期间保持存活。
    let window = Some(window);
    let mut webview = Some(webview);
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
                stop_child(&mut child);
                let _ = webview.take();
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::SetMinimizeOnClose(value)) => {
                minimize_on_close = value;
            }
            Event::UserEvent(UserEvent::Restart) => {
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

/// URL 查询参数编码：访问令牌可能包含需要转义的字符
fn encode_token(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
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
    let child = Command::new(node_path)
        .arg("server/index.mjs")
        .current_dir(app_dir)
        .env("PORT", port.to_string())
        .env("NIANFENG_STATIC_DIR", ".")
        .env("NIANFENG_HOME_DIR", home_dir)
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
    let child = Command::new(node_path)
        .arg("server/index.mjs")
        .current_dir(app_dir)
        .env("PORT", port.to_string())
        .env("NIANFENG_STATIC_DIR", ".")
        .env("NIANFENG_HOME_DIR", home_dir)
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
        // Windows 下 Node 可能还会拉起子进程；先按进程树结束，避免关闭 exe 后
        // 后台仍有 node/模型进程占用端口，导致下次启动或迁移数据异常。
        #[cfg(target_os = "windows")]
        {
            let pid = child.id().to_string();
            let _ = Command::new("taskkill")
                .args(["/PID", pid.as_str(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}
