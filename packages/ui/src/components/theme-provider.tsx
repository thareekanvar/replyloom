"use client"

import { ThemeProvider as NextThemesProvider } from "next-themes"
import type { ComponentProps } from "react"

/**
 * Wraps next-themes' provider so light/dark actually work app-wide.
 *
 * The CSS variables for both modes already exist in globals.css (a `.dark`
 * class selector, plus `@custom-variant dark (&:is(.dark *))`) — this is
 * the missing piece that toggles that class on <html>. Without it, the
 * toast component's `useTheme()` call above silently no-ops and the app
 * is stuck on light mode regardless of OS preference or user choice.
 */
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}
