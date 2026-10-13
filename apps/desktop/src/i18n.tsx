import { invoke } from "@tauri-apps/api/core";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isWindows } from "./platform";

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
  "telemetry.title": "Help improve ScreenSway?",
  "telemetry.body": "Share anonymous usage statistics: which features you use, the app version and your system type. Never your recordings, audio, captions or file names. You can change this in Settings at any time.",
  "telemetry.allow": "Share anonymous statistics",
  "telemetry.decline": "No thanks",
  "telemetry.setting": "Share usage statistics",
  "telemetry.settingHint": "Anonymous. Never your recordings.",
  "welcome.eyebrow": "Your recording studio",
  "welcome.title": "What will you show today?",
  "welcome.subtitle": "Press record and present as usual. ScreenSway follows every click with smooth, cinematic zooms.",
  "highlight.zoom": "Auto zoom on every click",
  "highlight.cursor": "Silky cursor, 60 fps",
  "highlight.private": "Stays on this Mac",
  "source.refresh": "Refresh recording sources",
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
  "player.mute": "Mute",
  "frame.background": "Background",
  "frame.tab.gradient": "Gradient",
  "frame.tab.color": "Color",
  "frame.tab.image": "Image",
  "frame.tab.magic": "Magic",
  "frame.customColor": "Custom color",
  "frame.chooseImage": "Choose an image",
  "frame.imageNote": "Images stay on this Mac, in Movies › ScreenSway › Backgrounds, so you can reuse them.",
  "frame.addImage": "Add an image",
  "frame.useImage": "Use this image",
  "frame.deleteImage": "Remove this image",
  "captions.title": "Captions",
  "captions.language": "Spoken language",
  "captions.generate": "Create captions",
  "captions.regenerate": "Create again",
  "captions.note": "Speech is recognized on this Mac; nothing is uploaded.",
  "captions.running": "Listening… {percent}%",
  "captions.denied": "macOS blocked speech recognition. Turn on ScreenSway in Privacy & Security › Speech Recognition, then try again.",
  "captions.show": "Show captions in the video",
  "captions.empty": "No speech was found in this recording.",
  "captions.size.s": "Small",
  "captions.size.m": "Medium",
  "captions.size.l": "Large",
  "captions.look.dark": "Dark box",
  "captions.look.light": "Light box",
  "captions.look.outline": "Outline",
  "captions.jump": "Go to this caption",
  "captions.edit": "Caption at {time}",
  "captions.srtNote": "Edit any line. Exports also save an .srt file next to the video.",
  "captions.srtSaved": "Captions saved as an .srt file next to the video",
  "timeline.kept": "Keeping {start}–{end} ({length})",
  "timeline.resetTrim": "Keep everything",
  "timeline.autoZooms": "Automatic zooms",
  "timeline.autoZoomsHint": "Discard your zoom edits and follow the clicks again",
  "timeline.addZoom": "Add zoom",
  "timeline.zoomLabel": "Zoom {index}, {scale}×. Drag to move, drag an edge to resize, Delete to remove.",
  "timeline.trimStart": "Start of the video",
  "timeline.trimEnd": "End of the video",
  "timeline.depth": "Zoom depth",
  "timeline.removeZoom": "Remove zoom",
  "timeline.zoomOff": "Zoom is off. Turn on Auto zoom to edit zooms.",
  "frame.styles": "Styles",
  "frame.saveStyle": "Save current style",
  "frame.styleSaved": "Current style is saved",
  "frame.styleName": "Style name",
  "frame.deleteStyle": "Delete style {name}",
  "style.studio": "Studio",
  "style.clean": "Clean",
  "style.product": "MacBook",
  "style.web": "Website",
  "style.social": "Social",
  "frame.waves": "Waves",
  "frame.customGradient": "Custom gradient",
  "frame.gradientFrom": "First color",
  "frame.gradientTo": "Second color",
  "frame.gradientAngle": "Angle",
  "frame.imageFailed": "That image could not be opened.",
  "frame.blur": "Blur",
  "frame.magic": "Match this recording",
  "frame.magicNote": "Builds a background from the colors in your recording.",
  "frame.grain": "Film grain",
  "frame.window": "Frame",
  "frame.style.none": "None",
  "frame.style.macosLight": "macOS light",
  "frame.style.macosDark": "macOS dark",
  "frame.style.browserLight": "Browser light",
  "frame.style.browserDark": "Browser dark",
  "frame.style.macbook": "MacBook",
  "frame.style.glass": "Glass",
  "frame.style.outline": "Outline",
  "frame.layout": "Layout",
  "frame.aspectAuto": "Auto",
  "frame.padding": "Padding",
  "frame.radius": "Corners",
  "frame.shadow": "Shadow",
  "frame.quality": "Export quality",
  "export.start": "Export video",
  "export.running": "Exporting… {percent}%",
  "export.cancel": "Cancel",
  "export.done": "Video exported",
  "export.open": "Play",
  "export.reveal": "Show in Finder",
  "export.failed": "Export failed",
  "player.unmute": "Unmute",
  "audio.label": "Record system audio",
  "audio.hint": "Music, videos and alerts playing on this Mac",
  "mic.label": "Record microphone",
  "mic.hint": "Your voice, leveled and denoised",
  "mic.device": "Microphone",
  "mic.systemDefault": "System default",
  "mic.systemDefaultNamed": "System default ({name})",
  "mic.headphones": "Tip: wear headphones so sound from the speakers does not echo into your voice.",
  "micPermission.title": "Allow the microphone",
  "micPermission.body": "macOS blocked ScreenSway from using the microphone. Turn on ScreenSway in Privacy & Security › Microphone, then record again.",
  "micPermission.windowsBody": "Windows blocked microphone access. In Settings › Privacy & security › Microphone, enable microphone access and let desktop apps access your microphone, then record again.",
  "micPermission.withoutMic": "Record without microphone",
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
  "telemetry.title": "Giúp ScreenSway tốt hơn?",
  "telemetry.body": "Chia sẻ số liệu sử dụng ẩn danh: bạn dùng tính năng nào, phiên bản app và loại hệ điều hành. Không bao giờ gồm bản ghi, âm thanh, phụ đề hay tên file. Bạn có thể đổi lựa chọn này trong Cài đặt bất cứ lúc nào.",
  "telemetry.allow": "Chia sẻ số liệu ẩn danh",
  "telemetry.decline": "Không, cảm ơn",
  "telemetry.setting": "Chia sẻ số liệu sử dụng",
  "telemetry.settingHint": "Ẩn danh. Không bao giờ gồm bản ghi.",
  "welcome.eyebrow": "Studio quay màn hình của bạn",
  "welcome.title": "Hôm nay bạn muốn trình bày gì?",
  "welcome.subtitle": "Bấm quay và thao tác như bình thường. ScreenSway tự zoom theo từng cú click một cách mượt mà như quay phim.",
  "highlight.zoom": "Tự zoom theo mỗi cú click",
  "highlight.cursor": "Con trỏ mượt 60 fps",
  "highlight.private": "Lưu ngay trên máy Mac",
  "source.refresh": "Làm mới nguồn quay",
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
  "player.mute": "Tắt tiếng",
  "frame.background": "Nền",
  "frame.tab.gradient": "Gradient",
  "frame.tab.color": "Màu",
  "frame.tab.image": "Ảnh",
  "frame.tab.magic": "Magic",
  "frame.customColor": "Chọn màu khác",
  "frame.chooseImage": "Chọn ảnh",
  "frame.imageNote": "Ảnh chỉ nằm trên máy Mac này, trong Phim › ScreenSway › Backgrounds, để bạn dùng lại.",
  "frame.addImage": "Thêm ảnh",
  "frame.useImage": "Dùng ảnh này",
  "frame.deleteImage": "Xoá ảnh này",
  "captions.title": "Phụ đề",
  "captions.language": "Ngôn ngữ nói",
  "captions.generate": "Tạo phụ đề",
  "captions.regenerate": "Tạo lại",
  "captions.note": "Giọng nói được nhận dạng ngay trên máy Mac, không tải lên đâu cả.",
  "captions.running": "Đang nghe… {percent}%",
  "captions.denied": "macOS đang chặn nhận dạng giọng nói. Bật ScreenSway trong Quyền riêng tư & Bảo mật › Nhận dạng giọng nói, rồi thử lại.",
  "captions.show": "Hiện phụ đề trong video",
  "captions.empty": "Không tìm thấy giọng nói trong bản quay này.",
  "captions.size.s": "Nhỏ",
  "captions.size.m": "Vừa",
  "captions.size.l": "Lớn",
  "captions.look.dark": "Nền tối",
  "captions.look.light": "Nền sáng",
  "captions.look.outline": "Viền chữ",
  "captions.jump": "Tới câu này",
  "captions.edit": "Phụ đề lúc {time}",
  "captions.srtNote": "Sửa trực tiếp từng dòng. Khi xuất video, file .srt cũng được lưu cạnh video.",
  "captions.srtSaved": "Đã lưu phụ đề thành file .srt cạnh video",
  "timeline.kept": "Giữ {start}–{end} ({length})",
  "timeline.resetTrim": "Giữ toàn bộ",
  "timeline.autoZooms": "Zoom tự động",
  "timeline.autoZoomsHint": "Bỏ các chỉnh sửa zoom và zoom theo cú click như ban đầu",
  "timeline.addZoom": "Thêm zoom",
  "timeline.zoomLabel": "Zoom {index}, {scale}×. Kéo để dời, kéo mép để đổi độ dài, Delete để xoá.",
  "timeline.trimStart": "Điểm bắt đầu video",
  "timeline.trimEnd": "Điểm kết thúc video",
  "timeline.depth": "Độ sâu zoom",
  "timeline.removeZoom": "Xoá zoom",
  "timeline.zoomOff": "Zoom đang tắt. Bật Tự động zoom để chỉnh zoom.",
  "frame.styles": "Phong cách",
  "frame.saveStyle": "Lưu phong cách hiện tại",
  "frame.styleSaved": "Phong cách này đã được lưu",
  "frame.styleName": "Tên phong cách",
  "frame.deleteStyle": "Xoá phong cách {name}",
  "style.studio": "Studio",
  "style.clean": "Tối giản",
  "style.product": "MacBook",
  "style.web": "Website",
  "style.social": "Mạng xã hội",
  "frame.waves": "Sóng",
  "frame.customGradient": "Gradient tuỳ chỉnh",
  "frame.gradientFrom": "Màu thứ nhất",
  "frame.gradientTo": "Màu thứ hai",
  "frame.gradientAngle": "Góc",
  "frame.imageFailed": "Không mở được ảnh này.",
  "frame.blur": "Làm mờ",
  "frame.magic": "Lấy màu từ bản quay",
  "frame.magicNote": "Tạo nền từ chính màu sắc trong bản quay của bạn.",
  "frame.grain": "Nhiễu hạt",
  "frame.window": "Khung",
  "frame.style.none": "Không",
  "frame.style.macosLight": "macOS sáng",
  "frame.style.macosDark": "macOS tối",
  "frame.style.browserLight": "Trình duyệt sáng",
  "frame.style.browserDark": "Trình duyệt tối",
  "frame.style.macbook": "MacBook",
  "frame.style.glass": "Kính",
  "frame.style.outline": "Viền",
  "frame.layout": "Bố cục",
  "frame.aspectAuto": "Tự động",
  "frame.padding": "Khoảng đệm",
  "frame.radius": "Bo góc",
  "frame.shadow": "Bóng đổ",
  "frame.quality": "Chất lượng xuất",
  "export.start": "Xuất video",
  "export.running": "Đang xuất… {percent}%",
  "export.cancel": "Huỷ",
  "export.done": "Đã xuất video",
  "export.open": "Phát",
  "export.reveal": "Hiện trong Finder",
  "export.failed": "Xuất thất bại",
  "player.unmute": "Bật tiếng",
  "audio.label": "Ghi âm thanh hệ thống",
  "audio.hint": "Nhạc, video và thông báo đang phát trên máy",
  "mic.label": "Ghi micro",
  "mic.hint": "Giọng nói, tự cân âm lượng và giảm ồn",
  "mic.device": "Micro",
  "mic.systemDefault": "Mặc định của hệ thống",
  "mic.systemDefaultNamed": "Mặc định của hệ thống ({name})",
  "mic.headphones": "Mẹo: đeo tai nghe để âm thanh từ loa không lọt vào giọng nói.",
  "micPermission.title": "Cho phép dùng micro",
  "micPermission.body": "macOS đang chặn ScreenSway dùng micro. Bật ScreenSway trong Quyền riêng tư & Bảo mật › Micrô, rồi quay lại.",
  "micPermission.windowsBody": "Windows đang chặn truy cập micro. Trong Cài đặt › Quyền riêng tư và bảo mật › Micrô, bật quyền truy cập micrô và cho phép ứng dụng máy tính truy cập micrô, rồi quay lại.",
  "micPermission.withoutMic": "Quay không dùng micro",
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

