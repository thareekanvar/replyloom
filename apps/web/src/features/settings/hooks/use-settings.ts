import { createServerFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { env } from "cloudflare:workers"
import {
  createDb,
  eq,
  and,
  desc,
  organization,
  member,
  user,
  autoReplyRules,
  webhooks,
  notificationPreferences,
  validateRulePattern,
  assertSafeOutboundUrl,
} from "@workspace/db"
import { UserFacingError, withSafeErrors } from "@/lib/errors"
import { createWebhookInput, createAutoReplyRuleInput, updateAutoReplyRuleInput } from "@/lib/server-schemas"
import { toEpochSeconds } from "@/lib/dates"
import { auth } from "@/lib/auth-server"
import { requireCurrentPermission } from "@/lib/auth"

function getDb() {
  return createDb(env.DB)
}

/** Resolves the signed-in user from the request's own session cookie --
 * used by the account/notification endpoints below so a user can only
 * ever read or change their own settings, regardless of what a client
 * happens to pass in. */
async function requireSessionUser() {
  const result = await auth.api.getSession({ headers: getRequestHeaders() })
  if (!result) throw new Error("You need to sign in again.")
  return result.user
}

// ── Workspace + team (backed by Better Auth's organization plugin) ──
export const getWorkspaceSettings = createServerFn()
  .validator((data: { workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const org = await db
        .select()
        .from(organization)
        .where(eq(organization.id, data.workspaceId))
        .get()
      const members = await db
        .select({
          userId: member.userId,
          role: member.role,
          name: user.name,
          email: user.email,
        })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(eq(member.organizationId, data.workspaceId))
        .all()

      return {
        workspace: org ? { id: org.id, name: org.name, slug: org.slug } : null,
        members,
      }
    })
  )

// ── Account (the signed-in user's own profile) ──
export const updateProfile = createServerFn({ method: "POST" })
  .validator((data: { name: string; image?: string | null }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const sessionUser = await requireSessionUser()
      const name = data.name.trim()
      if (!name) throw new Error("Name can't be empty.")

      const db = getDb()
      await db
        .update(user)
        .set({ name, image: data.image ?? null, updatedAt: new Date() })
        .where(eq(user.id, sessionUser.id))

      return { ok: true, name, image: data.image ?? null }
    }, "Couldn't update your profile. Please try again.")
  )

// ── Profile photo upload (replaces the old "paste a URL" workflow) ──
// The file arrives as base64, is validated and stored in R2 under a
// per-user avatars prefix, and the key is returned so the client can
// resolve it to a public URL via waApi.mediaUrl before saving the profile.
const MAX_AVATAR_BYTES = 5 * 1024 * 1024

export const uploadProfileImage = createServerFn({ method: "POST" })
  .validator((data: { base64: string; mime: string }) => {
    // Raster only: an SVG is a script-capable document served from our origin.
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(data.mime))
      throw new Error("Please choose a JPG, PNG, WebP or GIF image.")
    if (!data.base64) throw new Error("No image data received.")
    if (data.base64.length > MAX_AVATAR_BYTES * 1.4)
      throw new Error("That image is too large (max 5 MB).")
    return data
  })
  .handler(
    withSafeErrors(async ({ data }) => {
      const sessionUser = await requireSessionUser()
      const db = getDb()
      const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0))
      const ext = (data.mime.split("/")[1] ?? "png").split(";")[0]
      const mediaKey = `user-avatars/${sessionUser.id}/${crypto.randomUUID()}.${ext}`
      await env.MEDIA.put(mediaKey, bytes, {
        httpMetadata: { contentType: data.mime },
      })

      // Replacing a previous upload? Drop the old R2 object, but only if
      // it lives under our avatars prefix -- an external (Google, pasted
      // URL) avatar is someone else's object and stays untouched.
      const current = await db
        .select({ image: user.image })
        .from(user)
        .where(eq(user.id, sessionUser.id))
        .get()
      const prev = current?.image
      if (prev) {
        try {
          const prevKey = decodeURIComponent(
            new URL(prev).pathname.replace(/^\/media\//, "")
          )
          if (prevKey.startsWith("user-avatars/")) await env.MEDIA.delete(prevKey)
        } catch {
          // non-fatal -- unparseable/external URL left alone
        }
      }

      return { ok: true, mediaKey, mediaMime: data.mime }
    }, "Couldn't upload your photo. Please try again.")
  )

// ── Notification preferences ──
// Per-user, not workspace-scoped: desktop alerts and sound are a personal
// browser setting, so one row per user is enough. emailDigestEnabled is
// stored for a future digest email (Resend is already wired for invites)
// but nothing sends on it yet.
export const getNotificationPreferences = createServerFn().handler(
  withSafeErrors(async () => {
    const sessionUser = await requireSessionUser()
    const db = getDb()
    const row = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, sessionUser.id))
      .get()

    return {
      desktopEnabled: row?.desktopEnabled ?? false,
      soundEnabled: row?.soundEnabled ?? true,
      emailDigestEnabled: row?.emailDigestEnabled ?? false,
    }
  })
)

