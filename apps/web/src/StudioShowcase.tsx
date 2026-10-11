import { Check, Captions, Film, Mic, Palette, Scissors, ShieldCheck, SlidersHorizontal, Sparkles, Upload, Volume2 } from "lucide-react";
import { useState } from "react";
import { Demo } from "./Demo";
import { useI18n } from "./i18n";

const CONTENT = {
  en: {
    label: "Interactive Studio illustration", project: "Your next product walkthrough", studio: "ScreenSway Studio",
    styles: "Make it yours", stylesCopy: "One recording. A whole new look.", tryStyle: "Try a style", caption: "Show sample captions",
    sample: "A little focus makes a big difference.", note: "Interactive illustration · explore styles and auto zoom", export: "MP4 · up to 4K · 60 fps",
    kicker: "Meet your new editing studio", title: "The finishing touches.\nAll in one place.",
    copy: "Let the camera do its thing. Then give your recording the look, pacing and voice it deserves.",
    cards: [
      { title: "A look that feels like you", copy: "Start with Studio, Clean, MacBook, Website or Social. Add mesh and wave backgrounds, a custom gradient or your own image. Save your favorite looks for next time.", tags: ["Ready-made styles", "Custom backgrounds", "Saved looks"] },
      { title: "Keep the good parts", copy: "Trim the beginning and end. Move, resize, add or remove zooms right on the timeline, and dial in how close the camera gets. Reset to automatic whenever you like.", tags: ["Trim", "Editable zooms", "Zoom depth"] },
      { title: "Let your voice do the talking", copy: "Record system audio, a microphone, or both. Voice leveling and a gentle noise gate keep your explanation clear, with every pause cut from the audio and video together.", tags: ["System audio + mic", "Voice leveling", "Pause & resume"] },
      { title: "Say it. Caption it.", copy: "Create Vietnamese or English captions on your Mac, edit the words, and choose a look and size. Burn captions into the MP4 and get an SRT file alongside it.", tags: ["Vietnamese & English", "Editable captions", "SRT included"] },
    ],
    exportKicker: "Ready for the big screen. Or the small one.", exportTitle: "Your story, beautifully packaged.",
    exportCopy: "Export a finished MP4 with your zooms, cursor, background, frame, audio and captions. Choose 1080p, 1440p or 4K at 60 fps. The original recording stays yours to revisit.",
    formats: "Auto · 16:9 · 4:3 · 1:1 · 9:16 canvas presets", local: "Rendered on your Mac. No upload. No watermark.",
    example: "Illustrative export settings", resolution: "Resolution", frameRate: "Frame rate", format: "Format", included: "Your edits, included", includes: ["Camera & cursor", "Background & frame", "Audio & captions"],
  },
  vi: {
    label: "Minh họa Studio tương tác", project: "Video giới thiệu sản phẩm tiếp theo", studio: "ScreenSway Studio",
    styles: "Mang dấu ấn của bạn", stylesCopy: "Một bản quay. Nhiều diện mạo.", tryStyle: "Thử một phong cách", caption: "Hiện phụ đề mẫu",
    sample: "Tập trung đúng chỗ. Khác biệt rõ ràng.", note: "Minh họa tương tác · thử style và tự zoom", export: "MP4 · đến 4K · 60 fps",
    kicker: "Làm quen với Studio", title: "Chỉnh chu từng chi tiết.\nNgay trong một ứng dụng.",
    copy: "Để máy quay tự bám theo thao tác. Sau đó, thêm diện mạo, nhịp điệu và lời dẫn của riêng bạn.",
    cards: [
      { title: "Một diện mạo thật riêng", copy: "Bắt đầu với Studio, Clean, MacBook, Website hoặc Social. Thêm nền mesh, sóng màu, gradient tùy chỉnh hay ảnh của bạn. Lưu phong cách yêu thích để dùng lại lần sau.", tags: ["Style có sẵn", "Nền tùy chỉnh", "Lưu phong cách"] },
      { title: "Giữ lại phần đáng xem", copy: "Cắt đầu và cuối video. Di chuyển, đổi độ dài, thêm hoặc xóa zoom ngay trên timeline và chỉnh độ phóng đại. Trở về zoom tự động bất cứ khi nào bạn muốn.", tags: ["Cắt đầu & cuối", "Chỉnh từng zoom", "Độ phóng đại"] },
      { title: "Để giọng nói dẫn câu chuyện", copy: "Ghi âm hệ thống, micro hoặc cả hai. Tự cân âm lượng và giảm tiếng ồn giữa các câu giúp lời dẫn rõ hơn. Khoảng tạm dừng được cắt đồng bộ khỏi cả âm thanh và video.", tags: ["Âm hệ thống + micro", "Cân âm giọng nói", "Tạm dừng & tiếp tục"] },
      { title: "Bạn nói. ScreenSway thêm phụ đề.", copy: "Tạo phụ đề tiếng Việt hoặc tiếng Anh ngay trên Mac, sửa nội dung rồi chọn kiểu và cỡ chữ. Xuất phụ đề trực tiếp lên MP4, kèm một file SRT để dùng riêng.", tags: ["Tiếng Việt & tiếng Anh", "Sửa phụ đề", "Kèm file SRT"] },
    ],
    exportKicker: "Đẹp trên màn hình lớn. Gọn trên màn hình nhỏ.", exportTitle: "Câu chuyện của bạn, sẵn sàng chia sẻ.",
    exportCopy: "Xuất MP4 hoàn chỉnh với zoom, con trỏ, nền, khung, âm thanh và phụ đề. Chọn 1080p, 1440p hoặc 4K ở 60 fps. Bản quay gốc luôn được giữ lại để bạn chỉnh tiếp.",
    formats: "Khung hình Auto · 16:9 · 4:3 · 1:1 · 9:16", local: "Render ngay trên Mac. Không tải lên. Không watermark.",
    example: "Minh họa thiết lập xuất video", resolution: "Độ phân giải", frameRate: "Tốc độ khung hình", format: "Định dạng", included: "Mang theo mọi chỉnh sửa", includes: ["Máy quay & con trỏ", "Nền & khung", "Âm thanh & phụ đề"],
  },
};

