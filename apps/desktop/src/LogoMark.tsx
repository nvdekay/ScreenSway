import { useId } from "react";

/**
 * ScreenSway mark at UI sizes: the framed "S" with its recording light. The
 * viewfinder corners of the full app icon are omitted because they vanish
 * below ~48px. The landing page and the browser app use the flat blue tone.
 */
export function LogoMark({ size = 32, tone = "app" }: { size?: number; tone?: "app" | "flat" }) {
  const id = useId().replace(/:/g, "");
  const flat = tone === "flat";
  return (
    <svg width={size} height={size} viewBox="100 100 824 824" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-base`} x1="200" y1="100" x2="824" y2="924" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5B5BF0" />
          <stop offset="0.55" stopColor="#4338CA" />
          <stop offset="1" stopColor="#1E1B4B" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(760 820) scale(420)">
          <stop stopColor="#EC4899" stopOpacity="0.55" />
          <stop offset="1" stopColor="#EC4899" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="200" fill={flat ? "#0071E3" : `url(#${id}-base)`} />
      {!flat && <rect x="100" y="100" width="824" height="824" rx="200" fill={`url(#${id}-glow)`} />}
      <g transform="translate(512 512) scale(1.32) translate(-512 -508)">
        <path
          d="M600 372H442C404.445 372 374 402.445 374 440C374 477.555 404.445 508 442 508H582C619.555 508 650 538.445 650 576C650 613.555 619.555 644 582 644H424"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="80"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="674" cy="372" r="44" fill="#FF5A6E" />
      </g>
    </svg>
  );
}
