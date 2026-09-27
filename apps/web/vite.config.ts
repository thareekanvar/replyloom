import { defineConfig  } from "vite"
import type {Plugin} from "vite";
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import { cloudflare } from "@cloudflare/vite-plugin"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// @cloudflare/vite-plugin externalizes cloudflare:* modules for its Worker
// environments via the environment's `resolve.builtins` (it also validates and
// REJECTS setting `resolve.external` on those environments). With rolldown/vite
// 8 the builtins list isn't honoured for the SSR worker build, so the
// `cloudflare:workers` import in src/lib/auth.ts (and friends) fails to resolve
// ("Rolldown failed to resolve import"). Externalizing through
// `build.rolldownOptions.external` on the "ssr" environment (only) is the
// plugin-compatible way to get the worker bundle to treat them as provided-by-
// workerd at runtime.
const cloudflareBuiltinsExternal: Plugin = {
  name: "cloudflare-builtins-external",
  configEnvironment(name, options) {
    if (name !== "ssr") return
    const existing = options.build?.rolldownOptions?.external
    return {
      build: {
        rolldownOptions: {
          external: [
            ...(Array.isArray(existing) ? existing : []),
            "cloudflare:workers",
            "cloudflare:email",
            "cloudflare:node",
            "cloudflare:sockets",
            "cloudflare:workflows",
          ],
        },
      },
    }
  },
}

// TanStack Start's client compile strips createServerFn handler bodies but it
// does not drop plain, non-server-fn exports that live next to a
// `cloudflare:workers` import (e.g. resolveActiveWorkspaceId in src/lib/auth.ts,
// or the client-side hooks re-exporting server helpers). Those imports end up in
// the client graph and are unresolvable in the browser. For the client
// environment only, resolve cloudflare:* to an empty stub module so the client
// bundle stays valid — the real bindings are only ever used server-side.
// Vite's plugin `this.environment` / hook-argument typings assume they're
// always populated, but in practice (older Vite versions, certain hook
// invocation phases) that's not guaranteed -- keep the guards.
/* eslint-disable @typescript-eslint/no-unnecessary-condition */
const cloudflareClientStub: Plugin = {
  name: "cloudflare-client-stub",
  enforce: "pre",
  resolveId(source) {
    if (this.environment?.name !== "client") return
    if (source.startsWith("cloudflare:")) return `\0cloudflare-stub:${source}`
  },
  load(id) {
    if (id?.startsWith("\0cloudflare-stub:")) {
      return `export const env = {}
export class DurableObject {}
export class WorkerEntrypoint {}
export class WorkflowEntrypoint {}
export const SELF = {}`
    }
  },
}
/* eslint-enable @typescript-eslint/no-unnecessary-condition */

// better-auth's newer 1.7.x releases are split across several small
// @better-auth/* packages. Vite's dependency optimizer (both the client
// and the SSR/"deps_ssr" one used by the Cloudflare Workers environment)
// can end up with a stale or partially-bundled cache for these after a
// version bump, which surfaces as "the file does not exist ... in the
// optimize deps directory" on first request. Excluding better-auth's
// entrypoints from pre-bundling avoids that class of cache/bundling
// mismatch — it's imported directly by server code anyway, so there's
// no bundling benefit to pre-optimizing it.
const betterAuthEntrypoints = [
  "better-auth",
  "better-auth/api",
  "better-auth/adapters/drizzle",
  "better-auth/tanstack-start",
]

// Content Security Policy headers for production security.
// Adjust these values based on your specific needs (e.g., CDN domains for assets).
const cspHeaders: Plugin = {
  name: "csp-headers",
  configureServer(server) {
    const engineOrigin = ((process.env.VITE_ENGINE_URL as string | undefined) ?? "").replace(/\/+$/, "")
    server.middlewares.use((_req, res, next) => {
      // Only add CSP in production; skip during development for easier debugging
      if (process.env.NODE_ENV === "production") {
        res.setHeader(
          "Content-Security-Policy",
          [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // TanStack Start requires inline/eval for hydration
            "style-src 'self' 'unsafe-inline'", // Tailwind requires inline styles
            "img-src 'self' data: https:",
            "font-src 'self'",
            `connect-src 'self' ${engineOrigin} ${engineOrigin.replace(/^http/, "ws")}`.trim(),
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join("; ")
        )
      }
      next()
    })
  },
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  optimizeDeps: {
    exclude: betterAuthEntrypoints,
  },
  ssr: {
    optimizeDeps: {
      exclude: betterAuthEntrypoints,
    },
  },
  plugins: [
    devtools(),
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    viteReact(),
    cloudflareClientStub,
    cloudflareBuiltinsExternal,
    cspHeaders,
  ],
})

export default config