/** Wording that names macOS places (Finder, Movies, "this Mac") reads differently on Windows. */
const enWindows: Partial<Record<MessageKey, string>> = {
  "highlight.private": "Stays on this PC",
  "frame.imageNote": "Images stay on this PC, in Videos › ScreenSway › Backgrounds, so you can reuse them.",
  "captions.note": "Speech is recognized on this PC; nothing is uploaded.",
  "export.reveal": "Show in File Explorer",
  "audio.hint": "Music, videos and alerts playing on this PC",
  "library.count": "{count} recordings · stored on this PC",
  "library.countOne": "1 recording · stored on this PC",
  "library.reveal": "Show in File Explorer",
  "library.emptyHint": "Everything stays on this PC, in Videos › ScreenSway.",
};

const viWindows: Partial<Record<MessageKey, string>> = {
  "highlight.private": "Lưu ngay trên máy tính",
  "frame.imageNote": "Ảnh chỉ nằm trên máy tính này, trong Video › ScreenSway › Backgrounds, để bạn dùng lại.",
  "captions.note": "Giọng nói được nhận dạng ngay trên máy tính, không tải lên đâu cả.",
  "export.reveal": "Hiện trong File Explorer",
  "library.count": "{count} bản quay · lưu trên máy tính này",
  "library.countOne": "1 bản quay · lưu trên máy tính này",
  "library.reveal": "Hiện trong File Explorer",
  "library.emptyHint": "Mọi thứ được lưu trên máy tính này, trong Video › ScreenSway.",
};

const MESSAGES: Record<Language, Record<MessageKey, string>> = isWindows
  ? { en: { ...en, ...enWindows }, vi: { ...vi, ...viWindows } }
  : { en, vi };
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
