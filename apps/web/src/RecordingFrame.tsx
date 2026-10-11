import { computeLayout, paintFrameBase, type FrameSettings } from "@screensway/core";
import { useEffect, useMemo, useRef, type ReactNode } from "react";

const SOURCE = { width: 1200, height: 750 };

/** The same layout and canvas painter used by the desktop preview and MP4 export. */
export function RecordingFrame({ settings, children, thumbnail = false }: {
  settings: FrameSettings;
  children?: ReactNode;
  thumbnail?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layout = useMemo(() => computeLayout(
    thumbnail ? { ...settings, aspect: "auto" } : settings,
    SOURCE,
    thumbnail ? 110 : 750,
  ), [settings, thumbnail]);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    paintFrameBase(context, layout, settings, null);
    if (thumbnail) {
      const { video: v, videoRadius, roundVideoTop } = layout;
      context.save();
      context.beginPath();
      context.roundRect(v.x, v.y, v.width, v.height, roundVideoTop ? videoRadius : [0, 0, videoRadius, videoRadius]);
      context.clip();
      context.fillStyle = "#f4f4f7";
      context.fillRect(v.x, v.y, v.width, v.height);
      context.fillStyle = "#d9d9e3";
      context.fillRect(v.x, v.y, v.width * 0.22, v.height);
      context.fillStyle = "#c7c8f5";
      context.fillRect(v.x + v.width * 0.3, v.y + v.height * 0.2, v.width * 0.5, v.height * 0.12);
      context.fillStyle = "#e4e4ec";
      context.fillRect(v.x + v.width * 0.3, v.y + v.height * 0.42, v.width * 0.6, v.height * 0.38);
      context.restore();
    }
  }, [layout, settings, thumbnail]);

  const rx = `${layout.videoRadius / layout.video.width * 100}%`;
  const ry = `${layout.videoRadius / layout.video.height * 100}%`;
  return (
    <div className={`recording-frame${thumbnail ? " recording-thumbnail" : ""}`} style={{ aspectRatio: `${layout.width} / ${layout.height}` }} data-frame={settings.frame} data-aspect={settings.aspect}>
      <canvas ref={canvasRef} width={layout.width} height={layout.height} aria-hidden="true" />
      {!thumbnail && <div className="recording-viewport" style={{
        left: `${layout.video.x / layout.width * 100}%`, top: `${layout.video.y / layout.height * 100}%`,
        width: `${layout.video.width / layout.width * 100}%`, height: `${layout.video.height / layout.height * 100}%`,
        borderRadius: layout.roundVideoTop ? `${rx} / ${ry}` : `0 0 ${rx} ${rx} / 0 0 ${ry} ${ry}`,
      }}>{children}</div>}
    </div>
  );
}
