import {
  buildCameraTrack,
  generateZoomSegments,
  sampleCameraTrack,
  samplePointer,
  type PointerEvent,
} from "@screensway/core";
import { BarChart3, FileText, LayoutGrid, Pause, Play, Plus, Settings, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n, type MessageKey } from "./i18n";

/** The mock app is laid out in this logical coordinate space and scaled to fit. */
const SCREEN = { width: 1200, height: 750 };
const LOOP_MS = 12_000;
const RIPPLE_MS = 550;
const REDUCED_MOTION_FRAME_MS = 5_950;

/** Scripted cursor path: [time, x, y, click]. */
const WAYPOINTS: [number, number, number, boolean][] = [
  [0, 640, 420, false],
  [600, 640, 420, false],
  [1_600, 118, 182, true],
  [2_400, 140, 196, false],
  [3_600, 1_080, 94, true],
  [4_400, 1_058, 112, false],
  [5_600, 712, 470, true],
  [6_600, 834, 516, true],
  [7_400, 858, 540, false],
  [9_800, 640, 420, false],
  [LOOP_MS, 640, 420, false],
];
const CLICK_DELAY_MS = 150;

function easeInOut(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

function buildScript(): PointerEvent[] {
  const events: PointerEvent[] = [];
  for (let index = 0; index < WAYPOINTS.length - 1; index++) {
    const [startMs, startX, startY] = WAYPOINTS[index];
    const [endMs, endX, endY] = WAYPOINTS[index + 1];
    for (let time = startMs; time < endMs; time += 16) {
      const progress = easeInOut((time - startMs) / (endMs - startMs));
      events.push({ timeMs: time, type: "move", x: startX + (endX - startX) * progress, y: startY + (endY - startY) * progress });
    }
  }
  for (const [time, x, y, click] of WAYPOINTS) {
    if (click) events.push({ timeMs: time + CLICK_DELAY_MS, type: "leftClick", x, y });
  }
  return events.sort((a, b) => a.timeMs - b.timeMs);
}

const CAPTIONS: [number, MessageKey][] = [
  [0, "demo.caption0"],
  [1_400, "demo.caption1"],
  [3_600, "demo.caption2"],
  [9_200, "demo.caption3"],
];

/** Sample narration follows the same clock as the camera and pauses with playback. */
const SAMPLE_CAPTIONS: [number, MessageKey][] = [
  [0, "demo.sub0"],
  [2_000, "demo.sub1"],
  [4_000, "demo.sub2"],
  [6_000, "demo.sub3"],
  [8_000, "demo.sub4"],
  [10_000, "demo.sub5"],
];

const BARS = [42, 58, 49, 88, 71, 63, 54];

function MockApp() {
  const { t } = useI18n();
  return (
    <div className="mock-app" aria-hidden="true">
      <div className="mock-chrome">
        <span className="mock-lights"><i /><i /><i /></span>
        <span>{t("mock.title")}</span>
      </div>
      <aside className="mock-sidebar">
        <div className="mock-logo"><span /> Acme</div>
        <div className="mock-nav overview"><LayoutGrid size={18} /> {t("mock.overview")}</div>
        <div className="mock-nav reports"><FileText size={18} /> {t("mock.reports")}</div>
        <div className="mock-nav"><Users size={18} /> {t("mock.team")}</div>
        <div className="mock-nav"><Settings size={18} /> {t("mock.settings")}</div>
      </aside>
      <div className="mock-main">
        <header className="mock-header">
          <h4>
            <span className="title-overview">{t("mock.overview")}</span>
            <span className="title-reports">{t("mock.reports")}</span>
          </h4>
          <span className="mock-button"><Plus size={16} /> {t("mock.newReport")}</span>
        </header>
        <div className="mock-toast"><span /> {t("mock.created")}</div>
        <div className="mock-stats">
          <div><small>{t("mock.revenue")}</small><strong>$48.2k</strong><em>+12.4%</em></div>
          <div><small>{t("mock.users")}</small><strong>8,931</strong><em>+5.1%</em></div>
          <div><small>{t("mock.growth")}</small><strong>23.8%</strong><em>+2.3%</em></div>
        </div>
        <div className="mock-chart">
          <div className="mock-chart-head"><BarChart3 size={18} /> {t("mock.weekly")}</div>
          <div className="mock-bars">
            {BARS.map((height, index) => (
              <span key={index} className={`bar bar-${index}`} style={{ height: `${height}%` }}>
                {index === 3 && <em className="mock-tooltip">{t("mock.peak")}</em>}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Demo({ showCaptions = false }: { showCaptions?: boolean }) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const rippleRef = useRef<HTMLSpanElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef(0);
  const [enabled, setEnabled] = useState(true);
  const [playing, setPlaying] = useState(
    () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [visible, setVisible] = useState(true);
  const [caption, setCaption] = useState<MessageKey>("demo.caption0");
  const [sampleCaption, setSampleCaption] = useState<MessageKey>("demo.sub0");

  const events = useMemo(buildScript, []);
  const clicks = useMemo(() => events.filter((event) => event.type !== "move"), [events]);
  const segments = useMemo(() => generateZoomSegments(events), [events]);
  const track = useMemo(() => buildCameraTrack(events, segments, SCREEN, LOOP_MS), [events, segments]);

  useEffect(() => {
    if (!playing) timeRef.current = timeRef.current || REDUCED_MOTION_FRAME_MS;
  }, [playing]);

  // Scale the fixed-size mock app to the stage width.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => {
      stage.style.setProperty("--screen-scale", String(entry.contentRect.width / SCREEN.width));
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // Stop all work while the demo is scrolled out of view.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.05 });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    let lastStep = -1;
    let lastCaption: MessageKey | null = null;
    let lastSampleCaption: MessageKey | null = null;

    const render = (now: number) => {
      if (playing && visible) timeRef.current = (timeRef.current + (now - last)) % LOOP_MS;
      last = now;
      const time = timeRef.current;

      const camera = enabled ? sampleCameraTrack(track, time) : { x: 0.5, y: 0.5, scale: 1 };
      if (cameraRef.current) {
        cameraRef.current.style.transform =
          `translate3d(${(0.5 - camera.x * camera.scale) * 100}%, ${(0.5 - camera.y * camera.scale) * 100}%, 0) scale(${camera.scale})`;
      }

      const pointer = samplePointer(events, time);
      if (pointer && cursorRef.current) {
        cursorRef.current.style.transform = `translate3d(${pointer.x}px, ${pointer.y}px, 0)`;
      }

      let step = 0;
      let lastClick: PointerEvent | undefined;
      for (const click of clicks) {
        if (click.timeMs > time) break;
        step++;
        lastClick = click;
      }
      if (step !== lastStep && screenRef.current) {
        screenRef.current.dataset.step = String(step);
        lastStep = step;
      }

      const ripple = rippleRef.current;
      const age = lastClick ? time - lastClick.timeMs : Infinity;
      if (ripple && lastClick && age < RIPPLE_MS) {
        const progress = age / RIPPLE_MS;
        ripple.style.opacity = String(1 - progress);
        ripple.style.transform = `translate3d(${lastClick.x}px, ${lastClick.y}px, 0) translate(-50%, -50%) scale(${0.4 + progress})`;
      } else if (ripple) {
        ripple.style.opacity = "0";
      }

      if (progressRef.current) progressRef.current.style.transform = `scaleX(${time / LOOP_MS})`;
      if (badgeRef.current) {
        const zoomed = camera.scale > 1.05;
        badgeRef.current.dataset.visible = String(zoomed);
        if (zoomed) badgeRef.current.textContent = t("demo.zoom", { scale: camera.scale.toFixed(1) });
      }

      const nextCaption = CAPTIONS.filter(([start]) => time >= start).at(-1)?.[1] ?? "demo.caption0";
      if (nextCaption !== lastCaption) {
        lastCaption = nextCaption;
        setCaption(nextCaption);
      }

      const nextSample = SAMPLE_CAPTIONS.filter(([start]) => time >= start).at(-1)?.[1] ?? "demo.sub0";
      if (nextSample !== lastSampleCaption) {
        lastSampleCaption = nextSample;
        setSampleCaption(nextSample);
      }

      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [clicks, enabled, events, playing, t, track, visible]);

  return (
    <div className="demo">
      <div className="demo-toolbar">
        <div className="demo-toggle" role="radiogroup" aria-label={t("demo.label")}>
          <button role="radio" aria-checked={enabled} className={enabled ? "selected" : ""} onClick={() => setEnabled(true)}>
            {t("demo.with")}
          </button>
          <button role="radio" aria-checked={!enabled} className={!enabled ? "selected" : ""} onClick={() => setEnabled(false)}>
            {t("demo.without")}
          </button>
        </div>
        <button
          className="demo-play"
          onClick={() => setPlaying((value) => !value)}
          aria-label={playing ? t("demo.pause") : t("demo.play")}
        >
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </button>
      </div>

      <div className="demo-frame">
        <div className="demo-stage" ref={stageRef} role="img" aria-label={t("demo.label")}>
          <div className="demo-camera" ref={cameraRef}>
            <div className="demo-screen" ref={screenRef} data-step="0">
              <MockApp />
              <span className="demo-ripple" ref={rippleRef} />
              <div className="demo-cursor" ref={cursorRef}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M4.5 2.8v16.6c0 .6.7.9 1.1.4l3.9-4.2 2.6 6.1c.2.4.6.6 1 .4l2.2-.9c.4-.2.6-.6.4-1l-2.6-6h5.7c.6 0 .9-.7.5-1.1L5.6 2.4c-.4-.4-1.1-.1-1.1.4z"
                    fill="#111"
                    stroke="#fff"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            </div>
          </div>
          <span className="demo-badge" ref={badgeRef} data-visible="false" aria-hidden="true" />
          {showCaptions && <p className="sample-caption">{t(sampleCaption)}</p>}
        </div>
        <div className="demo-footer">
          <p className="demo-caption" key={caption}>{t(caption)}</p>
          <div className="demo-timeline" aria-hidden="true">
            {segments.map((segment) => (
              <i
                key={segment.id}
                style={{
                  left: `${(segment.startMs / LOOP_MS) * 100}%`,
                  width: `${((Math.min(segment.endMs, LOOP_MS) - segment.startMs) / LOOP_MS) * 100}%`,
                }}
              />
            ))}
            <span ref={progressRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
