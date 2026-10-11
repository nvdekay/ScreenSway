import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Language = "en" | "vi";

const en = {
  "nav.demo": "Demo",
  "nav.features": "Features",
  "nav.privacy": "Privacy",
  "nav.faq": "FAQ",
  "nav.download": "Download free",
  "nav.language": "Language",
  "nav.lightMode": "Switch to light mode",
  "nav.darkMode": "Switch to dark mode",
  "nav.home": "ScreenSway home",
  "nav.skip": "Skip to content",

  "hero.releaseTag": "New",
  "hero.release": "ScreenSway {version} for macOS is out",
  "hero.perks": "Free, no watermark, no account",
  "hero.titleA": "Record your screen.",
  "hero.titleB": "Make it worth watching.",
  "hero.copy": "Show your product. Explain an idea. Teach something new. ScreenSway follows your clicks, records your voice, and brings it all together with beautiful frames and captions — free, right on your Mac.",
  "hero.mac": "Download for macOS",
  "hero.macNote": "macOS 15 or later · Apple silicon & Intel",
  "hero.windows": "Windows",
  "hero.soon": "Coming soon",

  "demo.label": "Interactive demo of ScreenSway's automatic zoom",
  "demo.with": "With ScreenSway",
  "demo.without": "Raw recording",
  "demo.play": "Play demo",
  "demo.pause": "Pause demo",
  "demo.zoom": "Auto zoom {scale}×",
  "demo.following": "Following the cursor",
  "demo.caption0": "Just record like you normally would.",
  "demo.caption1": "Click → the camera glides in.",
  "demo.caption2": "Keep clicking nearby → it stays with you.",
  "demo.caption3": "Done → it eases back out.",
  "demo.sub0": "Let's take a look at this week's activity.",
  "demo.sub1": "Open Reports to see the details.",
  "demo.sub2": "Create a new report with a single click.",
  "demo.sub3": "Thursday had the highest activity.",
  "demo.sub4": "Compare the next day, without losing context.",
  "demo.sub5": "That's the overview. Ready to share.",
  "mock.title": "Acme Analytics",
  "mock.overview": "Overview",
  "mock.reports": "Reports",
  "mock.team": "Team",
  "mock.settings": "Settings",
  "mock.newReport": "New report",
  "mock.revenue": "Revenue",
  "mock.users": "Active users",
  "mock.growth": "Growth",
  "mock.weekly": "Weekly activity",
  "mock.created": "Report created",
  "mock.peak": "Peak: Thursday",

  "metrics.cursor": "Cursor tracking",
  "metrics.cursorValue": "60 fps",
  "metrics.retina": "MP4 export · 60 fps",
  "metrics.retinaValue": "Up to 4K",
  "metrics.upload": "Uploaded to the cloud",
  "metrics.uploadValue": "0 bytes",
  "metrics.price": "Watermark or limits",
  "metrics.priceValue": "None",

  "how.kicker": "How it works",
  "how.title": "From raw recording to ready-to-share in three steps.",
  "how.step1": "Press record",
  "how.step1Copy": "Pick a screen or window. A 3-second countdown, then ScreenSway gets out of the way.",
  "how.step2": "Make it your own",
  "how.step2Copy": "Auto zoom follows the action. Trim, adjust zooms, pick a style and add on-device captions in Studio.",
  "how.step3": "Export. Share. Repeat.",
  "how.step3Copy": "Save a finished MP4 at up to 4K and 60 fps, complete with audio, captions and your favorite frame.",

  "features.kicker": "Start with a better recording",
  "features.title": "You present. The camera follows.",
  "features.zoomTitle": "Cinematic auto zoom",
  "features.zoomCopy": "Spring-based camera motion zooms into each click and pans with your cursor — no keyframes, no jitter.",
  "features.cursorTitle": "Silky cursor & click ripples",
  "features.cursorCopy": "The cursor is re-rendered smoothly at your display's refresh rate, with a subtle ripple on every click.",
  "features.hudTitle": "Invisible controls",
  "features.hudCopy": "A floating Liquid Glass bar and menu bar timer keep you in control — and never appear in the video.",
  "features.pauseTitle": "Pause without the awkward gap",
  "features.pauseCopy": "Pause and resume as often as you like. Paused time is cut from the final video automatically.",
  "features.libraryTitle": "Your library, on your Mac",
  "features.libraryCopy": "Every recording is a plain folder in Movies › ScreenSway. Open, preview, or reveal it in Finder.",
  "features.nativeTitle": "Feels native",
  "features.nativeCopy": "Native Retina capture, floating Liquid Glass controls, and a Vietnamese or English interface. Built for macOS 15 and later, on Apple silicon and Intel.",

  "compare.kicker": "The difference",
  "compare.title": "Same recording. A very different story.",
  "compare.raw": "Raw screen recording",
  "compare.sway": "ScreenSway",
  "compare.row1": "Viewers can read small UI",
  "compare.row2": "Camera follows the action",
  "compare.row3": "Smooth cursor and click feedback",
  "compare.row4": "Paused time removed",
  "compare.row5": "Recording stays on your device",
  "compare.yes": "Yes",
  "compare.no": "No",
  "compare.depends": "Depends on the app",

  "privacy.kicker": "Local by design",
  "privacy.title": "Your screen. Your voice. Your Mac.",
  "privacy.copy": "Recording, editing, speech recognition and export happen on your Mac. No account, no cloud processing, and no network requests while you create. Your videos and voice recordings stay with you.",
  "privacy.item1": "No account or sign-in",
  "privacy.item2": "No cloud processing",
  "privacy.item3": "Your files, in a folder you own",
  "privacy.core": "On-device",
  "privacy.video": "Screen video",
  "privacy.cursor": "Cursor data",
  "privacy.project": "Project files",

  "faq.kicker": "FAQ",
  "faq.title": "Common questions",
  "faq.more": "Not answered here? We reply fast —",
  "faq.email": "email us",
  "faq.chatQuestion": "Is ScreenSway really free?",
  "faq.chatAnswer": "Yes — every feature, no watermark, no account.",
  "faq.q1": "Is ScreenSway really free?",
  "faq.a1": "Yes. Every feature is free, with no watermark, no time limit and no account.",
  "faq.q2": "Which systems are supported?",
  "faq.a2": "macOS 15 or later on Apple silicon and Intel Macs. A Windows version is in development.",
  "faq.q3": "Can I turn the automatic zoom off?",
  "faq.a3": "Yes. Turn auto zoom off, or move, resize, add and remove zooms on the timeline. Adjust each zoom's depth and trim the beginning or end. Your original recording stays unchanged.",
  "faq.q7": "Can I customize the frame and export in 4K?",
  "faq.a7": "Yes. Choose a built-in style or customize backgrounds, frames, padding, corners and shadow. Export an MP4 at 1080p, 1440p or 4K and 60 fps, with your audio, cursor, zooms and captions. Export quality also depends on the source recording.",
  "faq.q8": "Do captions need a cloud service?",
  "faq.a8": "No. Vietnamese and English speech recognition runs on your Mac using Apple's on-device recognition. Available language models and Speech Recognition permission are required. You can edit the captions, burn them into the MP4, and keep the separate SRT file.",
  "faq.q4": "Where are my recordings stored?",
  "faq.a4": "In Movies › ScreenSway on your Mac. Each recording is a folder with the video and cursor data.",
  "faq.q5": "Does ScreenSway record audio?",
  "faq.a5": "Yes. Record system audio, your microphone, or both; your voice is leveled and background noise is lowered. ScreenSway can also create captions in Vietnamese or English, right on your Mac.",
  "faq.q6": "macOS says it can't verify ScreenSway. How do I open it?",
  "faq.a6": "This early build isn't notarized by Apple yet. Drag ScreenSway to Applications and open it once. When macOS says it was not opened, click “Done” (not “Move to Trash”), then go to System Settings › Privacy & Security, scroll down and click “Open Anyway”. You only need to do this once.",
  "guide.kicker": "Almost there",
  "guide.title": "Install ScreenSway in about a minute",
  "guide.downloading": "Your download has started (ScreenSway-macos-universal.dmg, 4 MB).",
  "guide.retry": "Download again",
  "guide.close": "Close install guide",
  "guide.step1Title": "Drag it into Applications",
  "guide.step1": "Open the downloaded DMG and drag ScreenSway onto the Applications folder.",
  "guide.applications": "Applications",
  "guide.step2Title": "Open it, then click “Done”",
  "guide.step2": "This early build isn't notarized by Apple yet, so macOS stops the first launch. Click “Done” — not “Move to Trash”.",
  "guide.alertTitle": "“ScreenSway.app” Not Opened",
  "guide.trash": "Move to Trash",
  "guide.done": "Done",
  "guide.step3Title": "Allow it in Privacy & Security",
  "guide.step3": "Open System Settings › Privacy & Security, scroll to the bottom, click “Open Anyway” and confirm once more.",
  "guide.settingsPath": "System Settings › Privacy & Security",
  "guide.blocked": "“ScreenSway.app” was blocked to protect your Mac.",
  "guide.openAnyway": "Open Anyway",
  "guide.step4Title": "Allow screen recording",
  "guide.step4": "When ScreenSway asks, turn on Screen & System Audio Recording and choose “Quit & Reopen”. That's it — you won't see these steps again.",
  "guide.terminalSummary": "Comfortable with Terminal? Skip steps 2–3",
  "guide.terminal": "After step 1, run this command once, then open ScreenSway normally:",
  "guide.copy": "Copy",
  "guide.copied": "Copied",
  "guide.why": "Why the extra step? ScreenSway is free and works offline; this build hasn't been through Apple's paid notarization yet.",
  "guide.gotIt": "Got it",
  "hero.howToInstall": "How to install",

  "cta.title": "Make every click worth watching.",
  "cta.copy": "Download ScreenSway and turn your next screen recording into something people actually enjoy watching.",

  "footer.tagline": "Beautiful screen recordings, automatically.",
  "footer.contact": "Contact",
};

