import {
  DEFAULT_FRAME_SETTINGS,
  buildCameraTrack,
  generateZoomSegments,
  sampleCameraTrack,
  samplePointer,
  type FrameSettings,
  type PointerEvent,
} from "@screensway/core";
import { ArrowRight, Check, Globe, Lock, MousePointer2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { RecordingFrame } from "./RecordingFrame";
import { useI18n } from "./i18n";

/** The sample screen's space, matching RecordingFrame's source size. */
const SCREEN = { width: 1200, height: 750 };
const LOOP_MS = 10_000;
/** The pointer moves and pauses: [time, x, y]. Each pause becomes a zoom, as in the browser app. */
const PATH: [number, number, number][] = [
  [0, 600, 380],
  [700, 600, 380],
  [1_500, 300, 230],
  [3_300, 300, 230],
  [4_100, 860, 560],
  [6_000, 860, 560],
  [6_800, 1_010, 210],
  [8_400, 1_010, 210],
  [9_300, 600, 380],
  [LOOP_MS, 600, 380],
];
/** How long the pointer rests before the browser app treats it as a focus (see apps/studio-web). */
const SETTLE_MS = 800;
const STILL_MS = 5_200;

const SETTINGS: FrameSettings = {
  ...DEFAULT_FRAME_SETTINGS,
  frame: "browser-dark",
  padding: 0.07,
  background: { kind: "linear", angle: 135, stops: [{ offset: 0, color: "#171024" }, { offset: 1, color: "#7c3aed" }] },
};

function buildScript(): PointerEvent[] {
  const events: PointerEvent[] = [];
  for (let index = 0; index < PATH.length - 1; index++) {
    const [startMs, startX, startY] = PATH[index];
    const [endMs, endX, endY] = PATH[index + 1];
    for (let timeMs = startMs; timeMs < endMs; timeMs += 16) {
      const k = (timeMs - startMs) / (endMs - startMs);
      const eased = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
      events.push({ timeMs, type: "move", x: startX + (endX - startX) * eased, y: startY + (endY - startY) * eased });
    }
    // A long pause after a move is a focus, dated from when the pointer stopped.
    const [nextMs] = PATH[index + 1];
    const resting = startX === endX && startY === endY;
    if (resting && nextMs - startMs >= SETTLE_MS && index > 0) events.push({ timeMs: startMs, type: "focus", x: startX, y: startY });
  }
  return events.sort((a, b) => a.timeMs - b.timeMs);
}

/** The browser version, shown working: zooms that start where the pointer settles. */
export function WebBrowserSection() {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<SVGSVGElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);
  const events = useMemo(buildScript, []);
  const segments = useMemo(() => generateZoomSegments(events), [events]);
  const track = useMemo(() => buildCameraTrack(events, segments, SCREEN, LOOP_MS + 1_000), [events, segments]);

  useEffect(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let visible = true;
    let frame = 0;
    let time = still ? STILL_MS : 0;
    let last = performance.now();
    // Stop all work while the section is scrolled out of view.
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    }, { threshold: 0.05 });
    if (stageRef.current) observer.observe(stageRef.current);
    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      if (!still && visible) time = (time + now - last) % LOOP_MS;
      last = now;
      const camera = sampleCameraTrack(track, time);
      const pointer = samplePointer(events, time);
      if (cameraRef.current) {
        cameraRef.current.style.transform = `translate3d(${(0.5 - camera.x * camera.scale) * 100}%, ${(0.5 - camera.y * camera.scale) * 100}%, 0) scale(${camera.scale})`;
      }
      if (pointerRef.current && pointer) {
        pointerRef.current.style.left = `${(pointer.x / SCREEN.width) * 100}%`;
        pointerRef.current.style.top = `${(pointer.y / SCREEN.height) * 100}%`;
      }
      if (progressRef.current) progressRef.current.style.left = `${(time / LOOP_MS) * 100}%`;
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [events, track]);

  return (
    <section className="browser-feature" id="web-app" aria-labelledby="browser-feature-title">
      <div className="browser-feature-copy" data-reveal>
        <span className="kicker">{t("webFeature.kicker")}</span>
        <h2 id="browser-feature-title">{t("webFeature.title")}</h2>
        <p>{t("webFeature.copy")}</p>
        <ul>
          {(["webFeature.point1", "webFeature.point2", "webFeature.point3"] as const).map((key) => (
            <li key={key}><Check size={15} aria-hidden="true" />{t(key)}</li>
          ))}
        </ul>
        <small>{t("webFeature.limits")}</small>
        <a href="./app/">{t("webFeature.cta")}<ArrowRight size={16} aria-hidden="true" /></a>
      </div>

      <div className="browser-feature-visual" data-reveal ref={stageRef} role="img" aria-label={t("webFeature.visual")}>
        <div className="browser-feature-bar" aria-hidden="true">
          <span><i /><i /><i /></span>
          <b><Globe size={13} />nvdekay.github.io/ScreenSway/app</b>
          <em><Lock size={12} />{t("webFeature.local")}</em>
        </div>
        <RecordingFrame settings={SETTINGS}>
          <div className="browser-feature-camera" ref={cameraRef} aria-hidden="true">
            <div className="browser-feature-screen">
              <div className="browser-feature-side"><span /><i /><i /><i /></div>
              <div className="browser-feature-main">
                <div className="browser-feature-cards"><i /><i className="accent" /><i /></div>
                <div className="browser-feature-chart"><i /><i /><i /><i className="peak" /><i /></div>
              </div>
            </div>
            <MousePointer2 className="browser-feature-pointer" ref={pointerRef} size={26} fill="#111" />
          </div>
        </RecordingFrame>
        <div className="browser-feature-timeline" aria-hidden="true">
          <span>{t("webFeature.timeline")}</span>
          <div>
            {segments.map((segment) => (
              <i key={segment.id} style={{ left: `${(segment.startMs / LOOP_MS) * 100}%`, width: `${(Math.min(LOOP_MS, segment.endMs) - segment.startMs) / LOOP_MS * 100}%` }} />
            ))}
            <b ref={progressRef} />
          </div>
        </div>
      </div>
    </section>
  );
}
