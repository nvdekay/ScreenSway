import type { Plugin } from "vite";

/** The origin of an endpoint such as VITE_ANALYTICS_URL, or nothing when it is not set. */
export function originOf(url: string | undefined): string[];
/** Adds a Content-Security-Policy <meta> to production builds; see vite-csp.mjs. */
export function contentSecurityPolicy(directives: Record<string, string[]>): Plugin;
