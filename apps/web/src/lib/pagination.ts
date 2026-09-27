export const DEFAULT_PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 100

export type PaginationInput = {
  page?: number
  pageSize?: number
}

export function getPagination(input: PaginationInput = {}) {
  const page = Number.isFinite(input.page)
    ? Math.max(1, Math.floor(input.page!))
    : 1
  const pageSize = Number.isFinite(input.pageSize)
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(input.pageSize!)))
    : DEFAULT_PAGE_SIZE

  return { page, pageSize, offset: (page - 1) * pageSize }
}

export function pageResult<T>(items: T[], page: number, pageSize: number) {
  const hasMore = items.length > pageSize
  return {
    items: hasMore ? items.slice(0, pageSize) : items,
    page,
    pageSize,
    hasMore,
  }
}

export function shouldFetchNextPage(
  canUseLoadedNextPage: boolean,
  hasMoreOnServer: boolean
) {
  return !canUseLoadedNextPage && hasMoreOnServer
}

export function getTotalPages(totalCount: number, pageSize: number) {
  if (totalCount <= 0) return 0
  return Math.ceil(totalCount / pageSize)
}
