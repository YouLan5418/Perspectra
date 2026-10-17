//! Model connection keys live in the Windows Credential Manager.
//! They are injected into forwarded requests and never written by the Node core.
use serde_json::{Map, Value};

const SERVICE: &str = "Perspectra";

fn entry(id: &str) -> Result<keyring::Entry, String> {
    if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("连接标识无效。".into());
    }
    keyring::Entry::new(SERVICE, &format!("model-connection/{id}")).map_err(|_| "无法访问系统凭据管理器。".into())
}

/// A missing or unreadable entry means "no key": local gateways often need none.
pub fn get(id: &str) -> Option<String> {
    entry(id).ok()?.get_password().ok()
}

/// An empty key clears the stored one.
pub fn set(id: &str, key: &str) -> Result<(), String> {
    if key.len() > 8192 {
        return Err("API Key 无效。".into());
    }
    let entry = entry(id)?;
    if key.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("无法清除已保存的 API Key。".into()),
        };
    }
    entry.set_password(key).map_err(|_| "无法保存 API Key 到系统凭据管理器。".into())
}

pub fn remove(id: &str) {
    if let Ok(entry) = entry(id) {
        entry.delete_credential().ok();
    }
}

/// Scheme, host and port; a key must not follow its connection to another provider.
pub fn same_origin(old: &str, new: &str) -> bool {
    // Endpoints arrive normalised by the Node core (URL.href), so scheme://authority is enough.
    fn origin(url: &str) -> Option<String> {
        let (scheme, rest) = url.split_once("://")?;
        let authority = rest.split('/').next()?;
        Some(format!("{}://{}", scheme, authority).to_ascii_lowercase())
    }
    matches!((origin(old), origin(new)), (Some(a), Some(b)) if a == b)
}

/// Replaces any `apiKeys` the page sent with the stored keys for `ids`.
pub fn inject(request: &mut Value, ids: &[String], lookup: impl Fn(&str) -> Option<String>) {
    let Some(object) = request.as_object_mut() else { return };
    object.remove("apiKeys");
    let keys: Map<String, Value> = ids.iter().filter_map(|id| lookup(id).map(|key| (id.clone(), Value::String(key)))).collect();
    if !keys.is_empty() {
        object.insert("apiKeys".into(), Value::Object(keys));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn inject_replaces_page_supplied_keys_with_stored_ones() {
        let mut request = json!({"operation":"list-models","connectionId":"a","apiKeys":{"a":"from-page"}});
        inject(&mut request, &["a".into()], |id| (id == "a").then(|| "stored".to_string()));
        assert_eq!(request["apiKeys"], json!({"a":"stored"}));
    }

    #[test]
    fn inject_skips_connections_without_a_stored_key() {
        let mut request = json!({"operation":"start"});
        inject(&mut request, &["a".into(), "b".into()], |id| (id == "b").then(|| "k".to_string()));
        assert_eq!(request["apiKeys"], json!({"b":"k"}));
    }

    #[test]
    fn keys_follow_a_connection_only_within_the_same_origin() {
        assert!(same_origin("http://127.0.0.1:8046/v1/chat/completions", "http://127.0.0.1:8046/v2/chat/completions"));
        assert!(!same_origin("https://api.deepseek.com/chat/completions", "https://gateway.example/v1/chat/completions"));
        assert!(!same_origin("http://127.0.0.1:8046/v1/chat/completions", "http://127.0.0.1:8047/v1/chat/completions"));
        assert!(!same_origin("https://api.example/v1/messages", "http://api.example/v1/messages"));
        assert!(same_origin("https://API.example/v1/messages", "https://api.example/v1/messages"));
    }

    #[test]
    fn inject_omits_the_field_when_nothing_is_stored() {
        let mut request = json!({"operation":"start","apiKeys":{"a":"from-page"}});
        inject(&mut request, &["a".into()], |_| None);
        assert!(request.get("apiKeys").is_none());
    }
}
