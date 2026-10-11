# Landing page

The marketing site lives in `apps/web` and deploys through the existing GitHub Pages workflow. Keep download links relative: the workflow copies the latest DMG into `dist/download` because the source repository is private. Windows capture remains coming soon.

## Product story

The page follows recording → Studio editing → export. `StudioShowcase.tsx` wraps the existing shared-camera demo with five illustrative style previews and a sample-caption toggle. It explicitly labels the result as an interactive illustration rather than a real recording editor.

The sample captions contain six timed lines in both languages and use the demo playback clock, so pausing also pauses subtitles. Captions stay outside the camera transform to remain readable during zooms.

The Studio section describes styles and reusable backgrounds, start/end trim and editable zooms, system audio and microphone processing, and on-device Vietnamese/English captions with MP4 and SRT output. Export copy covers 1080p/1440p/4K at 60 fps, frame presets and the local processing boundary. Ground future changes in `docs/product.md` and the desktop implementation; do not advertise roadmap capabilities as shipped.

## Design decisions

UI UX Pro Max informed the product-demo-first hierarchy, visible play/pause controls, keyboard access, responsive layouts, contrast and reduced-motion behavior. The existing indigo identity, locally bundled Plus Jakarta Sans, theme switch, translations and install guide are retained. Product illustrations use CSS and Lucide rather than downloading decorative image assets.

## Validation

Run `pnpm --filter @screensway/web typecheck`, `pnpm build:web` and `pnpm test`.

Browser QA should cover English/Vietnamese and light/dark at 375, 768, 1024 and 1440 px, including reduced motion:

- Change each of the five styles; selected state and the preview must agree.
- Show/hide sample captions and compare auto zoom with the raw recording.
- Play/pause the demo. Reduced motion must start paused and reveal content immediately.
- Open the new export/caption FAQs and the install dialog; Escape must dismiss the dialog.
- Switch language and theme, and check that the header and content fit the viewport.
- Repeatedly switch EN/VI with normal motion as well as reduced motion, then scroll through every Studio card. Cards must retain stable, language-independent keys and remain visible; refresh reveal observers when the language changes.
- Let the demo complete a loop with sample captions enabled: all six lines must appear. Pause and verify the line stays unchanged, then switch language and hide/show captions.
- Verify the download filename and install-guide behavior. A mocked download validates interaction only; verify the real hosted DMG separately after deployment.

The redesign passed these browser checks across all 16 layout combinations, plus 33 shared-core tests and the web production build. The private repository's Pages workflow is responsible for publishing the actual latest release asset.
