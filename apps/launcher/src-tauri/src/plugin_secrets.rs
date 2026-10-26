//! Secret plugin settings (fields a plugin manifest marks `secret`) live in the Windows Credential Manager,
//! like model keys. Only a game launch receives them, and only for enabled plugins.
use serde_json::{Map, Value};

const SERVICE: &str = "Perspectra";

fn valid_plugin(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && id.as_bytes()[0] != b'-'
}

fn valid_field(name: &str) -> bool {
    !name.is_empty() && name.len() <= 40 && name.as_bytes()[0].is_ascii_alphabetic()
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn entry(plugin: &str, field: &str) -> Result<keyring::Entry, String> {
    if !valid_plugin(plugin) || !valid_field(field) {
        return Err("插件密钥标识无效。".into());
    }
    keyring::Entry::new(SERVICE, &format!("plugin-config/{plugin}/{field}")).map_err(|_| "无法访问系统凭据管理器。".into())
}

pub fn get(plugin: &str, field: &str) -> Option<String> {
    entry(plugin, field).ok()?.get_password().ok()
}

/// An empty value clears the stored one.
pub fn set(plugin: &str, field: &str, value: &str) -> Result<(), String> {
    if value.len() > 8192 {
        return Err("插件密钥过长。".into());
    }
    let entry = entry(plugin, field)?;
    if value.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("无法清除已保存的插件密钥。".into()),
        };
    }
    entry.set_password(value).map_err(|_| "无法保存插件密钥到系统凭据管理器。".into())
}

pub fn remove(plugin: &str, field: &str) {
    if let Ok(entry) = entry(plugin, field) {
        entry.delete_credential().ok();
    }
}

/// `(plugin id, path, enabled, secret fields)` for each saved plugin, from a Launcher snapshot.
fn plugins(snapshot: &Value) -> Vec<(String, String, bool, Vec<String>)> {
    let Some(list) = snapshot["preferences"]["hostPlugins"].as_array() else { return vec![] };
    list.iter()
        .filter_map(|plugin| {
            let id = plugin["id"].as_str()?.to_string();
            let fields = snapshot["pluginManifests"][&id]["manifest"]["config"]
                .as_object()
                .map(|config| {
                    config.iter().filter(|(_, field)| field["secret"] == Value::Bool(true)).map(|(name, _)| name.clone()).collect()
                })
                .unwrap_or_default();
            Some((id, plugin["path"].as_str().unwrap_or_default().to_string(), plugin["enabled"] == Value::Bool(true), fields))
        })
        .collect()
}

/// Replaces any `pluginSecrets` the page sent; a launch gets the stored ones for enabled plugins.
pub fn inject(request: &mut Value, snapshot: Option<&Value>, lookup: impl Fn(&str, &str) -> Option<String>) {
    let Some(object) = request.as_object_mut() else { return };
    object.remove("pluginSecrets");
    let Some(snapshot) = snapshot else { return };
    let mut secrets = Map::new();
    for (id, _, enabled, fields) in plugins(snapshot) {
        if !enabled {
            continue;
        }
        let values: Map<String, Value> =
            fields.iter().filter_map(|field| lookup(&id, field).map(|value| (field.clone(), Value::String(value)))).collect();
        if !values.is_empty() {
            secrets.insert(id, Value::Object(values));
        }
    }
    if !secrets.is_empty() {
        object.insert("pluginSecrets".into(), Value::Object(secrets));
    }
}

/// Secrets to delete after settings change: a removed plugin, or one now pointing at another file,
/// must not keep handing the old plugin's secrets to whatever runs under that ID.
pub fn stale(before: &Value, after: &Value) -> Vec<(String, String)> {
    let current: Vec<(String, String)> = plugins(after).into_iter().map(|(id, path, _, _)| (id, path)).collect();
    plugins(before)
        .into_iter()
        .filter(|(id, path, _, _)| !current.iter().any(|(next_id, next_path)| next_id == id && next_path == path))
        .flat_map(|(id, _, _, fields)| fields.into_iter().map(move |field| (id.clone(), field)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(plugins: Value) -> Value {
        json!({
            "preferences": { "hostPlugins": plugins },
            "pluginManifests": {
                "tts": { "manifest": { "config": {
                    "endpoint": { "type": "string", "title": "地址" },
                    "apiKey": { "type": "string", "title": "Key", "secret": true }
                } } },
                "plain": { "missing": true }
            }
        })
    }

    #[test]
    fn a_launch_gets_stored_secrets_for_enabled_plugins_only() {
        let snap = snapshot(json!([
            { "id": "tts", "path": "D:/p/tts.mjs", "enabled": true },
            { "id": "plain", "path": "D:/p/plain.mjs", "enabled": true }
        ]));
        let mut request = json!({ "operation": "start", "pluginSecrets": { "tts": { "apiKey": "from-page" } } });
        inject(&mut request, Some(&snap), |id, field| (id == "tts" && field == "apiKey").then(|| "stored".to_string()));
        assert_eq!(request["pluginSecrets"], json!({ "tts": { "apiKey": "stored" } }));

        let disabled = snapshot(json!([{ "id": "tts", "path": "D:/p/tts.mjs", "enabled": false }]));
        let mut request = json!({ "operation": "start" });
        inject(&mut request, Some(&disabled), |_, _| Some("stored".to_string()));
        assert!(request.get("pluginSecrets").is_none());
    }

    #[test]
    fn other_requests_never_carry_page_supplied_secrets() {
        let mut request = json!({ "operation": "preferences", "pluginSecrets": { "tts": { "apiKey": "x" } } });
        inject(&mut request, None, |_, _| Some("stored".to_string()));
        assert!(request.get("pluginSecrets").is_none());
    }

    #[test]
    fn secrets_are_dropped_when_a_plugin_is_removed_or_points_at_another_file() {
        let before = snapshot(json!([{ "id": "tts", "path": "D:/p/tts.mjs", "enabled": true }]));
        let same = snapshot(json!([{ "id": "tts", "path": "D:/p/tts.mjs", "enabled": false }]));
        assert!(stale(&before, &same).is_empty());
        let moved = snapshot(json!([{ "id": "tts", "path": "D:/other/tts.mjs", "enabled": true }]));
        assert_eq!(stale(&before, &moved), vec![("tts".to_string(), "apiKey".to_string())]);
        let removed = snapshot(json!([]));
        assert_eq!(stale(&before, &removed), vec![("tts".to_string(), "apiKey".to_string())]);
    }

    #[test]
    fn identifiers_are_checked_before_touching_the_credential_store() {
        assert!(valid_plugin("tts") && valid_plugin("demo-bgm") && !valid_plugin("-x") && !valid_plugin("A") && !valid_plugin(""));
        assert!(valid_field("apiKey") && valid_field("api_key2") && !valid_field("1key") && !valid_field("a/b") && !valid_field(""));
        assert!(entry("../x", "apiKey").is_err());
    }
}
