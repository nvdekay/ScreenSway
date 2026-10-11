import { Captions, Palette, ShieldCheck, Upload, ZoomIn } from "lucide-react";
import { useI18n } from "./i18n";

const CONTENT = {
  en: {
    kicker: "Record. Refine. Share.",
    title: "Everything a great walkthrough needs.",
    cards: [
      { title: "Keep eyes on the action", copy: "Auto zoom follows your clicks with a smooth cursor. Trim the recording and fine-tune zooms on the timeline." },
      { title: "Make every video look yours", copy: "Choose from five styles, customize frames and backgrounds, and save your favorite looks for next time." },
      { title: "Make your explanation clear", copy: "Record system audio and your mic, level your voice, and add editable Vietnamese or English captions offline." },
      { title: "Ready to share in 4K", copy: "Export MP4 at up to 4K and 60 fps with your edits, audio and captions. Keep a separate SRT file, too." },
    ],
    trust: "Everything stays on your computer. No account, no cloud processing, no watermark.",
  },
  vi: {
    kicker: "Quay. Chỉnh. Chia sẻ.",
    title: "Đủ để mỗi bản quay đều chỉn chu.",
    cards: [
      { title: "Dẫn mắt theo từng thao tác", copy: "Tự zoom theo cú click, con trỏ chuyển động mượt. Cắt bản quay và chỉnh từng đoạn zoom ngay trên timeline." },
      { title: "Mang diện mạo của riêng bạn", copy: "Chọn một trong năm phong cách, tùy chỉnh khung và nền, lưu diện mạo yêu thích cho lần quay sau." },
      { title: "Lời dẫn rõ, phụ đề đủ", copy: "Thu âm hệ thống và micro, cân âm giọng nói, thêm phụ đề Việt hoặc Anh có thể chỉnh sửa ngay trên máy." },
      { title: "Sẵn sàng chia sẻ ở chất lượng 4K", copy: "Xuất MP4 đến 4K, 60 fps với đầy đủ chỉnh sửa, âm thanh và phụ đề. Có thêm file SRT để dùng riêng." },
    ],
    trust: "Mọi thứ ở lại trên máy. Không tài khoản, không xử lý trên cloud, không watermark.",
  },
};

const ICONS = [ZoomIn, Palette, Captions, Upload];
const IDS = ["zoom", "styles", "voice", "export"];

export function Benefits() {
  const { language } = useI18n();
  const c = CONTENT[language];
  return (
    <section className="benefits" id="features" aria-labelledby="benefits-title">
      <div className="benefits-heading" data-reveal>
        <span className="kicker">{c.kicker}</span>
        <h2 id="benefits-title">{c.title}</h2>
      </div>
      <div className="benefits-grid">
        {c.cards.map((card, index) => {
          const Icon = ICONS[index];
          return (
            <article className="benefit-card" key={IDS[index]} data-reveal>
              <span className="benefit-icon"><Icon size={22} aria-hidden="true" /></span>
              <h3>{card.title}</h3>
              <p>{card.copy}</p>
            </article>
          );
        })}
      </div>
      <p className="benefits-trust" data-reveal><ShieldCheck size={20} aria-hidden="true" />{c.trust}</p>
    </section>
  );
}
