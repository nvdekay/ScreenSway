import { invoke } from "@tauri-apps/api/core";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Language = "en" | "vi";

export const LANGUAGES: { code: Language; label: string }[] = [
  { code: "en", label: "English" },
  { code: "vi", label: "Tiếng Việt" },
];

const en = {
  "app.home": "ScreenSway home",
  "settings.open": "Open settings",
  "settings.title": "Settings",
  "settings.language": "Language",
  "welcome.eyebrow": "Local workspace",
  "welcome.title": "What will you show today?",
  "welcome.subtitle": "Record your screen. ScreenSway handles the camera work.",
  "source.label": "Capture source",
  "source.loading": "Loading sources…",
  "source.display": "Display {n}",
  "source.window": "Window",
  "status.idle": "Ready to record",
  "status.countdown": "Starting in {n}…",
  "status.recording": "Recording · {time}",
  "status.paused": "Paused · {time}",
  "status.finishing": "Saving recording…",
  "action.pause": "Pause",
  "action.resume": "Resume",
  "action.start": "Start recording",
  "action.stop": "Stop recording",
  "action.saving": "Saving…",
  "record.hint": "A 3-second countdown runs first. ScreenSway hides itself and stays out of the video.",
  "record.saved": "Recording saved",
  "record.failed": "Recording failed",
  "preview.title": "Auto-zoom preview",
  "preview.zooms": "{count} zooms generated from clicks · {time}",
  "preview.zoomsOne": "1 zoom generated from clicks · {time}",
  "player.play": "Play",
  "player.pause": "Pause",
  "player.replay": "Replay from start",
  "player.seek": "Seek",
  "player.autoZoom": "Auto zoom",
  "recent.title": "Recent recordings",
  "recent.stored": "Stored on this Mac",
  "recent.sampleWalkthrough": "Product walkthrough",
  "recent.sampleWelcome": "Welcome to ScreenSway",
  "recent.draft": "Draft · {time}",
  "recent.options": "Options for {title}",
  "recent.emptyTitle": "Your next idea",
  "recent.emptyHint": "Press record when you are ready",
  "hud.startsIn": "Recording starts…",
  "hud.cancel": "Cancel",
  "hud.saving": "Saving…",
  "hud.savingShort": "Saving",
  "hud.stop": "Stop",
  "hud.pause": "Pause recording",
  "hud.resume": "Resume recording",
  "tray.stop": "Stop Recording",
  "tray.pause": "Pause",
  "tray.resume": "Resume",
  "tray.show": "Show ScreenSway",
  "tray.tooltip": "ScreenSway is recording",
};

export type MessageKey = keyof typeof en;

const vi: Record<MessageKey, string> = {
  "app.home": "Trang chủ ScreenSway",
  "settings.open": "Mở cài đặt",
  "settings.title": "Cài đặt",
  "settings.language": "Ngôn ngữ",
  "welcome.eyebrow": "Không gian làm việc cục bộ",
  "welcome.title": "Hôm nay bạn muốn trình bày gì?",
  "welcome.subtitle": "Quay màn hình của bạn. ScreenSway lo phần máy quay.",
  "source.label": "Nguồn quay",
  "source.loading": "Đang tải nguồn quay…",
  "source.display": "Màn hình {n}",
  "source.window": "Cửa sổ",
  "status.idle": "Sẵn sàng quay",
  "status.countdown": "Bắt đầu sau {n}…",
  "status.recording": "Đang quay · {time}",
  "status.paused": "Tạm dừng · {time}",
  "status.finishing": "Đang lưu bản quay…",
  "action.pause": "Tạm dừng",
  "action.resume": "Tiếp tục",
  "action.start": "Bắt đầu quay",
  "action.stop": "Dừng quay",
  "action.saving": "Đang lưu…",
  "record.hint": "Sẽ đếm ngược 3 giây trước khi quay. ScreenSway tự ẩn đi và không xuất hiện trong video.",
  "record.saved": "Đã lưu bản quay",
  "record.failed": "Quay thất bại",
  "preview.title": "Xem trước tự động zoom",
  "preview.zooms": "{count} lần zoom tạo từ các cú click · {time}",
  "preview.zoomsOne": "1 lần zoom tạo từ các cú click · {time}",
  "player.play": "Phát",
  "player.pause": "Tạm dừng",
  "player.replay": "Phát lại từ đầu",
  "player.seek": "Tua",
  "player.autoZoom": "Tự động zoom",
  "recent.title": "Bản quay gần đây",
  "recent.stored": "Lưu trên máy Mac này",
  "recent.sampleWalkthrough": "Hướng dẫn sản phẩm",
  "recent.sampleWelcome": "Chào mừng đến với ScreenSway",
  "recent.draft": "Bản nháp · {time}",
  "recent.options": "Tùy chọn cho {title}",
  "recent.emptyTitle": "Ý tưởng tiếp theo của bạn",
  "recent.emptyHint": "Nhấn quay khi bạn đã sẵn sàng",
  "hud.startsIn": "Sắp bắt đầu quay…",
  "hud.cancel": "Hủy",
  "hud.saving": "Đang lưu…",
  "hud.savingShort": "Đang lưu",
  "hud.stop": "Dừng",
  "hud.pause": "Tạm dừng quay",
  "hud.resume": "Tiếp tục quay",
  "tray.stop": "Dừng quay",
  "tray.pause": "Tạm dừng",
  "tray.resume": "Tiếp tục",
  "tray.show": "Mở ScreenSway",
  "tray.tooltip": "ScreenSway đang quay",
};

const MESSAGES: Record<Language, Record<MessageKey, string>> = { en, vi };
const STORAGE_KEY = "screensway.language";

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: Translate;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "vi";
}

function initialLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch {
    // Storage can be unavailable; fall back to the system language.
  }
  return navigator.language.toLowerCase().startsWith("vi") ? "vi" : "en";
}

/** Menu bar items are native, so the shell needs to know the language too. */
function syncNativeLanguage(language: Language) {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const labels = Object.fromEntries(
    (Object.keys(en) as MessageKey[])
      .filter((key) => key.startsWith("tray."))
      .map((key) => [key.slice("tray.".length), MESSAGES[language][key]]),
  );
  void invoke("set_native_labels", { labels }).catch(() => {});
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);

  useEffect(() => {
    document.documentElement.lang = language;
    syncNativeLanguage(language);
  }, [language]);

  // The floating recording controls are a separate window; keep it in sync.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && isLanguage(event.newValue)) setLanguageState(event.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still applies for this session.
    }
  }, []);

  const value = useMemo<I18nContextValue>(() => {
    const messages = MESSAGES[language];
    const t: Translate = (key, params) =>
      messages[key].replace(/\{(\w+)\}/g, (match, name: string) =>
        params && name in params ? String(params[name]) : match,
      );
    return { language, setLanguage, t };
  }, [language, setLanguage]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
