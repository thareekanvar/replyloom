/** "1,240" -- or "10,000+" when the server capped a search count. */
export function formatTotal(total: number, capped = false) {
  return `${total.toLocaleString()}${capped ? "+" : ""}`
}

/** Short form for tight spots like tab badges: 999, 1.2k, 45k, 1.3M. */
export function formatCompactCount(n: number) {
  if (n < 1000) return String(n)
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n)
}

/** First page of a cursor-paged infinite query carries the exact total. */
export function totalOf(
  data: { pages: { total?: number | null; totalCapped?: boolean }[] } | undefined
) {
  const first = data?.pages[0]
  return first?.total == null
    ? null
    : { total: first.total, capped: !!first.totalCapped }
}

/** Rows loaded so far across all pages of an infinite query. */
export function shownOf(data: { pages: { items: unknown[] }[] } | undefined) {
  return data?.pages.reduce((n, p) => n + p.items.length, 0) ?? 0
}
