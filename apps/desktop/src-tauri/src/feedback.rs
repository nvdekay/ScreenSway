//! Feedback the user writes and sends from the app.
//!
//! Unlike the usage statistics this is an explicit, one-off send the user starts, so
//! it does not wait for the statistics choice. Only what the form shows is sent: the
//! category, an optional rating, the message, an optional reply address and, when the
//! user leaves it checked, the app version, system, language and this launch's
//! session ID. Recordings, file names and paths are never part of it.

use crate::telemetry;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

const CATEGORIES: &[&str] = &["idea", "bug", "feature", "experience", "other"];
const MAX_MESSAGE: usize = 4_000;
const MAX_EMAIL: usize = 254;
/// The hidden form field only automated senders fill in; the server drops those.
const MAX_HONEYPOT: usize = 200;

/// What the feedback form sends (FeedbackDialog.tsx).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackRequest {
    category: String,
    rating: Option<u8>,
    message: String,
    email: Option<String>,
    include_metadata: bool,
    locale: Option<String>,
    #[serde(default)]
    website: String,
}

/// Message keys the form translates.
const ERROR_INVALID: &str = "feedback.errorInvalid";
const ERROR_NETWORK: &str = "feedback.errorNetwork";
const ERROR_RATE_LIMITED: &str = "feedback.errorRateLimited";
const ERROR_UNAVAILABLE: &str = "feedback.errorUnavailable";

fn is_email(text: &str) -> bool {
    let Some((local, domain)) = text.split_once('@') else { return false };
    text.chars().count() <= MAX_EMAIL
        && !local.is_empty()
        && !domain.contains('@')
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !text.chars().any(|ch| ch.is_whitespace() || ch.is_control())
}

/// Checks the form the way the server does and builds the request body.
fn payload(request: &FeedbackRequest) -> Result<Value, &'static str> {
    if !CATEGORIES.contains(&request.category.as_str()) {
        return Err(ERROR_INVALID);
    }
    if request.rating.is_some_and(|rating| !(1..=5).contains(&rating)) {
        return Err(ERROR_INVALID);
    }
    let message = request.message.trim();
    if message.is_empty() || message.chars().count() > MAX_MESSAGE {
        return Err(ERROR_INVALID);
    }
    let email = request.email.as_deref().map(str::trim).filter(|email| !email.is_empty());
    if email.is_some_and(|email| !is_email(email)) {
        return Err(ERROR_INVALID);
    }
    let mut body = serde_json::json!({
        "source": "app",
        "category": request.category,
        "rating": request.rating,
        "message": message,
        "email": email,
        "includeMetadata": request.include_metadata,
        "website": request.website.chars().take(MAX_HONEYPOT).collect::<String>(),
    });
    if request.include_metadata {
        let mut metadata = serde_json::Map::new();
        for (key, value) in [
            ("version", Some(env!("CARGO_PKG_VERSION").to_owned())),
            ("os", Some(telemetry::platform())),
            ("locale", request.locale.clone()),
            ("sessionId", Some(telemetry::session_id().to_owned())),
        ] {
            if let Some(value) = value.filter(|value| telemetry::is_label(value)) {
                metadata.insert(key.into(), Value::String(value));
            }
        }
        body["metadata"] = Value::Object(metadata);
    }
    Ok(body)
}

/// The error key for an HTTP status; `None` when the feedback was received. A 409 means
/// the same text already arrived (a retry after a lost answer), so it counts as sent.
fn status_error(status: u16) -> Option<&'static str> {
    match status {
        200..=299 | 409 => None,
        400 | 413 => Some(ERROR_INVALID),
        429 => Some(ERROR_RATE_LIMITED),
        _ => Some(ERROR_UNAVAILABLE),
    }
}

fn post(endpoint: &str, body: &Value) -> Result<(), &'static str> {
    let connector = native_tls::TlsConnector::new().map_err(|_| ERROR_NETWORK)?;
    let agent = ureq::AgentBuilder::new()
        .tls_connector(Arc::new(connector))
        .timeout(Duration::from_secs(15))
        .build();
    match agent
        .post(&format!("{endpoint}/v1/feedback"))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
    {
        Ok(response) => status_error(response.status()).map_or(Ok(()), Err),
        Err(ureq::Error::Status(status, _)) => status_error(status).map_or(Ok(()), Err),
        Err(ureq::Error::Transport(_)) => Err(ERROR_NETWORK),
    }
}

