import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

// Dedicated test config: intentionally does NOT load @cloudflare/vite-plugin.
// That plugin launches the workerd runtime during startup, which crashes with
// "ReferenceError: module is not defined" when Vitest invokes it from Node.
// Production/dev builds still use vite.config.ts (with the plugin) untouched.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      // Vite's import analysis cannot resolve the cloudflare: protocol, so
      // point it at a local stub before vi.mock ever gets a chance to run.
      "cloudflare:workers": fileURLToPath(
        new URL("./src/test/cloudflare-workers-stub.ts", import.meta.url)
      ),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
})
