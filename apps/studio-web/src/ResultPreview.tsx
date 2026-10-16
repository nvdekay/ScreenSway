import {
  DEFAULT_FRAME_SETTINGS,
  buildCameraTrack,
  computeLayout,
  generateZoomSegments,
  paintFrameBase,
  sampleCameraTrack,
  samplePointer,
} from "@screensway/core";
import { BarChart3, LayoutDashboard, MousePointer2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useI18n } from "../../desktop/src/i18n";
import { pointerEvents, type PointerSample } from "./pointer/focus";

/** The sample screen is laid out in this space, like a recording of that size. */
const SOURCE = { width: 1200, height: 750 };
const LOOP_MS = 11_000;
/** A pointer path with pauses: [time, x, y]. It rests at the button, the peak and the stats. */
const PATH: [number, number, number][] = [
  [0, 600, 420],
  [800, 600, 420],
  [1_700, 1_030, 140],
  [3_400, 1_030, 140],
  [4_300, 760, 560],
  [6_100, 760, 560],
  [7_000, 470, 300],
  [8_800, 470, 300],
  [9_800, 600, 420],
  [LOOP_MS, 600, 420],
];
/** Shown when motion is reduced: the camera zoomed on the chart's peak. */
const STILL_MS = 5_600;

function samplePath(): PointerSample[] {
  const samples: PointerSample[] = [];
  for (let index = 0; index < PATH.length - 1; index++) {
    const [startMs, startX, startY] = PATH[index];
    const [endMs, endX, endY] = PATH[index + 1];
    for (let timeMs = startMs; timeMs < endMs; timeMs += 33) {
      const k = (timeMs - startMs) / (endMs - startMs);
      const eased = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
      samples.push({ timeMs, x: startX + (endX - startX) * eased, y: startY + (endY - startY) * eased });
    }
  }
  return samples;
}

/**
 * A short sample of what a browser recording becomes: the real frame painter, and zooms
 * that the same rules as a recording produce, starting where the pointer settles and
 * following it on the same camera springs.
 */
export function ResultPreview() {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<SVGSVGElement>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);

  const settings = useMemo(() => ({
    ...DEFAULT_FRAME_SETTINGS,
    frame: "browser-dark" as const,
    // A single flat colour, like the rest of the page.
    background: { kind: "solid" as const, color: "#5b3fc4" },
    // Fractions of the canvas, as in the built-in styles.
    padding: 0.07,
    radius: 0.016,
  }), []);
  const layout = useMemo(() => computeLayout(settings, SOURCE, 720), [settings]);
  const { events, segments, track } = useMemo(() => {
    const events = pointerEvents(samplePath(), SOURCE.width);
    const segments = generateZoomSegments(events);
    return { events, segments, track: buildCameraTrack(events, segments, SOURCE, LOOP_MS + 1_000) };
  }, []);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (context) paintFrameBase(context, layout, settings, null);
  }, [layout, settings]);

  // Camera, pointer and progress are written to the DOM every display frame, like the studio preview.
  useEffect(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const started = performance.now();
    let frame = 0;
    const render = (now: number) => {
      const timeMs = still ? STILL_MS : (now - started) % LOOP_MS;
      const camera = sampleCameraTrack(track, timeMs);
      const pointer = samplePointer(events, timeMs);
      if (cameraRef.current) {
        const x = (0.5 - camera.x * camera.scale) * 100;
        const y = (0.5 - camera.y * camera.scale) * 100;
        cameraRef.current.style.transform = `translate3d(${x}%, ${y}%, 0) scale(${camera.scale})`;
      }
      if (pointerRef.current && pointer) {
        pointerRef.current.style.left = `${(pointer.x / SOURCE.width) * 100}%`;
        pointerRef.current.style.top = `${(pointer.y / SOURCE.height) * 100}%`;
      }
      if (badgeRef.current) badgeRef.current.style.opacity = camera.scale > 1.2 ? "1" : "0";
      if (progressRef.current) progressRef.current.style.transform = `scaleX(${timeMs / LOOP_MS})`;
      if (!still) frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [events, track]);

  const percent = (value: number, total: number) => `${(value / total) * 100}%`;
  return (
    <div className="result-visual" role="img" aria-label={t("web.visualLabel")}>
      <div className="result-frame" style={{ aspectRatio: `${layout.width} / ${layout.height}` }}>
        <canvas ref={canvasRef} width={layout.width} height={layout.height} aria-hidden="true" />
        <div
          className="result-screen"
          aria-hidden="true"
          style={{
            left: percent(layout.video.x, layout.width),
            top: percent(layout.video.y, layout.height),
            width: percent(layout.video.width, layout.width),
            height: percent(layout.video.height, layout.height),
          }}
        >
          <div className="result-camera" ref={cameraRef}>
            <aside>
              <strong><span />ScreenSway</strong>
              <i className="active"><LayoutDashboard size={13} />{t("web.visualOverview")}</i>
              <i><BarChart3 size={13} />{t("web.visualReports")}</i>
            </aside>
            <div className="result-content">
              <header>
                <div>
                  <small>{t("web.visualWorkspace")}</small>
                  <b>{t("web.visualGreeting")}</b>
                </div>
                <span>{t("web.visualAction")}</span>
              </header>
              <div className="result-stats">
                <i><small>Views</small><b>8,931</b></i>
                <i><small>Focus</small><b>94%</b></i>
                <i><small>Shared</small><b>126</b></i>
              </div>
              <div className="result-chart">
                <span /><span /><span /><span className="peak" /><span /><span />
              </div>
            </div>
            <MousePointer2 className="result-pointer" ref={pointerRef} size={22} fill="#111" />
          </div>
        </div>
      </div>
      <span className="result-zoom" ref={badgeRef}><Sparkles size={13} />{t("web.visualZoom")}</span>
      <div className="result-timeline" aria-hidden="true">
        {segments.map((segment) => (
          <i key={segment.id} style={{ left: percent(segment.startMs, LOOP_MS), width: percent(segment.endMs - segment.startMs, LOOP_MS) }} />
        ))}
        <span ref={progressRef} />
      </div>
    </div>
  );
}
