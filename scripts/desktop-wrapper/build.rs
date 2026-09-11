// 将 app.ico 嵌入 Windows 可执行文件资源；在其他平台自动跳过。
use std::{
    env, fs,
    path::PathBuf,
    process::Command,
};

fn main() {
    println!("cargo:rerun-if-changed=app.ico");
    println!("cargo:rerun-if-changed=build.rs");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let icon = manifest_dir.join("app.ico");
    if !icon.exists() {
        println!("cargo:warning=app.ico 不存在，跳过图标嵌入");
        return;
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let rc_file = out_dir.join("app.rc");
    let res_file = out_dir.join("app.res");
    let icon_path = icon.to_string_lossy().replace('\\', "/");
    let content = format!("1 ICON \"{icon_path}\"\n");
    if fs::write(&rc_file, content).is_err() {
        return;
    }

    let Some(rc_exe) = find_rc() else {
        println!("cargo:warning=未找到 rc.exe，跳过图标嵌入");
        return;
    };

    let status = Command::new(rc_exe)
        .arg("/nologo")
        .arg("/fo")
        .arg(&res_file)
        .arg(&rc_file)
        .current_dir(&manifest_dir)
        .status();
    match status {
        Ok(status) if status.success() && res_file.exists() => {
            println!("cargo:rustc-link-arg={}", res_file.display());
        }
        Ok(status) => println!("cargo:warning=rc.exe 退出码：{status}"),
        Err(err) => println!("cargo:warning=调用 rc.exe 失败：{err}"),
    }
}

fn find_rc() -> Option<PathBuf> {
    if let Ok(path) = env::var("RC") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    if let Ok(output) = Command::new("where").arg("rc.exe").output() {
        if output.status.success() {
            if let Some(first) = String::from_utf8_lossy(&output.stdout).lines().next() {
                let candidate = PathBuf::from(first.trim());
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }

    let mut roots = Vec::new();
    if let Ok(program_files) = env::var("ProgramFiles(x86)") {
        roots.push(PathBuf::from(program_files).join("Windows Kits").join("10").join("bin"));
    }
    if let Ok(program_files) = env::var("ProgramFiles") {
        roots.push(PathBuf::from(program_files).join("Windows Kits").join("10").join("bin"));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(root) else { continue };
        for entry in entries.flatten() {
            let path = entry.path().join("x64").join("rc.exe");
            if path.exists() {
                candidates.push(path);
            }
        }
    }
    candidates.sort();
    candidates.pop()
}
