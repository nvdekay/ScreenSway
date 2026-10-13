//! Optional, anonymous usage statistics.
//!
//! Nothing is sent until the user turns sharing on. An event is a name from a fixed
//! list plus a few short labels (for example `quality: "4k"`); recordings, audio,
//! captions, file names and paths never leave the computer. Events are batched on a
//! background thread and dropped if the network is unavailable.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

/// The analytics API (apps/analytics). Empty disables telemetry entirely.
const DEFAULT_ENDPOINT: &str = "";
const EVENTS: &[&str] = &[
    "app_open",
    "telemetry_enabled",
    "recording_started",
    "recording_finished",
    "recording_failed",
    "recording_opened",
    "export_finished",
    "export_failed",
    "export_cancelled",
    "captions_generated",
    "captions_failed",
    "style_applied",
];
const MAX_PROPS: usize = 12;
const MAX_BATCH: usize = 20;
const BATCH_WINDOW: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    /// `None` until the user has answered the first-run question.
    enabled: Option<bool>,
    install_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryStatus {
    /// False when this build has no analytics endpoint; the UI then hides the option.
    available: bool,
    enabled: Option<bool>,
}

struct Event {
    name: String,
    props: Map<String, Value>,
    locale: Option<String>,
}

#[derive(Default)]
pub struct Telemetry {
    stored: Mutex<Stored>,
    path: Mutex<Option<PathBuf>>,
    sender: Mutex<Option<mpsc::Sender<Event>>>,
}

fn endpoint() -> Option<String> {
    let value = std::env::var("SCREENSWAY_ANALYTICS_URL")
        .ok()
        .or_else(|| option_env!("SCREENSWAY_ANALYTICS_URL").map(str::to_owned))
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_owned());
    let value = value.trim().trim_end_matches('/').to_owned();
    (!value.is_empty()).then_some(value)
}

/// A random identifier for this installation. It is not derived from hardware or
/// the user account, so it cannot be traced back to a person or a machine.
fn random_install_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    (0..2u8)
        .map(|part| {
            let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
            hasher.write_u128(nanos);
            hasher.write_u8(part);
            format!("{:016x}", hasher.finish())
        })
        .collect()
}

fn load(path: &Path) -> Stored {
    let mut stored: Stored = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let valid = stored.install_id.len() == 32 && stored.install_id.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !valid {
        stored.install_id = random_install_id();
    }
    stored
}

fn save(path: &Path, stored: &Stored) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(stored).map_err(|error| error.to_string())?;
    std::fs::write(path, bytes).map_err(|error| error.to_string())
}

fn is_label(text: &str) -> bool {
    let count = text.chars().count();
    (1..=40).contains(&count)
        && text.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '_' | '.' | ':' | '+' | '<' | '>' | '×' | '-'))
}

fn is_key(text: &str) -> bool {
    (1..=24).contains(&text.len())
        && text.starts_with(|ch: char| ch.is_ascii_lowercase())
        && text.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

/// Keeps booleans, numbers and short labels. Anything that could be free text or a
/// path (slashes, long strings, nested values) is dropped.
fn clean_props(props: Map<String, Value>) -> Map<String, Value> {
    props
        .into_iter()
        .filter(|(key, value)| {
            is_key(key)
                && match value {
                    Value::Bool(_) => true,
                    Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
                    Value::String(text) => is_label(text),
                    _ => false,
                }
        })
        .take(MAX_PROPS)
        .collect()
}

fn platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn payload(install_id: &str, events: &[Event]) -> Value {
    serde_json::json!({
        "source": "app",
        "installId": install_id,
        "version": env!("CARGO_PKG_VERSION"),
        "os": platform(),
        "locale": events.iter().rev().find_map(|event| event.locale.clone()),
        "events": events.iter().map(|event| serde_json::json!({ "name": event.name, "props": event.props })).collect::<Vec<_>>(),
    })
}

fn send(agent: &ureq::Agent, endpoint: &str, body: &Value) {
    // Statistics are best-effort: a failed request is dropped, never retried or stored.
    let _ = agent
        .post(&format!("{endpoint}/v1/events"))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string());
}

fn spawn_sender(endpoint: String, install_id: String) -> Option<mpsc::Sender<Event>> {
    let connector = native_tls::TlsConnector::new().ok()?;
    let agent = ureq::AgentBuilder::new()
        .tls_connector(Arc::new(connector))
        .timeout(Duration::from_secs(8))
        .build();
    let (sender, receiver) = mpsc::channel::<Event>();
    std::thread::Builder::new()
        .name("telemetry".into())
        .spawn(move || {
            while let Ok(first) = receiver.recv() {
                let mut batch = vec![first];
                let deadline = std::time::Instant::now() + BATCH_WINDOW;
                while batch.len() < MAX_BATCH {
                    match receiver.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
                        Ok(event) => batch.push(event),
                        Err(_) => break,
                    }
                }
                send(&agent, &endpoint, &payload(&install_id, &batch));
            }
        })
        .ok()?;
    Some(sender)
}

impl Telemetry {
    /// Loads the saved choice. Called once at startup with the app's config folder.
    pub fn init(&self, directory: PathBuf) {
        let path = directory.join("telemetry.json");
        if let (Ok(mut stored), Ok(mut slot)) = (self.stored.lock(), self.path.lock()) {
            *stored = load(&path);
            *slot = Some(path);
        }
    }