const LOOKS = ["Studio", "Clean", "MacBook", "Website", "Social"] as const;
const ICONS = [Palette, Scissors, Mic, Captions];

export function StudioShowcase() {
  const { language } = useI18n();
  const c = CONTENT[language];
  const [look, setLook] = useState<typeof LOOKS[number]>("Studio");
  const [captions, setCaptions] = useState(false);
  return (
    <div className="studio-showcase" role="region" aria-label={c.label} data-look={look.toLowerCase()}>
      <div className="studio-titlebar">
        <span className="studio-window-dots" aria-hidden="true"><i /><i /><i /></span>
        <span>{c.studio} <span className="studio-project">/ {c.project}</span></span>
        <span className="studio-export-label"><Film size={14} aria-hidden="true" /> {c.export}</span>
      </div>
      <div className="studio-workspace">
        <div className="studio-live-preview">
          <Demo />
          {captions && <div className="sample-caption" aria-hidden="true">{c.sample}</div>}
        </div>
        <aside className="studio-style-panel">
          <span className="studio-panel-label"><SlidersHorizontal size={16} aria-hidden="true" /> {c.styles}</span>
          <p>{c.stylesCopy}</p>
          <div className="studio-looks" role="group" aria-label={c.tryStyle}>
            {LOOKS.map((name) => (
              <button key={name} aria-pressed={look === name} onClick={() => setLook(name)} className="studio-look">
                <span className={`look-swatch swatch-${name.toLowerCase()}`} aria-hidden="true"><i /></span>
                <span>{name}</span>
                {look === name && <Check size={15} aria-hidden="true" />}
              </button>
            ))}
          </div>
          <button className="studio-caption-toggle" aria-pressed={captions} onClick={() => setCaptions(!captions)}>
            <Captions size={18} aria-hidden="true" /> {c.caption}<span className="mini-switch" aria-hidden="true" />
          </button>
        </aside>
      </div>
      <p className="studio-demo-note"><Sparkles size={13} aria-hidden="true" />{c.note}</p>
    </div>
  );
}

export function StudioFeatures() {
  const { language } = useI18n();
  const c = CONTENT[language];
  return (
    <>
      <section className="studio-features" id="studio">
        <div className="studio-section-heading" data-reveal>
          <span className="kicker">{c.kicker}</span><h2>{c.title}</h2><p>{c.copy}</p>
        </div>
        <div className="studio-feature-grid">
          {c.cards.map((card, index) => {
            const Icon = ICONS[index];
            return (
              <article className={`studio-feature feature-${index}`} key={card.title} data-reveal>
                <div className="studio-feature-art" aria-hidden="true">
                  {index === 0 && <div className="frame-stack"><span /><span /><span /><Palette size={26} /></div>}
                  {index === 1 && <div className="timeline-art"><div className="timeline-ticks"><span>0:00</span><span>0:15</span><span>0:30</span></div><div className="timeline-film" /><div className="timeline-zooms"><i /><i /><i /></div><b /></div>}
                  {index === 2 && <div className="audio-art"><Mic size={24} /><div>{Array.from({ length: 25 }, (_, i) => <i key={i} style={{ height: `${16 + ((i * 17 + 11) % 45)}px` }} />)}</div><Volume2 size={24} /></div>}
                  {index === 3 && <div className="caption-art"><span>Tiếng Việt <span>↔</span> English</span><strong>{c.sample}</strong><small>00:04,200 → 00:07,800</small></div>}
                </div>
                <div className="studio-feature-copy"><Icon size={22} aria-hidden="true" /><h3>{card.title}</h3><p>{card.copy}</p><ul>{card.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul></div>
              </article>
            );
          })}
        </div>
      </section>
      <section className="export-story" data-reveal>
        <div><span className="kicker">{c.exportKicker}</span><h2>{c.exportTitle}</h2><p>{c.exportCopy}</p><span className="export-aspects">{c.formats}</span><span className="export-local"><ShieldCheck size={17} aria-hidden="true" />{c.local}</span></div>
        <div className="export-receipt" role="img" aria-label={c.example}>
          <span className="export-receipt-icon"><Upload size={24} aria-hidden="true" /></span>
          <strong>MP4</strong><span className="export-receipt-sub">ScreenSway</span>
          <dl><div><dt>{c.resolution}</dt><dd>1080p / 1440p / 4K</dd></div><div><dt>{c.frameRate}</dt><dd>60 fps</dd></div><div><dt>{c.format}</dt><dd>H.264 · MP4</dd></div></dl>
          <span className="export-included">{c.included}</span>
          {c.includes.map((item) => <span className="export-check" key={item}><Check size={15} aria-hidden="true" />{item}</span>)}
        </div>
      </section>
    </>
  );
}
