import { forwardRef } from "react";

/**
 * A macOS-style pointing hand for illustrations (the landing page demo, its browser section and
 * the browser app's sample): white with a dark outline. The click point is the index fingertip,
 * so callers translate it by (-34%, -11%) to put the tip on the pointer position.
 */
export const HandPointer = forwardRef<SVGSVGElement, { size?: number; className?: string }>(function HandPointer({ size = 26, className }, ref) {
  return (
    <svg ref={ref} className={className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path
        d="M8.5 6a2.5 2.5 0 0 1 5 0v6.6a2.5 2.5 0 0 1 5 0V14a2.25 2.25 0 0 1 4.5 0v1.4a2.25 2.25 0 0 1 4.5 0V22c0 4.4-3.6 8-8 8h-3.9c-2.4 0-4.6-1.1-6.1-3L4.6 20.6a2.2 2.2 0 0 1 3.3-2.9l.6.9Z"
        fill="#fff"
        stroke="#111"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M13.5 13v5M18.5 14v4.5M23 15.4v3.6" fill="none" stroke="#111" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
});
