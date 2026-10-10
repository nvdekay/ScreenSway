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
  "welcome.eyebrow": "Your recording studio",
  "welcome.title": "What will you show today?",
  "welcome.subtitle": "Press record and present as usual. ScreenSway follows every click with smooth, cinematic zooms.",
  "highlight.zoom": "Auto zoom on every click",
  "highlight.cursor": "Silky cursor, 60 fps",
  "highlight.private": "Stays on this Mac",
  "source.label": "What to record",
  "source.screens": "Screens",
  "source.windows": "Windows",
  "source.loading": "Looking for screens and windows…",
  "source.empty": "Nothing to record here yet.",
  "source.display": "Display {n}",
  "source.standard": "Standard",
  "source.standardHint": "This display isn't Retina, so zoomed-in moments look softer. For the sharpest result, record on a Retina display.",
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
  "record.hint": "3-second countdown first. ScreenSway hides itself and never appears in the video.",
  "record.saved": "Recording saved",
  "record.failed": "Recording failed",
  "permission.title": "Allow screen recording",
  "permission.body": "macOS needs your permission before ScreenSway can see your screen. Turn on ScreenSway in Privacy & Security › Screen & System Audio Recording, then choose Quit & Reopen when macOS asks.",
  "permission.open": "Open System Settings",
  "permission.retry": "Try again",
  "preview.title": "Auto-zoom preview",
  "preview.zooms": "{count} zooms from your clicks · {time}",
  "preview.zoomsOne": "1 zoom from your clicks · {time}",
  "preview.close": "Close preview",
  "player.play": "Play",
  "player.pause": "Pause",
  "player.replay": "Replay from start",
  "player.seek": "Seek",
  "player.autoZoom": "Auto zoom",
  "library.title": "Library",
  "library.count": "{count} recordings · stored on this Mac",
  "library.countOne": "1 recording · stored on this Mac",
  "library.open": "Open preview of {title}",
  "library.reveal": "Show in Finder",
  "library.emptyTitle": "Your first recording will live here",
  "library.emptyHint": "Everything stays on this Mac, in Movies › ScreenSway.",
  "library.playing": "Now previewing",
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
  "welcome.eyebrow": "Studio quay màn hình của bạn",
  "welcome.title": "Hôm nay bạn muốn trình bày gì?",
  "welcome.subtitle": "Bấm quay và thao tác như bình thường. ScreenSway tự zoom theo từng cú click một cách mượt mà như quay phim.",
  "highlight.zoom": "Tự zoom theo mỗi cú click",
  "highlight.cursor": "Con trỏ mượt 60 fps",
  "highlight.private": "Lưu ngay trên máy Mac",
  "source.label": "Chọn nội dung cần quay",
  "source.screens": "Màn hình",
  "source.windows": "Cửa sổ",
  "source.loading": "Đang tìm màn hình và cửa sổ…",
  "source.empty": "Chưa có nội dung nào để quay.",
  "source.display": "Màn hình {n}",
  "source.standard": "Thường",
  "source.standardHint": "Màn hình này không phải Retina nên khi tự zoom hình sẽ kém nét hơn. Để nét nhất, hãy quay trên màn hình Retina.",
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
  "record.hint": "Đếm ngược 3 giây trước khi quay. ScreenSway tự ẩn và không bao giờ xuất hiện trong video.",
  "record.saved": "Đã lưu bản quay",
  "record.failed": "Quay thất bại",
  "permission.title": "Cho phép ghi màn hình",
  "permission.body": "macOS cần bạn cấp quyền để ScreenSway thấy được màn hình. Bật ScreenSway trong Quyền riêng tư & Bảo mật › Ghi màn hình & âm thanh hệ thống, sau đó chọn “Thoát & Mở lại” khi macOS hỏi.",
  "permission.open": "Mở Cài đặt hệ thống",
  "permission.retry": "Thử lại",
  "preview.title": "Xem trước tự động zoom",
  "preview.zooms": "{count} lần zoom từ các cú click · {time}",
  "preview.zoomsOne": "1 lần zoom từ các cú click · {time}",
  "preview.close": "Đóng xem trước",
  "player.play": "Phát",
  "player.pause": "Tạm dừng",
  "player.replay": "Phát lại từ đầu",
  "player.seek": "Tua",
  "player.autoZoom": "Tự động zoom",
  "library.title": "Thư viện",
  "library.count": "{count} bản quay · lưu trên máy Mac này",
  "library.countOne": "1 bản quay · lưu trên máy Mac này",
  "library.open": "Mở xem trước {title}",
  "library.reveal": "Hiện trong Finder",
  "library.emptyTitle": "Bản quay đầu tiên của bạn sẽ nằm ở đây",
  "library.emptyHint": "Mọi thứ được lưu trên máy Mac này, trong Phim › ScreenSway.",
  "library.playing": "Đang xem",
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
