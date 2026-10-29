import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type Language = "en" | "vi";

const en = {
  "nav.demo": "Demo",
  "nav.features": "Features",
  "nav.privacy": "Privacy",
  "nav.faq": "FAQ",
  "nav.download": "Download guide",
  "nav.web": "Record on the web",
  "nav.language": "Language",
  "nav.home": "ScreenSway home",
  "nav.skip": "Skip to content",
  "nav.menuOpen": "Open navigation",
  "nav.menuClose": "Close navigation",

  "guide.winDownloads": "Downloads",
  "guide.winInstaller": "Application · Windows x64",
  "guide.winOpen": "Open",
  "guide.winProtected": "Windows protected your PC",
  "guide.winMoreInfo": "1. More info",
  "guide.winRunAnyway": "2. Run anyway",
  "guide.winMicrophone": "Privacy & security › Microphone",
  "guide.winDesktopAccess": "Let desktop apps access your microphone",
  "guide.winOn": "On",
  "guide.windowsDownload": "Windows x64 installer · 494 MiB, including offline captions.",
  "guide.win1Title": "Run the installer",
  "guide.win1": "Open ScreenSway-windows-x64-setup.exe from Downloads and follow the setup wizard.",
  "guide.win2Title": "Check the Windows security prompt",
  "guide.win2": "This build is not code-signed. If SmartScreen appears, verify you downloaded it from this site, then choose More info → Run anyway. Managed computers may require administrator approval.",
  "guide.win3Title": "Open ScreenSway and start recording",
  "guide.win3": "Launch ScreenSway from Start. Choose a screen or window and your audio sources. For microphone recording, allow desktop apps to access your microphone in Windows Settings → Privacy & security → Microphone.",
  "guide.windowsRequirements": "The installer includes the Vietnamese and English speech model; no model download is needed after installation. Captions run on your CPU and require AVX2, FMA, F16C and BMI2.",
  "hero.perks": "Free, no watermark",
  "hero.titleA": "Record your screen.",
  "hero.titleB": "Polished on the first take.",
  "hero.copy": "“Hit record. ScreenSway handles the zoom.”",
  "hero.mac": "Download for macOS",
  "hero.platforms": "macOS\u00a015+ & Windows\u00a011",
  "hero.windows": "Download for Windows",

  "demo.label": "Interactive demo of ScreenSway's automatic zoom",
  "demo.with": "With ScreenSway",
  "demo.without": "Raw recording",
  "demo.play": "Play demo",
  "demo.pause": "Pause demo",
  "demo.zoom": "Auto zoom {scale}×",
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
  "mock.title": "ScreenSway Analytics",
  "mock.greeting": "Hello, Nvdeekay",
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

  "faq.kicker": "FAQ",
  "faq.title": "Common questions",
  "faq.more": "Not answered here? We reply fast —",
  "faq.email": "email us",
  "faq.q1": "Is ScreenSway really free?",
  "faq.a1": "Yes. Every feature is free, with no watermark, no time limit and no account.",
  "faq.q2": "Which systems are supported?",
  "faq.a2": "macOS 15 or later on Apple silicon and Intel, or Windows x64 (tested on Windows 11). Windows offline captions require a CPU with AVX2, FMA, F16C and BMI2 support.",
  "faq.q3": "Can I turn the automatic zoom off?",
  "faq.a3": "Yes. Turn auto zoom off, or move, resize, add and remove zooms on the timeline. Adjust each zoom's depth and trim the beginning or end. Your original recording stays unchanged.",
  "faq.q7": "Can I customize the frame and export in 4K?",
  "faq.a7": "Yes. Choose a built-in style or customize backgrounds, frames, padding, corners and shadow. Export an MP4 at 1080p, 1440p or 4K and 60 fps, with your audio, cursor, zooms and captions. Export quality also depends on the source recording.",
  "faq.q9": "Can I use ScreenSway without installing it?",
  "faq.a9": "Yes. ScreenSway Web works in Chrome or Edge on a computer: record, trim, style and export an MP4 without an account or upload. Browser zooms follow where your pointer settles; captions, pause and the recording library are available in the desktop app.",
  "guide.title": "Install ScreenSway",
  "guide.downloading": "macOS universal installer · 6 MB.",
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
  "guide.step3": "Right after that, open System Settings › Privacy & Security, scroll to the bottom and click “Open Anyway” (it appears only for a while after the blocked launch). Confirm with “Open Anyway” again and your Mac password or Touch ID.",
  "guide.settingsPath": "System Settings › Privacy & Security",
  "guide.blocked": "“ScreenSway.app” was blocked to protect your Mac.",
  "guide.openAnyway": "Open Anyway",
  "guide.step4Title": "Allow screen recording",
  "guide.step4": "Choose “Check screen access” in ScreenSway, turn it on under Screen & System Audio Recording and choose “Quit & Reopen”. Steps 2–3 happen only once. After an update, if ScreenSway says screen access is blocked although the switch is on, choose “Reset permission and reopen” in the app and allow it again.",
  "guide.terminalSummary": "Comfortable with Terminal? Skip steps 2–3",
  "guide.terminal": "After step 1, run this command once, then open ScreenSway normally:",
  "guide.copy": "Copy",
  "guide.copied": "Copied",
  "guide.why": "Why the extra step? ScreenSway is free and works offline; this build hasn't been through Apple's paid notarization yet.",
  "guide.gotIt": "Got it",
  "hero.howToInstall": "How to install",
  "hero.web": "Try it in your browser",
  "hero.webBeta": "Beta",
  "webFeature.kicker": "ScreenSway Web · Beta",
  "webFeature.title": "Record in your browser.",
  "webFeature.copy": "Start a polished screen recording in Chrome or Edge, without installing anything.",
  "webFeature.point1": "Nothing to install",
  "webFeature.point2": "Nothing is uploaded",
  "webFeature.point3": "The same styles and timeline",
  "webFeature.limits": "Chrome or Edge on a computer · zooms follow where the pointer settles · captions are desktop-only for now",
  "webFeature.cta": "Try ScreenSway Web",
  "webFeature.local": "Local",
  "webFeature.timeline": "Zooms where the pointer pauses",
  "webFeature.visual": "ScreenSway Web zooming into a dashboard wherever the pointer pauses",

  "feedback.open": "Feedback",
  "feedback.title": "Send feedback",
  "feedback.intro": "Ideas, problems, anything at all. Every message is read.",
  "feedback.category": "Type",
  "feedback.category.idea": "Idea",
  "feedback.category.bug": "Bug report",
  "feedback.category.feature": "Feature request",
  "feedback.category.experience": "Usability",
  "feedback.category.other": "Other",
  "feedback.rating": "How is ScreenSway working for you? (optional)",
  "feedback.ratingValue": "{value} out of 5",
  "feedback.ratingClear": "Clear rating",
  "feedback.message": "Your message",
  "feedback.messagePlaceholder": "What happened, or what would help you?",
  "feedback.count": "{count} / {max}",
  "feedback.email": "Email for a reply (optional)",
  "feedback.metadata": "Include technical details",
  "feedback.metadataHint": "Site version, system, browser, language and a random ID for this visit (none if your browser asks not to be tracked). The server adds your country.",
  "feedback.privacy": "What you type here is sent to ScreenSway. Your email is optional and only used to reply to you.",
  "feedback.honeypot": "Leave this field empty",
  "feedback.send": "Send",
  "feedback.sending": "Sending…",
  "feedback.cancel": "Cancel",
  "feedback.close": "Close",
  "feedback.thanks": "Thank you!",
  "feedback.thanksBody": "Your feedback was sent.",
  "feedback.retry": "Try again",
  "feedback.needMessage": "Write a message first.",
  "feedback.tooLong": "The message is longer than 4,000 characters.",
  "feedback.badEmail": "This email address does not look right.",
  "feedback.errorNetwork": "Could not reach ScreenSway. Check your connection and try again.",
  "feedback.errorRateLimited": "Too many messages in a short time. Please try again later.",
  "feedback.errorInvalid": "Part of the form could not be accepted. Check it and try again.",
  "feedback.errorUnavailable": "Feedback cannot be sent right now. Please try again later.",

  "cta.title": "Make every click worth watching.",

  "footer.tagline": "Beautiful screen recordings, automatically.",
  "footer.contact": "Contact",
};

