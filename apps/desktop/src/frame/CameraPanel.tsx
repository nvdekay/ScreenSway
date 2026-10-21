import type { CameraOverlay } from "@screensway/core";
import { Video } from "lucide-react";
import { useI18n, type MessageKey } from "../i18n";
import { Slider } from "./FrameEditor";

/** Corners the camera snaps to, as the centre of a default-sized camera. */
const CORNERS = [
  { id: "topLeft", x: 0.14, y: 0.2 },
  { id: "topRight", x: 0.86, y: 0.2 },
  { id: "bottomLeft", x: 0.14, y: 0.8 },
  { id: "bottomRight", x: 0.86, y: 0.8 },
] as const;

export function CameraPanel({ value, onChange }: { value: CameraOverlay; onChange: (value: CameraOverlay) => void }) {
  const { t } = useI18n();
  return (
    <section className="editor-section camera-panel">
      <h3><Video size={15} aria-hidden="true" /> {t("camera.title")}</h3>
      <label className="audio-toggle compact">
        <span>{t("camera.show")}</span>
        <input type="checkbox" role="switch" checked={value.visible} onChange={(event) => onChange({ ...value, visible: event.target.checked })} />
        <span className="switch" aria-hidden="true" />
      </label>
      {value.visible && (
        <>
          <p className="editor-note">{t("camera.note")}</p>
          <div className="chip-row">
            {(["circle", "rounded"] as const).map((shape) => (
              <button key={shape} className={`chip${value.shape === shape ? " selected" : ""}`} onClick={() => onChange({ ...value, shape })}>
                {t(shape === "circle" ? "camera.circle" : "camera.rounded")}
              </button>
            ))}
          </div>
          <div className="chip-row">
            {CORNERS.map((corner) => (
              <button key={corner.id} className="chip" onClick={() => onChange({ ...value, x: corner.x, y: corner.y })}>
                {t(`camera.${corner.id}` as MessageKey)}
              </button>
            ))}
          </div>
          <Slider label={t("camera.size")} value={value.size} min={0.12} max={0.5} step={0.01} format={(size) => `${Math.round(size * 100)}%`} onChange={(size) => onChange({ ...value, size })} />
          <label className="audio-toggle compact">
            <span>{t("camera.mirror")}</span>
            <input type="checkbox" role="switch" checked={value.mirror} onChange={(event) => onChange({ ...value, mirror: event.target.checked })} />
            <span className="switch" aria-hidden="true" />
          </label>
        </>
      )}
    </section>
  );
}
