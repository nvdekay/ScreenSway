import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The guide window over a display (index.html#guide): the area that will be recorded,
 * outlined, with the rest of the screen dimmed. It ignores the pointer, and the outline is
 * drawn just outside the area so a region recording never contains it.
 */
export function CaptureGuide() {
  const [region, setRegion] = useState<Region | null>(null);

  useEffect(() => {
    void invoke<Region | null>("capture_guide_region").then((current) => current && setRegion(current)).catch(() => {});
    const stop = listen<Region>("capture-guide", (event) => setRegion(event.payload));
    return () => void stop.then((unlisten) => unlisten());
  }, []);

  if (!region) return null;
  return (
    <div className="capture-guide" aria-hidden="true">
      <span
        style={{
          left: `${region.x * 100}%`,
          top: `${region.y * 100}%`,
          width: `${region.width * 100}%`,
          height: `${region.height * 100}%`,
        }}
      />
    </div>
  );
}