#[tauri::command]
pub async fn send_feedback(feedback: FeedbackRequest) -> Result<(), String> {
    let body = payload(&feedback).map_err(str::to_owned)?;
    let endpoint = telemetry::endpoint().ok_or(ERROR_UNAVAILABLE)?;
    tauri::async_runtime::spawn_blocking(move || post(&endpoint, &body))
        .await
        .map_err(|_| ERROR_NETWORK.to_owned())?
        .map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> FeedbackRequest {
        FeedbackRequest {
            category: "idea".into(),
            rating: Some(4),
            message: "  Zoom could be a little slower.  ".into(),
            email: Some(" someone@example.com ".into()),
            include_metadata: true,
            locale: Some("vi".into()),
            website: String::new(),
        }
    }

    #[test]
    fn the_body_has_the_form_fields_and_labels_only() {
        let body = payload(&request()).unwrap();
        let mut keys: Vec<_> = body.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["category", "email", "includeMetadata", "message", "metadata", "rating", "source", "website"]);
        assert_eq!(body["source"], "app");
        assert_eq!(body["message"], "Zoom could be a little slower.");
        assert_eq!(body["email"], "someone@example.com");
        assert_eq!(body["rating"], 4);
        assert_eq!(body["website"], "");
        let metadata = body["metadata"].as_object().unwrap();
        let mut keys: Vec<_> = metadata.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["locale", "os", "sessionId", "version"]);
        assert_eq!(metadata["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(metadata["sessionId"], telemetry::session_id());
    }

    #[test]
    fn technical_details_are_left_out_when_unchecked() {
        let body = payload(&FeedbackRequest { include_metadata: false, email: None, rating: None, ..request() }).unwrap();
        assert!(body.get("metadata").is_none());
        assert_eq!(body["includeMetadata"], false);
        assert_eq!(body["email"], Value::Null);
        assert_eq!(body["rating"], Value::Null);
    }

    #[test]
    fn locale_that_is_not_a_label_is_dropped() {
        let body = payload(&FeedbackRequest { locale: Some("/Users/someone".into()), ..request() }).unwrap();
        assert!(body["metadata"].get("locale").is_none());
    }

    #[test]
    fn the_honeypot_value_is_passed_on() {
        let body = payload(&FeedbackRequest { website: "http://spam.example".into(), ..request() }).unwrap();
        assert_eq!(body["website"], "http://spam.example");
    }

    #[test]
    fn invalid_forms_are_refused() {
        let invalid = [
            FeedbackRequest { category: "pricing".into(), ..request() },
            FeedbackRequest { rating: Some(0), ..request() },
            FeedbackRequest { rating: Some(6), ..request() },
            FeedbackRequest { message: "   ".into(), ..request() },
            FeedbackRequest { message: "x".repeat(MAX_MESSAGE + 1), ..request() },
            FeedbackRequest { email: Some("not an address".into()), ..request() },
            FeedbackRequest { email: Some("a@b".into()), ..request() },
            FeedbackRequest { email: Some(format!("{}@example.com", "a".repeat(MAX_EMAIL))), ..request() },
        ];
        for form in invalid {
            assert_eq!(payload(&form), Err(ERROR_INVALID), "{form:?}");
        }
        // The limit counts characters, not bytes, and blank addresses are no address.
        assert!(payload(&FeedbackRequest { message: "ữ".repeat(MAX_MESSAGE), ..request() }).is_ok());
        assert!(payload(&FeedbackRequest { email: Some("  ".into()), ..request() }).is_ok());
    }

    #[test]
    fn statuses_map_to_message_keys() {
        assert_eq!(status_error(201), None);
        assert_eq!(status_error(409), None);
        assert_eq!(status_error(400), Some(ERROR_INVALID));
        assert_eq!(status_error(413), Some(ERROR_INVALID));
        assert_eq!(status_error(429), Some(ERROR_RATE_LIMITED));
        assert_eq!(status_error(500), Some(ERROR_UNAVAILABLE));
    }
}
