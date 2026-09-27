import { createServerFn } from "@tanstack/react-start"
import { env } from "cloudflare:workers"
import { createDb, eq, and, desc, waSessions } from "@workspace/db"
import { withSafeErrors } from "@/lib/errors"
import { toEpochSeconds } from "@/lib/dates"
import { requireWorkspaceAccess, requirePermission, requireCurrentPermission } from "@/lib/auth"
import { fetchWaWorker } from "@/lib/wa-engine"

function getDb() {
  return createDb(env.DB)
}

interface LiveStatus {
  connection: string
  user: string | null
}

async function fetchLiveStatus(
  sessionId: string,
  workspaceId: string
): Promise<LiveStatus | null> {
  try {
    await requireWorkspaceAccess(workspaceId)
    const res = await fetchWaWorker(`/session/${sessionId}`, {
      headers: {
        Authorization: `Bearer ${(env as any).ENGINE_INTERNAL_SECRET ?? ""}`,
        "X-Engine-Workspace": workspaceId,
      },
      // One hung Durable Object must not stall getSessions: RealtimeProvider
      // calls it app-wide every 30s and would queue behind the slowest DO.
      // A timeout just falls back to the D1 status below.
      signal: AbortSignal.timeout(2_000),
    })
    if (!res.ok) return null
    const data = await res.json<{ connection: string; user: string | null }>()
    return { connection: data.connection, user: data.user }
  } catch {
    return null
  }
}

export const getSessions = createServerFn()
  .validator((data: { workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()

      const rows = await db
        .select()
        .from(waSessions)
        .where(eq(waSessions.workspaceId, data.workspaceId))
        .orderBy(desc(waSessions.createdAt))
        .all()

      // Fetch LIVE status from each session's Durable Object via the worker
      // service binding. This gives us real-time connection state instead of
      // waiting for the async D1 write (markSessionStatus in waitUntil) to land.
      const enriched = await Promise.all(
        rows.map(async (r) => {
          let live: LiveStatus | null = null
          try {
            live = await fetchLiveStatus(r.id, r.workspaceId)
          } catch {
            // DO may not exist yet — fall back to D1 status
          }
          return {
            ...r,
            createdAt: toEpochSeconds(r.createdAt)!,
            status: (live?.connection ?? r.status) as typeof r.status,
            connectedJid: live?.user ?? r.connectedJid,
          }
        })
      )

      return enriched
    })
  )

export const createSession = createServerFn({ method: "POST" })
  .validator(
    (data: { workspaceId: string; label: string; phoneNumber?: string }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_integrations")
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()

      const session = await db
        .insert(waSessions)
        .values({
          workspaceId: data.workspaceId,
          label: data.label,
          phoneNumber: data.phoneNumber ?? null,
        })
        .returning()
        .get()

      return session
    }, "Couldn't create the session. Please try again.")
  )

export const deleteSession = createServerFn({ method: "POST" })
  .validator((data: { sessionId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const session = await db
        .select({ workspaceId: waSessions.workspaceId })
        .from(waSessions)
        .where(eq(waSessions.id, data.sessionId))
        .get()
      if (!session) throw new Error("Session not found")
      await requireWorkspaceAccess(session.workspaceId)
      await db.delete(waSessions).where(eq(waSessions.id, data.sessionId))
      return { ok: true }
    }, "Couldn't delete the session. Please try again.")
  )

async function callSessionWorker(
  sessionId: string,
  path: string,
  init?: RequestInit
) {
  // Every caller of this helper (connect / disconnect / status / ws-token /
  // group sync) takes only a sessionId -- the session must belong to the
  // caller's workspace, or anyone could mint a WebSocket token for (and
  // read the live traffic of) any number on the platform.
  const workspaceId = await requireCurrentPermission("manage_integrations")
  const db = getDb()
  const session = await db
    .select({ workspaceId: waSessions.workspaceId })
    .from(waSessions)
    .where(and(eq(waSessions.id, sessionId), eq(waSessions.workspaceId, workspaceId)))
    .get()
  if (!session) throw new Error("Session not found")

  const res = await fetchWaWorker(`/session/${sessionId}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${(env as any).ENGINE_INTERNAL_SECRET ?? ""}`,
      "X-Engine-Workspace": session.workspaceId,
      ...(init?.headers as Record<string, string> | undefined),
    },
  })

  const json: any = await res.json().catch(() => null)
  if (!res.ok || json?.ok === false) {
    throw new Error(
      json?.error ?? `Session worker request failed (${res.status})`
    )
  }
  return json
}

export const getSessionStatus = createServerFn({ method: "POST" })
  .validator((data: { sessionId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      return await callSessionWorker(data.sessionId, "")
    })
  )

export const connectSession = createServerFn({ method: "POST" })
  .validator(
    (data: {
      sessionId: string
      syncHistory?: boolean
      syncGroupMembers?: boolean
      // Force reconnect even if already connected — used by the QR dialog's
      // Retry path when the first attempt fails mid-handshake.
      force?: boolean
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireCurrentPermission("manage_integrations")
      return await callSessionWorker(data.sessionId, "/connect", {
        method: "POST",
        body: JSON.stringify({
          syncHistory: data.syncHistory,
          syncGroupMembers: data.syncGroupMembers,
          force: data.force,
        }),
      })
    })
  )

/** On-demand: pull one group's current member list and resolve every
 * participant into a CRM contact right now, regardless of whether the
 * session was connected with syncGroupMembers off. */
export const syncGroupMembersNow = createServerFn({ method: "POST" })
  .validator((data: { sessionId: string; groupJid: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireCurrentPermission("manage_integrations")
      return await callSessionWorker(data.sessionId, "/group-members-sync", {
        method: "POST",
        body: JSON.stringify({ groupJid: data.groupJid }),
      })
    })
  )

export const disconnectSession = createServerFn({ method: "POST" })
  .validator((data: { sessionId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireCurrentPermission("manage_integrations")
      return await callSessionWorker(data.sessionId, "/disconnect", {
        method: "POST",
      })
    })
  )

/**
 * Fetch a short-lived HMAC-signed WebSocket token for a session.
 * The token is generated server-side through the service binding so the
 * internal secret never reaches the browser. The browser then presents
 * this token when opening a WebSocket to the engine worker's /ws endpoint.
 */
export const getWsToken = createServerFn({ method: "POST" })
  .validator((data: { sessionId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      return await callSessionWorker(data.sessionId, "/ws-token")
    })
  )
