import { cn } from "@workspace/ui/lib/utils"

const VARIABLE_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

interface TextSegment {
  text: string
  variable?: string
}

/** Splits a template body into plain-text and {{variable}} segments, mirroring extractTemplateVariables. */
export function splitTemplateSegments(body: string): TextSegment[] {
  const segments: TextSegment[] = []
  let last = 0
  for (const m of body.matchAll(VARIABLE_RE)) {
    if (m.index > last) segments.push({ text: body.slice(last, m.index) })
    segments.push({ text: m[0], variable: m[1] })
    last = m.index + m[0].length
  }
  if (last < body.length) segments.push({ text: body.slice(last) })
  return segments
}

/** Renders a template body with every {{variable}} highlighted as a chip. */
export function TemplateBody({
  body,
  className,
  chipClassName,
}: {
  body: string | null
  className?: string
  chipClassName?: string
}) {
  if (!body) return null
  const segments = splitTemplateSegments(body)
  return (
    <span className={cn("inline leading-relaxed", className)}>
      {segments.map((s, i) =>
        s.variable ? (
          <span
            key={i}
            className={cn(
              "mx-0.5 inline-flex items-center rounded-md bg-primary/10 px-1.5 py-0.5 align-baseline font-medium text-primary",
              chipClassName
            )}
          >
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </span>
  )
}
