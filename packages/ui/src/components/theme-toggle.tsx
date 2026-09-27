"use client"

import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { MoonIcon, SunIcon } from "lucide-react"

import { cn } from "cn"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  AnimatedThemeToggler
  
} from "@workspace/ui/components/animated-theme-toggler"
import type {TransitionVariant} from "@workspace/ui/components/animated-theme-toggler";

/**
 * Light/dark toggle with a View Transitions reveal (star by default).
 * Controlled by next-themes so persistence + `useTheme()` subscribers stay
 * in sync. Renders a stable icon until mounted so SSR matches first paint.
 */
export function ThemeToggle({
  variant = "star",
  duration = 600,
  className,
}: {
  variant?: TransitionVariant
  duration?: number
  className?: string
}) {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  const isDark = mounted && resolvedTheme === "dark"

  return (
    <AnimatedThemeToggler
      variant={variant}
      duration={duration}
      theme={isDark ? "dark" : "light"}
      onThemeChange={setTheme}
      aria-label="Toggle theme"
      className={cn(
        buttonVariants({ variant: "ghost", size: "icon" }),
        className
      )}
    >
      {isDark ? (
        <SunIcon className="size-4" />
      ) : (
        <MoonIcon className="size-4" />
      )}
    </AnimatedThemeToggler>
  )
}
