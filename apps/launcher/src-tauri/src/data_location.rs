use std::{fs, path::{Path, PathBuf}};
use serde_json::{json, Value};

pub fn load(config: &Path, fallback: &Path) -> Result<PathBuf, String> {
    match fs::read(config) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| "数据位置设置损坏，请检查 launcher-location.json。")?;
            let root = PathBuf::from(value["directory"].as_str().ok_or("数据位置设置无效。")?);
            if !root.is_absolute() { return Err("数据位置必须为绝对路径。".into()); }
            Ok(root)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(fallback.into()),
        Err(_) => Err("无法读取数据位置设置。".into()),
    }
}

pub fn save(config: &Path, directory: &Path, current: &Path) -> Result<PathBuf, String> {
    if !directory.is_absolute() || !directory.is_dir() { return Err("请选择已存在的绝对目录。".into()); }
    let target = fs::canonicalize(directory).map_err(|_| "无法访问所选目录。")?;
    let current = fs::canonicalize(current).map_err(|_| "无法访问当前数据目录。")?;
    if target != current && (target.starts_with(&current) || current.starts_with(&target)) {
        return Err("新目录不能与当前数据目录互相包含，请选择独立目录。".into());
    }
    // A populated unrelated folder must not become a Launcher data root accidentally.
    if target != current && fs::read_dir(&target).map_err(|_| "无法读取所选目录。")?.next().is_some()
        && !target.join("launcher.json").is_file() {
        return Err("请选择空目录，或已有 Perspectra 数据的目录。".into());
    }
    let probe = target.join(format!(".perspectra-write-check-{}", std::process::id()));
    let file = fs::OpenOptions::new().write(true).create_new(true).open(&probe).map_err(|_| "所选目录不可写。")?;
    drop(file);
    fs::remove_file(&probe).map_err(|_| "无法清理目录写入检查文件。")?;
    fs::create_dir_all(config.parent().ok_or("设置路径无效。")?).map_err(|_| "无法创建设置目录。")?;
    let temporary = config.with_extension("tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(&json!({"directory":directory})).unwrap()).map_err(|_| "无法保存数据位置。")?;
    fs::rename(&temporary, config).map_err(|_| "无法提交数据位置设置。")?;
    Ok(directory.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn location_changes_only_config_and_keeps_old_data() {
        let base = std::env::temp_dir().join(format!("perspectra-location-test-{}", std::process::id()));
        fs::create_dir_all(base.join("old")).unwrap();
        fs::create_dir_all(base.join("new")).unwrap();
        let config=base.join("config/location.json");
        let old=base.join("old"); let new=base.join("new");
        fs::write(old.join("save.db"), b"unchanged").unwrap();
        assert_eq!(load(&config,&old).unwrap(),old);
        save(&config,&new,&old).unwrap();
        assert_eq!(load(&config,&old).unwrap(),new);
        assert_eq!(fs::read(old.join("save.db")).unwrap(),b"unchanged");
        assert!(fs::read_dir(&new).unwrap().next().is_none());
        fs::create_dir(old.join("child")).unwrap();
        assert!(save(&config,&old.join("child"),&old).is_err());
        fs::create_dir(base.join("unrelated")).unwrap();
        fs::write(base.join("unrelated/private.txt"), b"private").unwrap();
        assert!(save(&config,&base.join("unrelated"),&old).is_err());
        assert_eq!(load(&config,&old).unwrap(),new);
        save(&config,&old,&old).unwrap();
        assert_eq!(load(&config,&old).unwrap(),old);
        fs::write(&config,b"bad-json").unwrap();
        assert!(load(&config,&old).is_err());
        fs::remove_dir_all(base).unwrap();
    }
}
