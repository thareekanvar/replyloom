import { createServerFn } from "@tanstack/react-start"
import { env } from "cloudflare:workers"
import { createDb, eq, and, desc, sql, mediaAssets } from "@workspace/db"
import { withSafeErrors } from "@/lib/errors"
import { toEpochSeconds } from "@/lib/dates"
import { callEngine } from "@/lib/wa-engine"
import { requireWorkspaceAccess, requirePermission, requireCurrentPermission } from "@/lib/auth"
import { cursorLimit, decodeCursor, toCursorPage } from "@/lib/cursor"
import { COUNTER, cappedCount, readCount } from "@/lib/counts"

function getDb() {
  return createDb(env.DB)
}

export type MediaAssetType = "image" | "video" | "audio" | "document"

/** Media gallery: newest first, keyset-paged on
 * media_assets_workspace_created_idx (workspace_id, created_at DESC, id DESC),
 * with optional server-side name search and type filter. */
export const getMediaAssetsPage = createServerFn()
  .validator(
    (data: {
      workspaceId: string
      q?: string
      type?: MediaAssetType | "all"
      cursor?: string | null
      limit?: number
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      const limit = cursorLimit(data.limit, 30)
      const cursor = decodeCursor(data.cursor, ["n", "s"] as const)
      const q = (data.q ?? "").trim().slice(0, 100)
      const filters = and(
        eq(mediaAssets.workspaceId, data.workspaceId),
        data.type && data.type !== "all" ? eq(mediaAssets.mediaType, data.type) : undefined,
        q
          ? sql`${mediaAssets.fileName} LIKE ${`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} ESCAPE '\\'`
          : undefined
      )
      const rows = await db
        .select({ asset: mediaAssets, sortT: sql<number>`${mediaAssets.createdAt}` })
        .from(mediaAssets)
        .where(
          and(
            filters,
            cursor
              ? sql`(${mediaAssets.createdAt}, ${mediaAssets.id}) < (${cursor[0]}, ${cursor[1]})`
              : undefined
          )
        )
        .orderBy(desc(mediaAssets.createdAt), desc(mediaAssets.id))
        .limit(limit + 1)
        .all()
      const page = toCursorPage(rows, limit, (r) => [Number(r.sortT), r.asset.id])
      const filtered = !!q || (!!data.type && data.type !== "all")
      const totals = cursor
        ? null
        : filtered
          ? await cappedCount(db, db.select({ one: sql`1` }).from(mediaAssets).where(filters))
          : await readCount(db, data.workspaceId, COUNTER.mediaAssets)
      return {
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        total: totals?.total ?? null,
        totalCapped: totals?.totalCapped ?? false,
        items: page.items.map(({ asset: r }) => ({ ...r, createdAt: toEpochSeconds(r.createdAt)! })),
      }
    })
  )

// Called right after a successful POST /media/upload (see wa-api.ts) to
// catalog the asset -- the worker owns R2, this just owns "what's in it,
// named, per workspace" so the gallery has something to list.
export const createMediaAsset = createServerFn({ method: "POST" })
  .validator(
    (data: {
      workspaceId: string
      mediaKey: string
      mediaMime: string
      mediaType: MediaAssetType
      fileName?: string
      fileSizeBytes?: number
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "send_messages")
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      return db
        .insert(mediaAssets)
        .values({
          workspaceId: data.workspaceId,
          mediaKey: data.mediaKey,
          mediaMime: data.mediaMime,
          mediaType: data.mediaType,
          fileName: data.fileName ?? null,
          fileSizeBytes: data.fileSizeBytes ?? null,
        })
        .returning()
        .get()
    }, "Couldn't save the asset. Please try again.")
  )

export const deleteMediaAsset = createServerFn({ method: "POST" })
  .validator((data: { id: string; mediaKey: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireCurrentPermission("send_messages")
      const db = getDb()
      const asset = await db
        .select({ workspaceId: mediaAssets.workspaceId })
        .from(mediaAssets)
        .where(eq(mediaAssets.id, data.id))
        .get()
      if (!asset) throw new Error("Media asset not found")
      await requireWorkspaceAccess(asset.workspaceId)
      await db.delete(mediaAssets).where(eq(mediaAssets.id, data.id))
      // Best-effort -- a template still pointing at this key keeps working
      // off R2's copy regardless (see ./templates.ts), this only removes
      // it from the gallery's own storage.
      try {
        await callEngine(
          `/media/${encodeURIComponent(data.mediaKey)}`,
          asset.workspaceId,
          {
            method: "DELETE",
          }
        )
      } catch {
        // non-fatal
      }
      return { ok: true }
    }, "Couldn't delete the asset. Please try again.")
  )
