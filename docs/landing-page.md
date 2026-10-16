# Landing page

The marketing site lives in `apps/web` and deploys through the existing GitHub Pages workflow. Download links point at the downloads Worker's `/latest/` paths (`VITE_DOWNLOADS_URL`, set in `web.yml`; local builds fall back to `./download/`), because the source repository is private and the installers are too large for Pages (see `releasing.md`). Both platform downloads are active; keep English and Vietnamese installation guides synchronized.

## Product story

The page is deliberately compact: hero/downloads and the interactive demo → four benefit cards → one browser-recorder feature → five essential FAQs → a compact download CTA. The benefits combine auto zoom/editing, styles/backgrounds, audio/offline captions and 4K export. A short trust line covers local processing. Standalone metrics, how-it-works, recording-feature bento, Studio cards, export story, privacy illustration and FAQ chat were consolidated or removed to avoid repetition. Header navigation links only to the demo, benefits and FAQ; installation detail remains in the platform popup.

The page follows recording → Studio editing → export. `StudioShowcase.tsx` wraps the existing shared-camera demo with the five real `BUILT_IN_STYLES` presets and a sample-caption toggle. It explicitly labels the result as an interactive illustration rather than a real recording editor.

`RecordingFrame.tsx` uses `computeLayout` and `paintFrameBase` from the shared core, exactly like the desktop preview/export. Do not replace frames or backgrounds with approximate CSS: Studio uses its mesh and dark macOS chrome, Clean uses light macOS chrome, MacBook includes its bezel/camera/base, Website includes browser chrome and a 16:9 canvas, and Social uses waves/grain/glass on a square canvas. The eight desktop frame types are also independently selectable. Style thumbnails use the same painter, with an Auto canvas as in the desktop style picker. Applying a style resets the frame override, without resetting demo playback or sample captions.

The sample captions contain six timed lines in both languages and use the demo playback clock, so pausing also pauses subtitles. Captions stay outside the camera transform to remain readable during zooms.

The benefit cards describe styles and reusable backgrounds, start/end trim and editable zooms, system audio and microphone processing, and on-device Vietnamese/English captions with MP4 and SRT output. Export copy covers 1080p/1440p/4K at 60 fps, frame presets and the local processing boundary. Ground future changes in `docs/product.md` and the desktop implementation; do not advertise roadmap capabilities as shipped.

## Design decisions

UI UX Pro Max informed the product-demo-first hierarchy, visible play/pause controls, keyboard access, responsive layouts, contrast and reduced-motion behavior. Translations and the install guide are retained.

The visual language is a black stage with white ink and a violet accent (`#a78bfa`) taken from the hero globe, set in the locally bundled Plus Jakarta Sans (medium-weight headings with tight tracking, light lede). The hero fills the first viewport: a looping clip of a violet dot-matrix globe (`public/hero/globe.mp4`, 3 MB, with `globe.jpg` as poster) behind a two-line headline, lede, two equal white pill downloads with arrows, a distinct outlined/glass browser CTA (`./app/`, beta) and the requirements note. The browser CTA is intentionally not styled as a third platform download. The clip's last frame does not match its first, so `HeroBackdrop` (`HeroBackdrop.tsx`; the landing page's alone, the browser app keeps a plain background) stacks two copies and cross-fades them 0.9 s before the loop point; under reduced motion it stays on the first frame. The clip is fixed behind the whole page (`.page-bg`), so the globe and stars stay visible while scrolling; once the hero scrolls away a veil in the page colour (`--veil`, driven by `--dim` from the scroll position) thickens so the sections stay readable, and cards use a blurred glass fill. The page is dark only: the light theme and its switch were removed because the black video backdrop has no light counterpart. The clip came from the design reference the founder supplied, re-encoded from a 38 MB original; confirm its licence before reusing it elsewhere.

After the four benefits, `WebBrowserSection.tsx` gives the browser recorder one compact feature block: a live demo in a `RecordingFrame` painted by the shared core (a pointer path whose pauses are "focus" events, zoomed by the core camera, with the zooms on a timeline and a playhead; it pauses off screen and stays still under reduced motion), three advantages, honest Chrome/Edge and feature limits, and a CTA to `/app/`. It shows focus zooms and no click ripples, because that is how the browser version zooms. Its strings are `webFeature.*` in `i18n.tsx`. The FAQ keeps five entries by replacing the captions question with “Can I use ScreenSway without installing it?”.

