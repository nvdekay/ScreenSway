import { AlertCircle, Check, Loader2, Lock, MessageSquare, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { FEEDBACK_CATEGORIES, feedbackError, feedbackProblem, MAX_FEEDBACK_EMAIL, MAX_FEEDBACK_MESSAGE, type FeedbackCategory, type FeedbackRequest } from "../../desktop/src/feedback";
import { sendFeedback } from "./analytics";
import { useI18n, type MessageKey } from "./i18n";

const FEEDBACK_EVENT = "screensway:feedback";

/** Opens the feedback form from anywhere on the page. */
export function openFeedback() {
  window.dispatchEvent(new CustomEvent(FEEDBACK_EVENT));
}

/** The header's feedback button. */
export function FeedbackButton() {
  const { t } = useI18n();
  return (
    <button className="header-feedback" type="button" aria-label={t("feedback.open")} onClick={openFeedback}>
      <MessageSquare size={14} aria-hidden="true" /><span>{t("feedback.open")}</span>
    </button>
  );
}

type SendState = { status: "idle" } | { status: "sending" } | { status: "sent" } | { status: "failed"; error: MessageKey };

/**
 * The landing page's feedback form, the same fields and checks as the apps' form
 * (desktop/src/FeedbackDialog.tsx). What the visitor types stays in this component until it
 * is sent (a failed send keeps it for Retry); it is never stored.
 */
export function FeedbackDialog() {
  const { t, language } = useI18n();
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const [category, setCategory] = useState<FeedbackCategory>("idea");
  const [rating, setRating] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<SendState>({ status: "idle" });
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const sending = state.status === "sending";
  const sent = useRef(false);
  sent.current = state.status === "sent";

  useEffect(() => {
    const open = () => {
      // A sent form starts over; an unsent draft is kept for the next opening.
      if (sent.current) {
        setCategory("idea"); setRating(null); setMessage(""); setEmail(""); setIncludeMetadata(true); setWebsite("");
        setState({ status: "idle" });
      }
      setProblem(null);
      dialogRef.current?.showModal();
      requestAnimationFrame(() => messageRef.current?.focus());
    };
    window.addEventListener(FEEDBACK_EVENT, open);
    return () => window.removeEventListener(FEEDBACK_EVENT, open);
  }, []);

  const close = () => { if (!sending) dialogRef.current?.close(); };

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
      await sendFeedback(request);
      setState({ status: "sent" });
    } catch (error) {
      setState({ status: "failed", error: feedbackError(error) });
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="feedback-modal"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => { if (sending) event.preventDefault(); }}
      onClick={(event) => { if (event.target === dialogRef.current) close(); }}
    >
      <div className="guide-panel feedback-panel">
        <button className="guide-close" type="button" onClick={close} disabled={sending} aria-label={t("feedback.close")}>
          <X size={18} />
        </button>
        {state.status === "sent" ? (
          <div className="feedback-sent" role="status">
            <span className="feedback-sent-icon" aria-hidden="true"><Check size={18} strokeWidth={3} /></span>
            <h2 id={`${id}-title`}>{t("feedback.thanks")}</h2>
            <p>{t("feedback.thanksBody")}</p>
            <button className="feedback-primary" type="button" onClick={close}>{t("feedback.close")}</button>
          </div>
        ) : (
          <form noValidate onSubmit={(event) => { event.preventDefault(); if (!sending) void send(); }}>
            <h2 id={`${id}-title`}>{t("feedback.title")}</h2>
            <p className="guide-lead">{t("feedback.intro")}</p>

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
                {rating !== null && <button type="button" className="feedback-link" onClick={() => setRating(null)}>{t("feedback.ratingClear")}</button>}
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
                onChange={(event) => { setMessage(event.target.value); setProblem(null); }}
              />
              <small id={`${id}-count`} className="feedback-count">{t("feedback.count", { count: [...message].length, max: MAX_FEEDBACK_MESSAGE })}</small>
            </div>

            <label className="feedback-field">
              <span>{t("feedback.email")}</span>
              <input type="email" value={email} maxLength={MAX_FEEDBACK_EMAIL} autoComplete="email" disabled={sending} onChange={(event) => { setEmail(event.target.value); setProblem(null); }} />
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

            {(problem || state.status === "failed") && (
              <div className="feedback-error" role="alert">
                <AlertCircle size={18} aria-hidden="true" />
                <span>{t(problem ?? (state.status === "failed" ? state.error : "feedback.errorNetwork"))}</span>
              </div>
            )}

            <div className="feedback-actions">
              <button type="button" className="feedback-secondary" onClick={close} disabled={sending}>{t("feedback.cancel")}</button>
              <button type="submit" className="feedback-primary" disabled={sending}>
                {sending ? <><Loader2 size={15} className="spin" aria-hidden="true" /> {t("feedback.sending")}</> : t(state.status === "failed" ? "feedback.retry" : "feedback.send")}
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}
