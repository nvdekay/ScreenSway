import { useEffect, useRef } from "react";

/** Cross-fade to the second copy this long before the loop point; the clip's ends do not match. */
const GLOBE_FADE = 0.9;

/**
 * The globe (violet footage, shifted to blue in CSS) behind the whole page, fixed while scrolling. A veil in the page colour
 * thickens once the first screen scrolls away (--dim), so content stays readable. It is the
 * landing page's alone: the browser app keeps a still, plain background.
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
    // Under reduced motion the clip would only stand still: keep the poster and skip the download.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const play = (video: HTMLVideoElement) => { video.play().catch(() => {}); };
    // Two <video> elements with the same URL each download the whole clip (6.7 MB instead of
    // 3.3 MB a visit). Fetch it once and give both the same blob; the poster shows meanwhile.
    let disposed = false;
    let objectUrl = "";
    const controller = new AbortController();
    fetch(src, { signal: controller.signal })
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
      .then((blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        a.src = objectUrl;
        b.src = objectUrl;
        play(a);
      })
      .catch(() => {
        // Without the blob, play the one copy straight from the site, looping without the cross-fade.
        if (disposed || controller.signal.aborted) return;
        a.src = src;
        play(a);
      });
    let current = a;
    let next = b;
    let swapping = false;
    let timer = 0;
    const tick = () => {
      if (swapping || !next.src || !current.duration || current.duration - current.currentTime > GLOBE_FADE) return;
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
    return () => {
      disposed = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      clearTimeout(timer);
      a.removeEventListener("timeupdate", tick);
      b.removeEventListener("timeupdate", tick);
    };
  }, [src]);
  return (
    <div className="page-bg" ref={veil} aria-hidden="true">
      <video ref={first} className="hero-video is-active" poster={poster} muted loop playsInline preload="auto" disablePictureInPicture />
      <video ref={second} className="hero-video" muted loop playsInline preload="auto" disablePictureInPicture />
    </div>
  );
}
