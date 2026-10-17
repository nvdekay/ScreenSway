// Content-Security-Policy for the pages GitHub Pages serves (the landing page and the
// browser app). Pages cannot send headers, so the policy is a <meta> tag, added only to
// production builds (the dev server injects inline styles and a websocket for HMR).
// Inline <script> and <style> blocks left in the final HTML are allowed by their SHA-256
// hash, computed here, so editing them never needs a manual hash update.
// A <meta> policy cannot set frame-ancestors; Pages does not allow that header either.
import { createHash } from "node:crypto";

const hash = (text) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/** Inline blocks of one tag, skipping `<script src=…>`. */
function inlineHashes(html, tag) {
  const blocks = html.matchAll(new RegExp(`<${tag}\\b(?![^>]*\\bsrc=)[^>]*>([\\s\\S]*?)</${tag}>`, "gi"));
  return [...blocks].map((block) => hash(block[1])).filter((value, index, all) => all.indexOf(value) === index);
}

/** The origin of an endpoint such as VITE_ANALYTICS_URL, or nothing when it is not set. */
export function originOf(url) {
  if (!url) return [];
  try {
    return [new URL(url).origin];
  } catch {
    throw new Error(`Not a URL: ${url}`);
  }
}

/**
 * @param {Record<string, string[]>} directives the policy; inline hashes are appended to
 *   script-src and style-src.
 */
export function contentSecurityPolicy(directives) {
  return {
    name: "screensway-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const policy = { ...directives };
        policy["script-src"] = [...(policy["script-src"] ?? ["'self'"]), ...inlineHashes(html, "script")];
        policy["style-src"] = [...(policy["style-src"] ?? ["'self'"]), ...inlineHashes(html, "style")];
        const content = Object.entries(policy)
          .map(([name, sources]) => [name, ...sources].join(" "))
          .join("; ");
        if (!/<meta charset="UTF-8" \/>/i.test(html)) throw new Error("index.html needs <meta charset> to place the CSP after it");
        // Right after the charset, so it governs every script and style that follows.
        return html.replace(/<meta charset="UTF-8" \/>/i, (charset) => `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${content}" />`);
      },
    },
  };
}