export type MessageKey = keyof typeof en;

const vi: Record<MessageKey, string> = {
  "nav.demo": "Demo",
  "nav.features": "Tính năng",
  "nav.privacy": "Quyền riêng tư",
  "nav.faq": "Hỏi đáp",
  "nav.download": "Tải miễn phí",
  "nav.language": "Ngôn ngữ",
  "nav.lightMode": "Chuyển sang giao diện sáng",
  "nav.darkMode": "Chuyển sang giao diện tối",
  "nav.home": "Trang chủ ScreenSway",
  "nav.skip": "Bỏ qua tới nội dung",

  "hero.releaseTag": "Mới",
  "hero.release": "ScreenSway {version} cho macOS đã ra mắt",
  "hero.perks": "Miễn phí, không watermark, không cần tài khoản",
  "hero.titleA": "Bấm quay màn hình.",
  "hero.titleB": "Có ngay video chỉn chu.",
  "hero.copy": "Giới thiệu sản phẩm, chia sẻ ý tưởng hay hướng dẫn một thao tác. ScreenSway tự zoom theo từng cú click, thu giọng nói và giúp bạn thêm khung hình, phụ đề thật đẹp. Miễn phí, ngay trên máy Mac.",
  "hero.mac": "Tải cho macOS",
  "hero.macNote": "macOS 15 trở lên · Apple silicon & Intel",
  "hero.windows": "Windows",
  "hero.soon": "Sắp ra mắt",

  "demo.label": "Demo tương tác tính năng tự động zoom của ScreenSway",
  "demo.with": "Có ScreenSway",
  "demo.without": "Bản quay thường",
  "demo.play": "Phát demo",
  "demo.pause": "Tạm dừng demo",
  "demo.zoom": "Tự zoom {scale}×",
  "demo.following": "Đang bám theo con trỏ",
  "demo.caption0": "Cứ quay như bình thường.",
  "demo.caption1": "Click → máy quay lướt vào gần.",
  "demo.caption2": "Click tiếp gần đó → máy quay vẫn bám theo bạn.",
  "demo.caption3": "Xong → máy quay nhẹ nhàng lùi ra.",
  "demo.sub0": "Cùng xem hoạt động trong tuần này nhé.",
  "demo.sub1": "Mở Báo cáo để xem chi tiết.",
  "demo.sub2": "Tạo báo cáo mới chỉ bằng một cú click.",
  "demo.sub3": "Thứ Năm có mức hoạt động cao nhất.",
  "demo.sub4": "So sánh với ngày tiếp theo ngay tại đây.",
  "demo.sub5": "Vậy là xong. Sẵn sàng chia sẻ thôi.",
  "mock.title": "Acme Analytics",
  "mock.overview": "Tổng quan",
  "mock.reports": "Báo cáo",
  "mock.team": "Nhóm",
  "mock.settings": "Cài đặt",
  "mock.newReport": "Báo cáo mới",
  "mock.revenue": "Doanh thu",
  "mock.users": "Người dùng",
  "mock.growth": "Tăng trưởng",
  "mock.weekly": "Hoạt động trong tuần",
  "mock.created": "Đã tạo báo cáo",
  "mock.peak": "Cao nhất: Thứ Năm",

  "metrics.cursor": "Theo dõi con trỏ",
  "metrics.cursorValue": "60 fps",
  "metrics.retina": "Xuất MP4 · 60 fps",
  "metrics.retinaValue": "Tới 4K",
  "metrics.upload": "Tải lên cloud",
  "metrics.uploadValue": "0 byte",
  "metrics.price": "Watermark hay giới hạn",
  "metrics.priceValue": "Không có",

  "how.kicker": "Cách hoạt động",
  "how.title": "Từ bản quay thô đến video sẵn sàng chia sẻ chỉ với ba bước.",
  "how.step1": "Bấm quay",
  "how.step1Copy": "Chọn màn hình hoặc cửa sổ. Đếm ngược 3 giây, rồi ScreenSway tự ẩn đi.",
  "how.step2": "Thêm dấu ấn riêng",
  "how.step2Copy": "Tự zoom bám theo thao tác. Cắt video, chỉnh zoom, chọn style và thêm phụ đề trên máy ngay trong Studio.",
  "how.step3": "Xuất video. Chia sẻ.",
  "how.step3Copy": "Lưu MP4 hoàn chỉnh đến 4K ở 60 fps, với âm thanh, phụ đề và khung hình yêu thích.",

  "features.kicker": "Bắt đầu từ một bản quay tốt hơn",
  "features.title": "Bạn trình bày. Máy quay tự bám theo.",
  "features.zoomTitle": "Tự zoom như quay phim",
  "features.zoomCopy": "Chuyển động máy quay kiểu lò xo zoom vào từng cú click và lia theo con trỏ — không cần keyframe, không giật.",
  "features.cursorTitle": "Con trỏ mượt & hiệu ứng click",
  "features.cursorCopy": "Con trỏ được vẽ lại mượt theo tần số quét màn hình, kèm hiệu ứng gợn sóng nhẹ mỗi lần click.",
  "features.hudTitle": "Thanh điều khiển vô hình",
  "features.hudCopy": "Thanh Liquid Glass nổi và đồng hồ trên menu bar giúp bạn kiểm soát — mà không bao giờ lọt vào video.",
  "features.pauseTitle": "Tạm dừng không để lại khoảng trống",
  "features.pauseCopy": "Tạm dừng và tiếp tục bao nhiêu lần tùy ý. Khoảng thời gian tạm dừng tự động bị cắt khỏi video.",
  "features.libraryTitle": "Thư viện ngay trên máy Mac",
  "features.libraryCopy": "Mỗi bản quay là một thư mục trong Phim › ScreenSway. Mở, xem trước hoặc hiện trong Finder.",
  "features.nativeTitle": "Chuẩn cảm giác macOS",
  "features.nativeCopy": "Quay chuẩn Retina, điều khiển Liquid Glass nổi, giao diện Việt hoặc Anh. Dành cho macOS 15 trở lên, trên Apple silicon và Intel.",

  "compare.kicker": "Sự khác biệt",
  "compare.title": "Cùng một bản quay. Một câu chuyện hoàn toàn khác.",
  "compare.raw": "Quay màn hình thông thường",
  "compare.sway": "ScreenSway",
  "compare.row1": "Người xem đọc được chữ nhỏ trên giao diện",
  "compare.row2": "Máy quay bám theo thao tác",
  "compare.row3": "Con trỏ mượt và phản hồi click",
  "compare.row4": "Tự cắt khoảng tạm dừng",
  "compare.row5": "Bản quay ở lại trên máy bạn",
  "compare.yes": "Có",
  "compare.no": "Không",
  "compare.depends": "Tùy ứng dụng",

  "privacy.kicker": "Riêng tư từ thiết kế",
  "privacy.title": "Màn hình, giọng nói, máy Mac của bạn.",
  "privacy.copy": "Quay, chỉnh sửa, nhận dạng giọng nói và xuất video đều diễn ra trên Mac. Không cần tài khoản, không xử lý trên cloud, không gửi request mạng khi bạn sáng tạo. Video và bản thu giọng nói ở lại với bạn.",
  "privacy.item1": "Không cần tài khoản hay đăng nhập",
  "privacy.item2": "Không xử lý trên cloud",
  "privacy.item3": "File của bạn, trong thư mục của bạn",
  "privacy.core": "Trên thiết bị",
  "privacy.video": "Video màn hình",
  "privacy.cursor": "Dữ liệu con trỏ",
  "privacy.project": "File dự án",

  "faq.kicker": "Hỏi đáp",
  "faq.title": "Câu hỏi thường gặp",
  "faq.more": "Chưa thấy câu trả lời? Chúng tôi phản hồi nhanh —",
  "faq.email": "gửi email cho chúng tôi",
  "faq.chatQuestion": "ScreenSway có miễn phí thật không?",
  "faq.chatAnswer": "Thật — đủ mọi tính năng, không watermark, không cần tài khoản.",
  "faq.q1": "ScreenSway có thật sự miễn phí không?",
  "faq.a1": "Có. Mọi tính năng đều miễn phí, không watermark, không giới hạn thời lượng và không cần tài khoản.",
  "faq.q2": "Hỗ trợ những hệ điều hành nào?",
  "faq.a2": "macOS 15 trở lên, trên máy Mac chip Apple silicon và Intel. Phiên bản Windows đang được phát triển.",
  "faq.q3": "Tôi có tắt được tính năng tự zoom không?",
  "faq.a3": "Được. Tắt tự zoom hoặc di chuyển, đổi độ dài, thêm và xóa zoom ngay trên timeline. Bạn còn chỉnh được độ phóng đại và cắt đầu hoặc cuối video. Bản quay gốc được giữ nguyên.",
  "faq.q7": "Tôi có tùy chỉnh khung và xuất video 4K được không?",
  "faq.a7": "Được. Chọn style có sẵn hoặc tùy chỉnh nền, khung, khoảng đệm, bo góc và đổ bóng. Xuất MP4 ở 1080p, 1440p hoặc 4K và 60 fps với âm thanh, con trỏ, zoom và phụ đề. Chất lượng xuất còn phụ thuộc vào bản quay gốc.",
  "faq.q8": "Tạo phụ đề có cần dịch vụ cloud không?",
  "faq.a8": "Không. Nhận dạng giọng nói tiếng Việt và tiếng Anh chạy ngay trên Mac bằng cơ chế trên thiết bị của Apple. Cần có mô hình ngôn ngữ hỗ trợ và quyền Nhận dạng giọng nói. Bạn có thể sửa nội dung, xuất phụ đề lên MP4 và giữ file SRT riêng.",
  "faq.q4": "Bản quay được lưu ở đâu?",
  "faq.a4": "Trong Phim › ScreenSway trên máy Mac của bạn. Mỗi bản quay là một thư mục chứa video và dữ liệu con trỏ.",
  "faq.q5": "ScreenSway có ghi âm không?",
  "faq.a5": "Có. Ghi âm thanh hệ thống, micro hoặc cả hai; giọng nói được tự cân âm lượng và giảm tiếng ồn nền. ScreenSway còn tạo phụ đề tiếng Việt hoặc tiếng Anh ngay trên máy Mac.",
  "faq.q6": "macOS báo không thể xác minh ScreenSway. Làm sao để mở?",
  "faq.a6": "Bản thử nghiệm này chưa được Apple chứng nhận (notarize). Kéo ScreenSway vào Ứng dụng rồi mở app một lần. Khi macOS báo “chưa được mở”, bấm “Xong” (đừng bấm “Chuyển vào Thùng rác”), rồi vào Cài đặt hệ thống › Quyền riêng tư & Bảo mật, kéo xuống dưới và bấm “Vẫn mở”. Bạn chỉ cần làm việc này một lần.",
  "guide.kicker": "Sắp xong rồi",
  "guide.title": "Cài ScreenSway trong khoảng một phút",
  "guide.downloading": "File đang được tải về (ScreenSway-macos-universal.dmg, 4 MB).",
  "guide.retry": "Tải lại",
  "guide.close": "Đóng hướng dẫn cài đặt",
  "guide.step1Title": "Kéo app vào Ứng dụng",
  "guide.step1": "Mở file DMG vừa tải và kéo ScreenSway vào thư mục Ứng dụng (Applications).",
  "guide.applications": "Ứng dụng",
  "guide.step2Title": "Mở app, rồi bấm “Xong”",
  "guide.step2": "Bản thử nghiệm này chưa được Apple chứng nhận nên macOS sẽ chặn lần mở đầu tiên. Hãy bấm “Xong” — đừng bấm “Chuyển vào Thùng rác”.",
  "guide.alertTitle": "“ScreenSway.app” chưa được mở",
  "guide.trash": "Chuyển vào Thùng rác",
  "guide.done": "Xong",
  "guide.step3Title": "Cho phép trong Quyền riêng tư & Bảo mật",
  "guide.step3": "Mở Cài đặt hệ thống › Quyền riêng tư & Bảo mật, kéo xuống cuối, bấm “Vẫn mở” rồi xác nhận thêm một lần.",
  "guide.settingsPath": "Cài đặt hệ thống › Quyền riêng tư & Bảo mật",
  "guide.blocked": "“ScreenSway.app” đã bị chặn để bảo vệ máy Mac của bạn.",
  "guide.openAnyway": "Vẫn mở",
  "guide.step4Title": "Cho phép ghi màn hình",
  "guide.step4": "Khi ScreenSway hỏi, bật Ghi màn hình & âm thanh hệ thống rồi chọn “Thoát & Mở lại”. Vậy là xong — bạn sẽ không phải làm lại các bước này.",
  "guide.terminalSummary": "Quen dùng Terminal? Bỏ qua bước 2–3",
  "guide.terminal": "Sau bước 1, chạy lệnh này một lần rồi mở ScreenSway như bình thường:",
  "guide.copy": "Sao chép",
  "guide.copied": "Đã sao chép",
  "guide.why": "Vì sao có bước này? ScreenSway miễn phí và chạy offline; bản này chưa qua quy trình chứng nhận trả phí của Apple.",
  "guide.gotIt": "Đã hiểu",
  "hero.howToInstall": "Hướng dẫn cài đặt",

  "cta.title": "Biến mỗi cú click thành khoảnh khắc đáng xem.",
  "cta.copy": "Tải ScreenSway và biến bản quay màn hình tiếp theo thành video mà mọi người thật sự muốn xem.",

  "footer.tagline": "Video quay màn hình đẹp, hoàn toàn tự động.",
  "footer.contact": "Liên hệ",
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

function initialLanguage(): Language {
  const fromUrl = new URLSearchParams(window.location.search).get("lang");
  if (fromUrl === "en" || fromUrl === "vi") return fromUrl;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "vi") return stored;
  } catch {
    // Storage can be unavailable; fall back to the browser language.
  }
  return navigator.language.toLowerCase().startsWith("vi") ? "vi" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = language === "vi"
      ? "ScreenSway — Video quay màn hình đẹp, hoàn toàn tự động"
      : "ScreenSway — Beautiful screen recordings, automatically";
  }, [language]);

  const value = useMemo<I18nContextValue>(() => {
    const messages = MESSAGES[language];
    return {
      language,
      setLanguage: (next) => {
        setLanguageState(next);
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // The choice still applies for this visit.
        }
      },
      t: (key, params) =>
        messages[key].replace(/\{(\w+)\}/g, (match, name: string) =>
          params && name in params ? String(params[name]) : match,
        ),
    };
  }, [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