The header is a flat transparent row: wordmark left, section links centred, a small square button showing the current language (EN/VI) that switches to the other, a solid white "Record on the web" button to `./app/` (same tab, with the cross-fade both pages declare in `index.html`) and a violet one for the download guide. Buttons, cards and text use single flat colours: no gradients or glossy top highlights (only the page backdrop, the hero vignette and the demo glow keep their soft gradients). It gains a blurred bar once the page scrolls. The link of the section crossing the middle of the viewport is marked `aria-current`. At 900 px and below the same links and controls re-compose into a panel under the burger button (closes on Escape, outside click or a link).

The opening sequence runs once: `index.html` adds `.anim` to `<html>` before first paint (never under reduced motion), `useEntrance` in `App.tsx` waits for fonts (500 ms guard), adds `.play`, then removes both classes so no residual transforms remain. Headline lines rise out of a mask, the lede lifts into focus, pills settle and nav items lift quietly; the video itself never animates. Product illustrations use CSS and Lucide rather than downloading decorative image assets. Both installation tabs include theme-aware visual mockups. Windows shows the downloaded installer, SmartScreen’s More info → Run anyway flow, and desktop microphone access; keep their labels bilingual and all three cards responsive.

The page reports visits, download clicks and install-guide opens to the analytics API when `VITE_ANALYTICS_URL` is set (`src/analytics.ts`): no cookies or storage, and nothing for visitors who send Do Not Track or Global Privacy Control. The page no longer shows a notice about this (the founder removed the footer line); see `analytics.md` for what is collected.

A first visit always opens in English, ignoring the browser language. A `?lang=en|vi` parameter or the visitor's saved language (`screensway.language` in localStorage) takes precedence. `page_view` still reports `theme: "dark"` so the analytics schema is unchanged.

## Validation

Run `pnpm --filter @screensway/web typecheck`, `pnpm build:web` and `pnpm test`.

Browser QA should cover English/Vietnamese at 375, 768, 1024 and 1440 px, including reduced motion:

- Change each of the five styles; selected state and the preview must agree.
- Try all eight frame types with each preset. Compare the background canvas pixels with the shared painter and the recording viewport bounds with `computeLayout`; styles must retain their real aspect, padding, radius and shadow. Verify English/Vietnamese labels match the app.
- Show/hide sample captions and compare auto zoom with the raw recording.
- Play/pause the demo. Reduced motion must start paused and reveal content immediately.
- Open the new export/caption FAQs and the install dialog; Escape must dismiss the dialog.
- Switch language, and check that the header and content fit the viewport.
- Repeatedly switch EN/VI with normal motion as well as reduced motion, then scroll through every benefit card. Cards must retain stable, language-independent keys and remain visible; refresh reveal observers when the language changes.
- Let the demo complete a loop with sample captions enabled: all six lines must appear. Pause and verify the line stays unchanged, then switch language and hide/show captions.
- Verify the download filename and install-guide behavior. A mocked download validates interaction only; verify the real hosted DMG separately after deployment.

The redesign passed these browser checks across all 16 layout combinations, plus 33 shared-core tests and the web production build. The private repository's Pages workflow is responsible for publishing the actual latest release asset.

The shared-renderer update additionally passed 720 browser comparisons (five presets × preset default/eight frame overrides × 16 layout combinations): frame canvas pixels match `paintFrameBase`, video placement matches `computeLayout`, and controls fit the viewport. Normal-motion checks also cover all six timed subtitles, pause across style changes and repeated locale switching without losing Studio content.

The header’s Download guide button opens the install dialog without starting a download. Its active platform tab names and links the corresponding installer. The main download actions use the monochrome Apple mark and Windows blue mark in both themes.

The macOS and Windows download actions share equal widths, filled backgrounds, shadows and hover/press effects in both the hero and footer CTA. Neither platform is visually secondary.