    pub fn status(&self) -> TelemetryStatus {
        TelemetryStatus {
            available: endpoint().is_some(),
            enabled: self.stored.lock().ok().and_then(|stored| stored.enabled),
        }
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        let mut stored = self.stored.lock().map_err(|_| "Telemetry state is unavailable.")?;
        stored.enabled = Some(enabled);
        if let Some(path) = self.path.lock().map_err(|_| "Telemetry state is unavailable.")?.as_ref() {
            save(path, &stored)?;
        }
        if !enabled {
            // Dropping the channel ends the sender thread and discards anything queued.
            if let Ok(mut sender) = self.sender.lock() {
                *sender = None;
            }
        }
        Ok(())
    }

    pub fn track(&self, name: &str, props: Map<String, Value>, locale: Option<String>) {
        if !EVENTS.contains(&name) {
            return;
        }
        let Some(endpoint) = endpoint() else { return };
        let Ok(stored) = self.stored.lock() else { return };
        if stored.enabled != Some(true) {
            return;
        }
        let Ok(mut sender) = self.sender.lock() else { return };
        if sender.is_none() {
            *sender = spawn_sender(endpoint, stored.install_id.clone());
        }
        if let Some(channel) = sender.as_ref() {
            let _ = channel.send(Event {
                name: name.to_owned(),
                props: clean_props(props),
                locale: locale.filter(|value| is_label(value)),
            });
        }
    }
}

#[tauri::command]
pub fn telemetry_status(state: tauri::State<'_, Telemetry>) -> TelemetryStatus {
    state.status()
}

#[tauri::command]
pub fn set_telemetry(state: tauri::State<'_, Telemetry>, enabled: bool) -> Result<TelemetryStatus, String> {
    state.set_enabled(enabled)?;
    Ok(state.status())
}

#[tauri::command]
pub fn track_event(state: tauri::State<'_, Telemetry>, name: String, props: Option<Map<String, Value>>, locale: Option<String>) {
    state.track(&name, props.unwrap_or_default(), locale);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn props(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn props_keep_labels_and_drop_anything_that_could_identify_a_file() {
        let cleaned = clean_props(props(serde_json::json!({
            "quality": "4k",
            "aspect": "16:9",
            "duration": "<30s",
            "captions": true,
            "zooms": 3,
            "path": "/Users/someone/Movies/ScreenSway/demo.mp4",
            "windows_path": "C:\\Users\\someone\\Videos\\demo.mp4",
            "title": "Quarterly numbers — do not share with anyone outside the team",
            "Upper": "x",
            "nested": { "a": 1 },
            "list": ["a"],
            "empty": "",
        })));
        let mut keys: Vec<_> = cleaned.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["aspect", "captions", "duration", "quality", "zooms"]);
    }

    #[test]
    fn install_ids_are_random_hex() {
        let (first, second) = (random_install_id(), random_install_id());
        assert_eq!(first.len(), 32);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn the_choice_is_remembered_and_damaged_files_start_undecided() {
        let directory = std::env::temp_dir().join(format!("screensway-telemetry-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        let telemetry = Telemetry::default();
        telemetry.init(directory.clone());
        assert_eq!(telemetry.status().enabled, None);
        let install_id = telemetry.stored.lock().unwrap().install_id.clone();

        telemetry.set_enabled(true).unwrap();
        let reopened = Telemetry::default();
        reopened.init(directory.clone());
        assert_eq!(reopened.status().enabled, Some(true));
        assert_eq!(reopened.stored.lock().unwrap().install_id, install_id);

        reopened.set_enabled(false).unwrap();
        assert_eq!(load(&directory.join("telemetry.json")).enabled, Some(false));

        std::fs::write(directory.join("telemetry.json"), b"{not json").unwrap();
        let damaged = load(&directory.join("telemetry.json"));
        assert_eq!(damaged.enabled, None);
        assert_eq!(damaged.install_id.len(), 32);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn nothing_is_queued_before_the_user_agrees() {
        let telemetry = Telemetry::default();
        telemetry.track("app_open", Map::new(), None);
        assert!(telemetry.sender.lock().unwrap().is_none());
        telemetry.stored.lock().unwrap().enabled = Some(false);
        telemetry.track("app_open", Map::new(), None);
        assert!(telemetry.sender.lock().unwrap().is_none());
        // Unknown names are ignored even when sharing is on.
        telemetry.stored.lock().unwrap().enabled = Some(true);
        telemetry.track("not_an_event", Map::new(), None);
        assert!(telemetry.sender.lock().unwrap().is_none());
    }

    /// Sends real events to a running analytics API:
    /// `SCREENSWAY_ANALYTICS_URL=http://localhost:8787 cargo test --lib live -- --ignored`
    #[test]
    #[ignore = "needs a running analytics API"]
    fn live_events_reach_the_api() {
        let telemetry = Telemetry::default();
        telemetry.stored.lock().unwrap().enabled = Some(true);
        telemetry.stored.lock().unwrap().install_id = random_install_id();
        telemetry.track("app_open", Map::new(), Some("vi".into()));
        telemetry.track("export_finished", props(serde_json::json!({ "quality": "4k", "path": "/tmp/secret.mp4" })), Some("vi".into()));
        assert!(telemetry.sender.lock().unwrap().is_some(), "set SCREENSWAY_ANALYTICS_URL");
        std::thread::sleep(BATCH_WINDOW + Duration::from_secs(2));
    }

    #[test]
    fn the_payload_carries_only_anonymous_fields() {
        let events = [Event { name: "export_finished".into(), props: props(serde_json::json!({ "quality": "4k" })), locale: Some("vi".into()) }];
        let body = payload(&"a".repeat(32), &events);
        let mut keys: Vec<_> = body.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["events", "installId", "locale", "os", "source", "version"]);
        assert_eq!(body["events"][0], serde_json::json!({ "name": "export_finished", "props": { "quality": "4k" } }));
    }
}
