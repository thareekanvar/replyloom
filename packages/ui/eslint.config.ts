import { tanstackConfig } from "@tanstack/eslint-config"

export default [
  ...tanstackConfig,
  {
    ignores: ["eslint.config.ts", ".prettierrc"],
  },
]
