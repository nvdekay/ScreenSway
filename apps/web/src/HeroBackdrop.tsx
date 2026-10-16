import { useEffect, useRef } from "react";

/** Cross-fade to the second copy this long before the loop point; the clip's ends do not match. */
const GLOBE_FADE = 0.9;

/**
 * The violet globe behind the whole page, fixed while scrolling. A veil in the page colour
 * thickens once the first screen scrolls away (--dim), so content stays readable. Also used
 * by the browser app (apps/studio-web), which is served in this site's app/ folder.
 */
export function HeroBackdrop({ src, poster }: { src: string; poster: string }) {
  const first = useRef<HTMLVideoElement>(null);
  const second = useRef<HTMLVideoElement>(null);
  const veil = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onScroll = () => {
      const height = window.innerHeight;
      const dim = Math.min(1, Math.max(0, (window.scrollY - height * 0.4) / (height * 0.5)));
      veil.current?.style.setProperty("--dim", dim.toFixed(3));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);
  useEffect(() => {
    const a = first.current;
    const b = second.current;
    if (!a || !b) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      a.pause();
      b.pause();
      return;
    }
    const play = (video: HTMLVideoElement) => { video.play().catch(() => {}); };
    let current = a;
    let next = b;
    let swapping = false;
    let timer = 0;
    const tick = () => {
      if (swapping || !current.duration || current.duration - current.currentTime > GLOBE_FADE) return;
      swapping = true;
      const out = current;
      next.currentTime = 0;
      play(next);
      next.classList.add("is-active");
      out.classList.remove("is-active");
      current = next;
      next = out;
      timer = window.setTimeout(() => {
        out.pause();
        out.currentTime = 0;
        swapping = false;
      }, GLOBE_FADE * 1000 + 100);
    };
    a.addEventListener("timeupdate", tick);
    b.addEventListener("timeupdate", tick);
    play(a);
    return () => {
      clearTimeout(timer);
      a.removeEventListener("timeupdate", tick);
      b.removeEventListener("timeupdate", tick);
    };
  }, []);
  return (
    <div className="page-bg" ref={veil} aria-hidden="true">
      <video ref={first} className="hero-video is-active" src={src} poster={poster} muted loop playsInline preload="auto" disablePictureInPicture />
      <video ref={second} className="hero-video" src={src} muted loop playsInline preload="auto" disablePictureInPicture />
    </div>
  );
}