export type MessageKey = keyof typeof en;

const vi: Record<MessageKey, string> = {
  "nav.demo": "Demo",
  "nav.features": "Tính năng",
  "nav.privacy": "Quyền riêng tư",
  "nav.faq": "Hỏi đáp",
  "nav.download": "Hướng dẫn tải",
  "nav.web": "Quay trên web",
  "nav.language": "Ngôn ngữ",
  "nav.home": "Trang chủ ScreenSway",
  "nav.skip": "Bỏ qua tới nội dung",
  "nav.menuOpen": "Mở menu",
  "nav.menuClose": "Đóng menu",

  "guide.winDownloads": "Tải xuống",
  "guide.winInstaller": "Ứng dụng · Windows x64",
  "guide.winOpen": "Mở",
  "guide.winProtected": "Windows đã bảo vệ PC của bạn",
  "guide.winMoreInfo": "1. Thông tin thêm (More info)",
  "guide.winRunAnyway": "2. Vẫn chạy (Run anyway)",
  "guide.winMicrophone": "Quyền riêng tư & bảo mật › Micro",
  "guide.winDesktopAccess": "Cho phép ứng dụng desktop truy cập micro",
  "guide.winOn": "Bật",
  "guide.windowsDownload": "Bản cài Windows x64 · 494 MiB, gồm mô hình phụ đề offline.",
  "guide.win1Title": "Chạy file cài đặt",
  "guide.win1": "Mở ScreenSway-windows-x64-setup.exe trong thư mục Tải xuống và làm theo trình cài đặt.",
  "guide.win2Title": "Kiểm tra cảnh báo bảo mật Windows",
  "guide.win2": "Bản này chưa ký số. Nếu SmartScreen xuất hiện, kiểm tra file được tải từ trang này, rồi chọn More info → Run anyway. Máy do tổ chức quản lý có thể cần quản trị viên cho phép.",
  "guide.win3Title": "Mở ScreenSway và bắt đầu quay",
  "guide.win3": "Mở ScreenSway từ Start. Chọn màn hình hoặc cửa sổ và nguồn âm thanh. Để thu micro, bật quyền truy cập micro cho ứng dụng desktop trong Windows Settings → Privacy & security → Microphone.",
  "guide.windowsRequirements": "Bản cài đã chứa mô hình tiếng Việt và tiếng Anh; không cần tải thêm mô hình sau khi cài. Phụ đề chạy bằng CPU và cần AVX2, FMA, F16C, BMI2.",
  "hero.perks": "Miễn phí, không watermark",
  "hero.titleA": "Bấm quay màn hình.",
  "hero.titleB": "Đẹp ngay từ lần đầu.",
  "hero.copy": "“Cứ bấm quay. Việc zoom để ScreenSway lo.”",
  "hero.mac": "Tải cho macOS",
  "hero.platforms": "macOS\u00a015+ & Windows\u00a011",
  "hero.windows": "Tải cho Windows",

  "demo.label": "Demo tương tác tính năng tự động zoom của ScreenSway",
  "demo.with": "Có ScreenSway",
  "demo.without": "Bản quay thường",
  "demo.play": "Phát demo",
  "demo.pause": "Tạm dừng demo",
  "demo.zoom": "Tự zoom {scale}×",
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
  "mock.title": "ScreenSway Analytics",
  "mock.greeting": "Hello, Nvdeekay",
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

  "faq.kicker": "Hỏi đáp",
  "faq.title": "Câu hỏi thường gặp",
  "faq.more": "Chưa thấy câu trả lời? Chúng tôi phản hồi nhanh —",
  "faq.email": "gửi email cho chúng tôi",
  "faq.q1": "ScreenSway có thật sự miễn phí không?",
  "faq.a1": "Có. Mọi tính năng đều miễn phí, không watermark, không giới hạn thời lượng và không cần tài khoản.",
  "faq.q2": "Hỗ trợ những hệ điều hành nào?",
  "faq.a2": "macOS 15 trở lên trên Apple silicon và Intel, hoặc Windows x64 (đã kiểm thử trên Windows 11). Phụ đề offline trên Windows cần CPU hỗ trợ AVX2, FMA, F16C và BMI2.",
  "faq.q3": "Tôi có tắt được tính năng tự zoom không?",
  "faq.a3": "Được. Tắt tự zoom hoặc di chuyển, đổi độ dài, thêm và xóa zoom ngay trên timeline. Bạn còn chỉnh được độ phóng đại và cắt đầu hoặc cuối video. Bản quay gốc được giữ nguyên.",
  "faq.q7": "Tôi có tùy chỉnh khung và xuất video 4K được không?",
  "faq.a7": "Được. Chọn style có sẵn hoặc tùy chỉnh nền, khung, khoảng đệm, bo góc và đổ bóng. Xuất MP4 ở 1080p, 1440p hoặc 4K và 60 fps với âm thanh, con trỏ, zoom và phụ đề. Chất lượng xuất còn phụ thuộc vào bản quay gốc.",
  "faq.q9": "Tôi có thể dùng ScreenSway mà không cần cài đặt không?",
  "faq.a9": "Có. ScreenSway Web chạy trong Chrome hoặc Edge trên máy tính: quay, cắt, chọn style và xuất MP4 mà không cần tài khoản hay tải lên. Bản web zoom theo nơi con trỏ dừng lại; phụ đề, tạm dừng và thư viện bản quay có trong ứng dụng máy tính.",
  "guide.title": "Cài đặt ScreenSway",
  "guide.downloading": "Bản cài macOS universal · 6 MB.",
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
  "guide.step3": "Ngay sau đó, mở Cài đặt hệ thống › Quyền riêng tư & Bảo mật, kéo xuống cuối và bấm “Vẫn mở” (nút này chỉ hiện một lúc sau lần mở bị chặn). Bấm “Vẫn mở” thêm lần nữa rồi nhập mật khẩu máy hoặc Touch ID.",
  "guide.settingsPath": "Cài đặt hệ thống › Quyền riêng tư & Bảo mật",
  "guide.blocked": "“ScreenSway.app” đã bị chặn để bảo vệ máy Mac của bạn.",
  "guide.openAnyway": "Vẫn mở",
  "guide.step4Title": "Cho phép ghi màn hình",
  "guide.step4": "Bấm “Kiểm tra quyền” trong ScreenSway, bật ScreenSway ở Ghi màn hình & âm thanh hệ thống rồi chọn “Thoát & Mở lại”. Bước 2–3 chỉ làm một lần. Sau khi cập nhật, nếu ScreenSway báo bị chặn dù công tắc vẫn bật, hãy bấm “Đặt lại quyền và mở lại” trong app rồi cho phép lại.",
  "guide.terminalSummary": "Quen dùng Terminal? Bỏ qua bước 2–3",
  "guide.terminal": "Sau bước 1, chạy lệnh này một lần rồi mở ScreenSway như bình thường:",
  "guide.copy": "Sao chép",
  "guide.copied": "Đã sao chép",
  "guide.why": "Vì sao có bước này? ScreenSway miễn phí và chạy offline; bản này chưa qua quy trình chứng nhận trả phí của Apple.",
  "guide.gotIt": "Đã hiểu",
  "hero.howToInstall": "Hướng dẫn cài đặt",
  "hero.web": "Thử ngay trên trình duyệt",
  "hero.webBeta": "Beta",
  "webFeature.kicker": "ScreenSway Web · Beta",
  "webFeature.title": "Quay ngay trên trình duyệt.",
  "webFeature.copy": "Bắt đầu một bản quay chỉn chu trong Chrome hoặc Edge mà không cần cài đặt.",
  "webFeature.point1": "Không cần cài đặt",
  "webFeature.point2": "Không tải lên đâu cả",
  "webFeature.point3": "Cùng style và timeline",
  "webFeature.limits": "Chrome hoặc Edge trên máy tính · zoom theo nơi con trỏ dừng lại · phụ đề hiện chỉ có trên bản máy tính",
  "webFeature.cta": "Thử ScreenSway Web",
  "webFeature.local": "Trên máy",
  "webFeature.timeline": "Zoom ở chỗ con trỏ dừng",
  "webFeature.visual": "ScreenSway Web tự zoom vào bảng số liệu ở chỗ con trỏ dừng lại",

  "feedback.open": "Góp ý",
  "feedback.title": "Gửi góp ý",
  "feedback.intro": "Ý tưởng, lỗi gặp phải hay bất cứ điều gì. Mọi góp ý đều được đọc.",
  "feedback.category": "Loại góp ý",
  "feedback.category.idea": "Góp ý",
  "feedback.category.bug": "Báo lỗi",
  "feedback.category.feature": "Yêu cầu tính năng",
  "feedback.category.experience": "Trải nghiệm sử dụng",
  "feedback.category.other": "Khác",
  "feedback.rating": "Bạn thấy ScreenSway thế nào? (không bắt buộc)",
  "feedback.ratingValue": "{value} trên 5",
  "feedback.ratingClear": "Bỏ chấm điểm",
  "feedback.message": "Nội dung",
  "feedback.messagePlaceholder": "Chuyện gì đã xảy ra, hoặc điều gì sẽ giúp ích cho bạn?",
  "feedback.count": "{count} / {max}",
  "feedback.email": "Email để nhận phản hồi (không bắt buộc)",
  "feedback.metadata": "Kèm thông tin kỹ thuật",
  "feedback.metadataHint": "Phiên bản trang, hệ điều hành, trình duyệt, ngôn ngữ và một mã ngẫu nhiên của lượt truy cập này (không có nếu trình duyệt yêu cầu không theo dõi). Máy chủ tự thêm quốc gia của bạn.",
  "feedback.privacy": "Nội dung bạn nhập ở đây sẽ được gửi đến ScreenSway. Email không bắt buộc và chỉ dùng để trả lời bạn.",
  "feedback.honeypot": "Để trống ô này",
  "feedback.send": "Gửi",
  "feedback.sending": "Đang gửi…",
  "feedback.cancel": "Huỷ",
  "feedback.close": "Đóng",
  "feedback.thanks": "Cảm ơn bạn!",
  "feedback.thanksBody": "Góp ý của bạn đã được gửi.",
  "feedback.retry": "Thử lại",
  "feedback.needMessage": "Hãy viết nội dung góp ý trước.",
  "feedback.tooLong": "Nội dung dài hơn 4.000 ký tự.",
  "feedback.badEmail": "Địa chỉ email có vẻ chưa đúng.",
  "feedback.errorNetwork": "Không kết nối được tới ScreenSway. Hãy kiểm tra mạng rồi thử lại.",
  "feedback.errorRateLimited": "Bạn đã gửi quá nhiều trong thời gian ngắn. Hãy thử lại sau.",
  "feedback.errorInvalid": "Một phần nội dung chưa hợp lệ. Hãy kiểm tra rồi thử lại.",
  "feedback.errorUnavailable": "Hiện chưa gửi được góp ý. Hãy thử lại sau.",

  "cta.title": "Biến mỗi cú click thành khoảnh khắc đáng xem.",

  "footer.tagline": "Video quay màn hình đẹp, hoàn toàn tự động.",
  "footer.contact": "Liên hệ",
};

const MESSAGES: Record<Language, Record<MessageKey, string>> = { en, vi };
const STORAGE_KEY = "screensway.language";

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

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
    // Storage can be unavailable; fall back to English.
  }
  return "en";
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
