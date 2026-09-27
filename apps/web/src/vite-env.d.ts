/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WA_API_URL: string
  readonly VITE_ENGINE_URL: string
  readonly VITE_SENTRY_DSN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
