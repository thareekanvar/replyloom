import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { env } from "cloudflare:workers"
import { createDb, eq, and, sql, desc, templates } from "@workspace/db"
import { requireCurrentWorkspaceId, requirePermission, requireCurrentPermission } from "@/lib/auth"
import { withSafeErrors } from "@/lib/errors"
import { toEpochSeconds } from "@/lib/dates"
import { cursorLimit, decodeCursor, toCursorPage } from "@/lib/cursor"
import { COUNTER, readCount } from "@/lib/counts"

const TEMPLATES_PICKER_MAX = 500

function getDb() {
  return createDb(env.DB)
}

export type TemplateMediaType = "image" | "video" | "audio" | "document"

// Every input below is parsed server-side before the handler runs: the old
// `(data: T) => data` casts only asserted a type, so anything the wire
// carried reached the database unchecked.
const workspaceIdSchema = z.string().min(1)
const templateMediaType = z.enum(["image", "video", "audio", "document"])

const getTemplatesInput = z.object({ workspaceId: workspaceIdSchema })

const getTemplatesPageInput = z.object({
  workspaceId: workspaceIdSchema,
  cursor: z.string().nullish(),
  // cursorLimit() clamps this server-side; the schema only has to reject
  // non-numbers (e.g. a string arriving over the RPC boundary).
  limit: z.number().optional(),
})

const templateFields = {
  name: z.string().min(1).max(200),
  body: z.string().max(4000).optional(),
  shortcut: z.string().max(64).optional(),
  mediaKey: z.string().max(512).optional(),
  mediaMime: z.string().max(120).optional(),
  mediaType: templateMediaType.optional(),
}

const createTemplateInput = z.object({ workspaceId: workspaceIdSchema, ...templateFields })

const updateTemplateInput = z.object({
  id: z.string().min(1),
  ...templateFields,
  mediaKey: z.string().max(512).nullish(),
  mediaMime: z.string().max(120).nullish(),
  mediaType: templateMediaType.nullish(),
})

const idInput = z.object({ id: z.string().min(1) })

export const getTemplates = createServerFn()
  .validator(getTemplatesInput)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const rows = await db
        .select()
        .from(templates)
        .where(eq(templates.workspaceId, data.workspaceId))
        .orderBy(desc(templates.updatedAt))
        // Slash-menu / pickers match shortcuts locally; a workspace's
        // templates are a curated set, but never unbounded.
        .limit(TEMPLATES_PICKER_MAX)
        .all()
      return rows.map((r) => ({
        ...r,
        createdAt: toEpochSeconds(r.createdAt)!,
        updatedAt: toEpochSeconds(r.updatedAt)!,
      }))
    })
  )

/** Templates screen: newest-updated first, keyset-paged on
 * templates_workspace_updated_idx (workspace_id, updated_at DESC, id DESC). */
export const getTemplatesPage = createServerFn()
  .validator(getTemplatesPageInput)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const limit = cursorLimit(data.limit)
      const cursor = decodeCursor(data.cursor, ["n", "s"] as const)
      const rows = await db
        .select({ template: templates, sortT: sql<number>`${templates.updatedAt}` })
        .from(templates)
        .where(
          and(
            eq(templates.workspaceId, data.workspaceId),
            cursor ? sql`(${templates.updatedAt}, ${templates.id}) < (${cursor[0]}, ${cursor[1]})` : undefined
          )
        )
        .orderBy(desc(templates.updatedAt), desc(templates.id))
        .limit(limit + 1)
        .all()
      const page = toCursorPage(rows, limit, (r) => [Number(r.sortT), r.template.id])
      const totals = cursor ? null : await readCount(db, data.workspaceId, COUNTER.templates)
      return {
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        total: totals?.total ?? null,
        totalCapped: false,
        items: page.items.map(({ template: r }) => ({
          ...r,
          createdAt: toEpochSeconds(r.createdAt)!,
          updatedAt: toEpochSeconds(r.updatedAt)!,
        })),
      }
    })
  )
export const createTemplate = createServerFn({ method: "POST" })
  .validator(createTemplateInput)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "send_messages")
      const db = getDb()
      return db
        .insert(templates)
        .values({
          workspaceId: data.workspaceId,
          name: data.name,
          body: data.body?.trim() || null,
          shortcut: data.shortcut?.trim().replace(/^\/+/, "") || null,
          mediaKey: data.mediaKey ?? null,
          mediaMime: data.mediaMime ?? null,
          mediaType: data.mediaType ?? null,
        })
        .returning()
        .get()
    }, "Couldn't create the template. A shortcut may already be in use.")
  )

export const updateTemplate = createServerFn({ method: "POST" })
  .validator(updateTemplateInput)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const workspaceId = await requireCurrentPermission("send_messages")
      await db
        .update(templates)
        .set({
          name: data.name,
          body: data.body?.trim() || null,
          shortcut: data.shortcut?.trim().replace(/^\/+/, "") || null,
          mediaKey: data.mediaKey ?? null,
          mediaMime: data.mediaMime ?? null,
          mediaType: data.mediaType ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(templates.id, data.id), eq(templates.workspaceId, workspaceId)))
      return { ok: true }
    }, "Couldn't update the template. A shortcut may already be in use.")
  )

export const deleteTemplate = createServerFn({ method: "POST" })
  .validator(idInput)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const workspaceId = await requireCurrentPermission("send_messages")
      await db.delete(templates).where(and(eq(templates.id, data.id), eq(templates.workspaceId, workspaceId)))
      return { ok: true }
    }, "Couldn't delete the template. Please try again.")
  )

// Fire-and-forget from the composer/broadcast dialog right after a
// template is used -- lets the templates list surface "most used" later
// without needing to scan the messages table for it.
export const bumpTemplateUsage = createServerFn({ method: "POST" })
  .validator(idInput)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const workspaceId = await requireCurrentWorkspaceId()
      // Atomic increment -- one D1 write, no lost updates under concurrency.
      await db
        .update(templates)
        .set({ usageCount: sql`${templates.usageCount} + 1` })
        .where(and(eq(templates.id, data.id), eq(templates.workspaceId, workspaceId)))
      return { ok: true }
    })
  )