export const updateNotificationPreferences = createServerFn({ method: "POST" })
  .validator(
    (data: {
      desktopEnabled?: boolean
      soundEnabled?: boolean
      emailDigestEnabled?: boolean
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      const sessionUser = await requireSessionUser()
      const db = getDb()
      const existing = await db
        .select({ userId: notificationPreferences.userId })
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, sessionUser.id))
        .get()

      if (existing) {
        await db
          .update(notificationPreferences)
          .set({ ...data, updatedAt: new Date() })
          .where(eq(notificationPreferences.userId, sessionUser.id))
      } else {
        await db.insert(notificationPreferences).values({
          userId: sessionUser.id,
          desktopEnabled: data.desktopEnabled ?? false,
          soundEnabled: data.soundEnabled ?? true,
          emailDigestEnabled: data.emailDigestEnabled ?? false,
        })
      }

      return { ok: true }
    }, "Couldn't save your notification preferences. Please try again.")
  )

// ── Auto-reply rules ──
export const getAutoReplyRules = createServerFn()
  .validator((data: { workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      return db
        .select()
        .from(autoReplyRules)
        .where(eq(autoReplyRules.workspaceId, data.workspaceId))
        .orderBy(desc(autoReplyRules.priority))
        .all()
    })
  )

export const createAutoReplyRule = createServerFn({ method: "POST" })
  .validator(createAutoReplyRuleInput)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireCurrentPermission("manage_settings")
      if (data.matchType === "regex") {
        const problem = validateRulePattern(data.keyword)
        if (problem) throw new UserFacingError(problem)
      }
      const db = getDb()
      return db
        .insert(autoReplyRules)
        .values({
          workspaceId: data.workspaceId,
          waSessionId: data.waSessionId ?? null,
          keyword: data.keyword,
          matchType: data.matchType,
          context: data.context,
          replyText: data.replyText,
        })
        .returning()
        .get()
    }, "Couldn't create the rule. Please try again.")
  )

export const updateAutoReplyRule = createServerFn({ method: "POST" })
  .validator(updateAutoReplyRuleInput)
  .handler(
    withSafeErrors(async ({ data }) => {
      if (data.matchType === "regex") {
        const problem = validateRulePattern(data.keyword)
        if (problem) throw new UserFacingError(problem)
      }
      const db = getDb()
      const workspaceId = await requireCurrentPermission("manage_settings")
      await db
        .update(autoReplyRules)
        .set({
          waSessionId: data.waSessionId ?? null,
          keyword: data.keyword,
          matchType: data.matchType,
          context: data.context,
          replyText: data.replyText,
        })
        .where(and(eq(autoReplyRules.id, data.id), eq(autoReplyRules.workspaceId, workspaceId)))
      return { ok: true }
    }, "Couldn't update the rule. Please try again.")
  )

export const toggleAutoReplyRule = createServerFn({ method: "POST" })
  .validator((data: { id: string; enabled: boolean }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const workspaceId = await requireCurrentPermission("manage_settings")
      await db
        .update(autoReplyRules)
        .set({ enabled: data.enabled })
        .where(and(eq(autoReplyRules.id, data.id), eq(autoReplyRules.workspaceId, workspaceId)))
      return { ok: true }
    }, "Couldn't update the rule. Please try again.")
  )

export const deleteAutoReplyRule = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const workspaceId = await requireCurrentPermission("manage_settings")
      await db.delete(autoReplyRules).where(and(eq(autoReplyRules.id, data.id), eq(autoReplyRules.workspaceId, workspaceId)))
      return { ok: true }
    }, "Couldn't delete the rule. Please try again.")
  )

// ── Webhooks ──
export const getWebhooks = createServerFn()
  .validator((data: { workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const rows = await db
        .select({
          id: webhooks.id,
          url: webhooks.url,
          events: webhooks.events,
          enabled: webhooks.enabled,
          createdAt: webhooks.createdAt,
        })
        .from(webhooks)
        .where(eq(webhooks.workspaceId, data.workspaceId))
        .orderBy(desc(webhooks.createdAt))
        .all()
      // The signing secret is intentionally never returned here -- only
      // once, from createWebhook, right after it's generated.
      return rows.map((r) => ({
        ...r,
        createdAt: toEpochSeconds(r.createdAt)!,
      }))
    })
  )

export const createWebhook = createServerFn({ method: "POST" })
  .validator(createWebhookInput)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireCurrentPermission("manage_settings")
      const safe = assertSafeOutboundUrl(data.url)
      if (!safe.ok) throw new UserFacingError(`Webhook URL rejected: ${safe.error}`)
      if (safe.url.protocol !== "https:") throw new UserFacingError("Webhook URLs must use https://")
      const db = getDb()
      const secret = crypto.randomUUID().replace(/-/g, "")
      const row = await db
        .insert(webhooks)
        .values({
          workspaceId: data.workspaceId,
          url: safe.url.toString(),
          secret,
          events: data.events,
        })
        .returning()
        .get()
      return row // secret is only ever returned here, right after creation
    }, "Couldn't create the webhook. Please try again.")
  )

export const toggleWebhook = createServerFn({ method: "POST" })
  .validator((data: { id: string; enabled: boolean }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const workspaceId = await requireCurrentPermission("manage_settings")
      await db
        .update(webhooks)
        .set({ enabled: data.enabled })
        .where(and(eq(webhooks.id, data.id), eq(webhooks.workspaceId, workspaceId)))
      return { ok: true }
    }, "Couldn't update the webhook. Please try again.")
  )

export const deleteWebhook = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const workspaceId = await requireCurrentPermission("manage_settings")
      await db.delete(webhooks).where(and(eq(webhooks.id, data.id), eq(webhooks.workspaceId, workspaceId)))
      return { ok: true }
    }, "Couldn't delete the webhook. Please try again.")
  )
