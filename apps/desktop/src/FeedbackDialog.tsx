import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, Check, FileText, Loader2, Lock, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FEEDBACK_CATEGORIES, feedbackError, feedbackProblem, MAX_FEEDBACK_EMAIL, MAX_FEEDBACK_MESSAGE, type FeedbackCategory, type FeedbackRequest } from "./feedback";
import { useI18n, type MessageKey } from "./i18n";
import { isWeb } from "./platform";
import { track } from "./telemetry";

type SendState = { status: "idle" } | { status: "sending" } | { status: "sent" } | { status: "failed"; error: MessageKey };

/**
 * The feedback form. What the user types stays in this component until it is sent (a failed
 * send keeps it for Retry); it is never saved. Only the category is counted in the statistics.
 */
export function FeedbackDialog({ initialCategory = "idea", initialMessage = "", onClose }: {
  initialCategory?: FeedbackCategory;
  initialMessage?: string;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const [category, setCategory] = useState<FeedbackCategory>(initialCategory);
  const [rating, setRating] = useState<number | null>(null);
  const [message, setMessage] = useState(initialMessage);
  const [email, setEmail] = useState("");
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<SendState>({ status: "idle" });
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const sending = state.status === "sending";

  useEffect(() => messageRef.current?.focus(), []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sending) onClose();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose, sending]);

  async function send() {
    const request: FeedbackRequest = {
      category,
      rating,
      message: message.trim(),
      email: email.trim() || null,
      includeMetadata,
      locale: language,
      website,
    };
    const invalid = feedbackProblem(request);
    setProblem(invalid);
    if (invalid) return;
    setState({ status: "sending" });
    try {
      await invoke("send_feedback", { feedback: request });
      setState({ status: "sent" });
      track("feedback_submitted", { category });
    } catch (error) {
      setState({ status: "failed", error: feedbackError(error) });
    }
  }

  // On the body: a blurred title bar would otherwise hold the fixed backdrop inside itself.
  return createPortal(
    <div className="feedback-backdrop" role="presentation">
      <section className="feedback-dialog glass" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <button className="icon-button feedback-close" onClick={onClose} disabled={sending} aria-label={t("feedback.close")}>
          <X size={18} />
        </button>
        {state.status === "sent" ? (
          <div className="feedback-sent" role="status">
            <span className="export-done-icon" aria-hidden="true"><Check size={15} strokeWidth={3} /></span>
            <h2 id={`${id}-title`}>{t("feedback.thanks")}</h2>
            <p>{t("feedback.thanksBody")}</p>
            <button className="record-button feedback-primary" onClick={onClose}>{t("feedback.close")}</button>
          </div>
        ) : (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!sending) void send();
            }}
          >
            <h2 id={`${id}-title`}>{t("feedback.title")}</h2>
            <p className="feedback-intro">{t("feedback.intro")}</p>

            <label className="feedback-field">
              <span>{t("feedback.category")}</span>
              <select value={category} disabled={sending} onChange={(event) => setCategory(event.target.value as FeedbackCategory)}>
                {FEEDBACK_CATEGORIES.map((item) => <option key={item} value={item}>{t(`feedback.category.${item}`)}</option>)}
              </select>
            </label>

            <fieldset className="feedback-field feedback-rating" disabled={sending}>
              <legend>{t("feedback.rating")}</legend>
              <div>
                {[1, 2, 3, 4, 5].map((value) => (
                  <label key={value} className={rating === value ? "selected" : undefined}>
                    <input type="radio" name={`${id}-rating`} value={value} checked={rating === value} onChange={() => setRating(value)} aria-label={t("feedback.ratingValue", { value })} />
                    <span aria-hidden="true">{value}</span>
                  </label>
                ))}
                {rating !== null && (
                  <button type="button" className="update-link" onClick={() => setRating(null)}>{t("feedback.ratingClear")}</button>
                )}
              </div>
            </fieldset>

            <div className="feedback-field">
              <label htmlFor={`${id}-message`}>{t("feedback.message")}</label>
              <textarea
                id={`${id}-message`}
                ref={messageRef}
                value={message}
                maxLength={MAX_FEEDBACK_MESSAGE}
                rows={5}
                required
                disabled={sending}
                placeholder={t("feedback.messagePlaceholder")}
                aria-describedby={`${id}-count`}
                onChange={(event) => setMessage(event.target.value)}
              />
              <small id={`${id}-count`} className="feedback-count">{t("feedback.count", { count: [...message].length, max: MAX_FEEDBACK_MESSAGE })}</small>
            </div>

            <label className="feedback-field">
              <span>{t("feedback.email")}</span>
              <input type="email" value={email} maxLength={MAX_FEEDBACK_EMAIL} autoComplete="email" disabled={sending} onChange={(event) => setEmail(event.target.value)} />
            </label>

            {/* Hidden from people and assistive technology; automated senders fill it in. */}
            <div className="feedback-honeypot" aria-hidden="true">
              <label>
                {t("feedback.honeypot")}
                <input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} />
              </label>
            </div>

            <label className="feedback-check">
              <input type="checkbox" checked={includeMetadata} disabled={sending} onChange={(event) => setIncludeMetadata(event.target.checked)} />
              <span>
                <strong>{t("feedback.metadata")}</strong>
                <small>{t("feedback.metadataHint")}</small>
              </span>
            </label>

            <p className="feedback-privacy"><Lock size={13} aria-hidden="true" />{t("feedback.privacy")}</p>

            {/* The app's local log of how recordings and exports ended; never sent with the form. */}
            {!isWeb && category === "bug" && (
              <p className="feedback-log">
                <FileText size={13} aria-hidden="true" />
                <span>
                  {t("feedback.logHint")}{" "}
                  <button type="button" className="update-link" onClick={() => void invoke("open_log_folder").catch(() => undefined)}>{t("feedback.openLog")}</button>
                </span>
              </p>
            )}

            {(problem || state.status === "failed") && (
              <div className="capture-message error" role="alert">
                <AlertCircle size={18} aria-hidden="true" />
                <span>{t(problem ?? (state.status === "failed" ? state.error : "feedback.errorNetwork"))}</span>
              </div>
            )}

            <div className="feedback-actions">
              <button type="button" className="secondary-button compact" onClick={onClose} disabled={sending}>{t("feedback.cancel")}</button>
              <button type="submit" className="record-button feedback-primary" disabled={sending}>
                {sending ? <><Loader2 size={15} className="spin" aria-hidden="true" /> {t("feedback.sending")}</> : t(state.status === "failed" ? "feedback.retry" : "feedback.send")}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>,
    document.body,
  );
}
