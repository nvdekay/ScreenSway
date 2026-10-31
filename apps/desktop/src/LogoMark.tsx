/**
 * ScreenSway mark at UI sizes: the framed "S" with its recording light, in the flat blue
 * shared by the app icon, the landing page and the browser app. The viewfinder corners
 * of the full app icon are omitted because they vanish below ~48px.
 */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="100 100 824 824" aria-hidden="true" focusable="false">
      <rect x="100" y="100" width="824" height="824" rx="200" fill="#0071E3" />
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
