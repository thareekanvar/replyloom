export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("Chunk size must be greater than zero")

  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}
