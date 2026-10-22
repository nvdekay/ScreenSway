/**
 * Feedback the user writes and sends (FeedbackDialog), and the feature survey after an
 * export (FeatureSurvey). The desktop shell (feedback.rs) and the browser version
 * (apps/studio-web/src/backend.ts) both answer `send_feedback` with the same checks.
 * Free text only ever goes to the feedback endpoint, never into usage events.
 */
export const FEEDBACK_CATEGORIES = ["idea", "bug", "feature", "experience", "other"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const MAX_FEEDBACK_MESSAGE = 4_000;
export const MAX_FEEDBACK_EMAIL = 254;

/** What the form passes to `send_feedback` (as `{ feedback }`). */
export interface FeedbackRequest {
  category: FeedbackCategory;
  rating: number | null;
  message: string;
  email: string | null;
  includeMetadata: boolean;
  locale: string | null;
  /** The hidden field only automated senders fill in. */
  website: string;
}

/** Message keys `send_feedback` rejects with. */
export const FEEDBACK_ERRORS = ["feedback.errorNetwork", "feedback.errorRateLimited", "feedback.errorInvalid", "feedback.errorUnavailable"] as const;
export type FeedbackError = (typeof FEEDBACK_ERRORS)[number];

export function feedbackError(error: unknown): FeedbackError {
  const message = String(error).replace(/^Error: /, "");
  return (FEEDBACK_ERRORS as readonly string[]).includes(message) ? (message as FeedbackError) : "feedback.errorNetwork";
}

/** Roughly an address: one @, a dot in the domain, no spaces. */
export function isEmail(text: string): boolean {
  return text.length <= MAX_FEEDBACK_EMAIL && /^[^\s@]+@[^\s@.][^\s@]*\.[^\s@]*[^\s@.]$/.test(text);
}

/** What is wrong with the form, as a message key, or null when it can be sent. */
export function feedbackProblem(request: Pick<FeedbackRequest, "category" | "rating" | "message" | "email">): "feedback.needMessage" | "feedback.tooLong" | "feedback.badEmail" | "feedback.errorInvalid" | null {
  if (!(FEEDBACK_CATEGORIES as readonly string[]).includes(request.category)) return "feedback.errorInvalid";
  if (request.rating !== null && !(Number.isInteger(request.rating) && request.rating >= 1 && request.rating <= 5)) return "feedback.errorInvalid";
  const message = request.message.trim();
  if (!message) return "feedback.needMessage";
  if ([...message].length > MAX_FEEDBACK_MESSAGE) return "feedback.tooLong";
  const email = request.email?.trim();
  if (email && !isEmail(email)) return "feedback.badEmail";
  return null;
}

/** Features the survey after an export asks about; only these names are ever sent. */
export const SURVEY_FEATURES = [
  "captions",
  "webcam",
  "export_4k60",
  "brand_kit",
  "vertical_social",
  "gif",
  "share_link",
  "collaboration",
  "import_video",
  "automation",
  "other",
] as const;
export type SurveyFeature = (typeof SURVEY_FEATURES)[number];

const SURVEY_KEY = "screensway.survey.shownAt";
export const SURVEY_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1_000;

/** Whether the survey may appear again (at most once every 14 days, on this computer only). */
export function surveyDue(now = Date.now()): boolean {
  try {
    const shownAt = Number(localStorage.getItem(SURVEY_KEY));
    return !Number.isFinite(shownAt) || shownAt <= 0 || shownAt > now || now - shownAt >= SURVEY_COOLDOWN_MS;
  } catch {
    // Without storage it could appear after every export; leave it out instead.
    return false;
  }
}

export function markSurveyShown(now = Date.now()) {
  try {
    localStorage.setItem(SURVEY_KEY, String(now));
  } catch {
    // Not remembered; surveyDue already hides it without storage.
  }
}
