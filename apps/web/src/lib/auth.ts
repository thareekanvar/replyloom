import { createServerFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import {
  createDb,
  eq,
  and,
  desc,
  member,
  roles,
  invitation,
  DEFAULT_ROLE_PRESETS,
  hasPermission,
} from "@workspace/db"
import { env } from "cloudflare:workers"
import { auth } from "./auth-server"
import { UserFacingError, toSafeError } from "./errors"
import { memoPerRequest } from "./request-cache"
import { getMembershipCached, getSessionCached } from "./session-cache"

// Every new user gets a personal workspace ("organization" in Better
// Auth's own terms — see packages/db/src/schema/auth.ts) on first
// sign-up. Created through the organization plugin's API (not a raw
// insert) so its own bookkeeping — creating the owner `member` row,
// running its hooks — happens the same way it would for any
// programmatically- or UI-created organization.
async function ensureWorkspace(userId: string, userName: string) {
  const existing = await getWorkspaceId(userId)
  if (existing) return existing

  const slug =
    userName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") +
    "-" +
    crypto.randomUUID().slice(0, 8)

  // `userId` is accepted here specifically for server-only,
  // session-less creation (e.g. right after sign-up, before any
  // session cookie exists in this request) — see Better Auth's
  // organization plugin docs. The creator is made "owner" automatically.
  const org = await auth.api.createOrganization({
    body: { name: `${userName}'s Workspace`, slug, userId },
  })
  // Better Auth's type says this always returns an organization, but the
  // actual implementation can resolve to a falsy value on failure.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!org) throw new Error("createOrganization returned no organization")

  await seedDefaultRoles(org.id)
  // The org plugin creates the owner's `member` row with its own static
  // "owner" role — line it up with our seeded "Owner" role name so the
  // Team settings page shows one consistent role, not two spellings of
  // the same thing.
  const db = createDb(env.DB)
  await db
    .update(member)
    .set({ role: "Owner" })
    .where(eq(member.userId, userId))

  return org.id
}

/** Seeds the Owner/Admin/Agent/Viewer starter roles for a brand-new workspace. */
async function seedDefaultRoles(workspaceId: string) {
  const db = createDb(env.DB)
  await db.insert(roles).values(
    DEFAULT_ROLE_PRESETS.map((preset) => ({
      workspaceId,
      name: preset.name,
      description: preset.description,
      permissions: preset.permissions,
      isDefault: true,
    }))
  )
}

async function getWorkspaceId(userId: string) {
  const db = createDb(env.DB)
  // Most-recently-joined membership wins. This app doesn't have a
  // workspace switcher yet, so when someone belongs to more than one
  // (their own personal workspace, plus any they've since accepted an
  // invite into) the one they joined most recently is the reasonable
  // default — almost always the one they actually meant to land in.
  const membership = await db
    .select({ workspaceId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .orderBy(desc(member.createdAt))
    .get()
  return membership?.workspaceId ?? null
}

/**
 * Joins `userId` to the workspace an invitation points at, validating the
 * invite the same way features/team/hooks/use-team.ts's acceptInvitation
 * does (kept in sync deliberately, not imported from there, to keep this
 * lib module — used from signup/login — independent of the features/
 * layer). Returns the joined workspace id.
 */
async function applyInvitation(
  inviteId: string,
  userId: string,
  userEmail: string
): Promise<string> {
  const db = createDb(env.DB)
  const invite = await db
    .select()
    .from(invitation)
    .where(eq(invitation.id, inviteId))
    .get()
  if (!invite) throw new Error("This invitation no longer exists.")
  if (invite.status !== "pending")
    throw new Error("This invitation has already been used or canceled.")
  if (new Date(invite.expiresAt).getTime() < Date.now())
    throw new Error("This invitation has expired.")
  if (invite.email.toLowerCase() !== userEmail.toLowerCase()) {
    throw new Error("This invitation was sent to a different email address.")
  }

  await db.insert(member).values({
    id: crypto.randomUUID(),
    userId,
    organizationId: invite.organizationId,
    role: invite.role ?? "Viewer",
    createdAt: new Date(),
  })
  await db
    .update(invitation)
    .set({ status: "accepted" })
    .where(eq(invitation.id, inviteId))

  return invite.organizationId
}

function toAuthUser(u: {
  id: string
  name: string
  email: string
  image?: string | null
}): AuthUser {
  return { id: u.id, name: u.name, email: u.email, avatarUrl: u.image ?? null }
}

/**
 * Brake on credential stuffing / sign-up spam. login/signup call
 * auth.api.* directly (not over HTTP), so Better Auth's own in-memory
 * limiter never runs for them -- this is the real gate. Keyed per IP and
 * per email so neither a botnet on one account nor one IP across many
 * accounts gets through. Fails open if the binding is missing/erroring.
 */
async function enforceAuthRateLimit(email: string) {
  const limiter = (env as { AUTH_RATE_LIMITER?: RateLimit }).AUTH_RATE_LIMITER
  if (!limiter) return
  let ip = "unknown"
  try {
    ip = getRequestHeaders().get("cf-connecting-ip") ?? "unknown"
  } catch {
    /* no request context */
  }
  const keys = [`ip:${ip}`, `email:${email.trim().toLowerCase()}`]
  for (const key of keys) {
    try {
      const { success } = await limiter.limit({ key })
      if (!success) throw new UserFacingError("Too many attempts. Please wait a minute and try again.")
    } catch (err) {
      if (err instanceof UserFacingError) throw err
    }
  }
}

export const signup = createServerFn({ method: "POST" })
  .validator(
    (data: {
      email: string
      password: string
      name: string
      inviteId?: string
    }) => data
  )
  .handler(async ({ data }) => {
    try {
      await enforceAuthRateLimit(data.email)
      // Cookie-setting is handled automatically by the tanstackStartCookies()
      // plugin registered in auth-server.ts — no manual header plumbing here.
      const { user } = await auth.api.signUpEmail({
        body: { email: data.email, password: data.password, name: data.name },
      })

      // Signing up from an invite link joins that workspace instead of
      // spinning up a brand-new personal one for them.
      const workspaceId = data.inviteId
        ? await applyInvitation(data.inviteId, user.id, user.email)
        : await ensureWorkspace(user.id, user.name)

      return { user: toAuthUser(user), workspaceId }
    } catch (err) {
      throw toSafeError(err, "Couldn't create your account. Please try again.")
    }
  })

export const login = createServerFn({ method: "POST" })
  .validator(
    (data: { email: string; password: string; inviteId?: string }) => data
  )
  .handler(async ({ data }) => {
    try {
      await enforceAuthRateLimit(data.email)
      const { user } = await auth.api.signInEmail({
        body: { email: data.email, password: data.password },
      })

      if (data.inviteId) {
        // Best-effort: an existing user following a stale/foreign invite
        // link should still be able to log in normally, just without
        // joining anything.
        try {
          await applyInvitation(data.inviteId, user.id, user.email)
        } catch (err) {
          console.error(err)
        }
      }

      const workspaceId = await getWorkspaceId(user.id)

      return { user: toAuthUser(user), workspaceId }
    } catch (err) {
      throw toSafeError(err, "Couldn't sign you in. Please try again.")
    }
  })

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  try {
    await auth.api.signOut({ headers: getRequestHeaders() })
  } catch (err) {
    // Best-effort: the user is leaving either way, so just log it — never
    // block sign-out on a server hiccup.
    console.error(err)
  }
  return { ok: true }
})

export const getCurrentUser = createServerFn().handler(() =>
  memoPerRequest("auth:currentUser", resolveCurrentUser)
)

async function resolveCurrentUser() {
  try {
    const result = await getSessionCached()
    if (!result) return null

    const workspaceId = await resolveActiveWorkspaceId(
      result.user.id,
      result.session.activeOrganizationId
    )
    // A valid, authenticated session can still have no workspace membership
    // -- e.g. they were removed from their last workspace, or (as switching
    // local dev to `remote: true` D1 can surface) their membership row
    // lives in a different D1 than the one this request now reads from.
    // That's a real logged-in state, not "not signed in", so callers must
    // not treat a null workspaceId here the same as a null session. The
    // route guard (_app.tsx) sends these users to /create-workspace instead
    // of silently generating one for them or bouncing them to /login.
    return { user: toAuthUser(result.user), workspaceId }
  } catch (err) {
    // A DB hiccup here shouldn't surface as a scary error screen — treat it
    // like "not signed in" and let the route guard redirect to /login.
    console.error(err)
    return null
  }
}

/**
 * For server functions that take a record id but no workspaceId: resolves
 * the caller's workspace (or throws). Callers MUST also scope their
 * query/update by it -- e.g. `and(eq(contacts.id, id), eq(contacts.workspaceId, ws))`.
 * These functions used to skip auth entirely (withSafeErrors only checks
 * inputs that carry a workspaceId).
 */
export async function requireCurrentWorkspaceId() {
  const current = await getCurrentUser()
  if (!current?.workspaceId) throw new Error("Unauthorized")
  return current.workspaceId
}

/** Current workspace + a permission check, for endpoints without a workspaceId arg. */
export async function requireCurrentPermission(permission: string) {
  const workspaceId = await requireCurrentWorkspaceId()
  await requirePermission(workspaceId, permission)
  return workspaceId
}

/**
 * Checks that a client-supplied workspace belongs to the authenticated
 * session. Server functions must use this before reading or mutating any
 * workspace-scoped data; route guards alone are not sufficient.
 */
export async function requireWorkspaceAccess(workspaceId: string) {
  const current = await getCurrentUser()
  if (!current?.workspaceId || current.workspaceId !== workspaceId) {
    throw new Error("Unauthorized")
  }
  return current.workspaceId
}

/** Checks both workspace membership and the persisted custom-role permission. */
export async function requirePermission(workspaceId: string, permission: string) {
  const current = await getCurrentUser()
  // Authorization gate -- keep the full defensive chain here even where a
  // field is currently typed as always-present; a future change to
  // getCurrentUser() that makes it optional again must not silently drop
  // this check.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!current?.user?.id || !current.workspaceId || current.workspaceId !== workspaceId) {
    throw new Error("Unauthorized")
  }
  const db = createDb(env.DB)
  const membership = await getMembershipCached(current.user.id, workspaceId)
  if (!membership) throw new Error("Unauthorized")
  const customRole = await db
    .select({ permissions: roles.permissions })
    .from(roles)
    .where(and(eq(roles.workspaceId, workspaceId), eq(roles.name, membership.role)))
    .get()
  if (!hasPermission(membership.role, permission, customRole?.permissions ?? [])) {
    throw new Error("You do not have permission to perform this action.")
  }
  return { userId: current.user.id, role: membership.role }
}

/**
 * Resolves which workspace the app should treat as "current" for this
 * request. The workspace switcher (features/workspaces) sets Better
 * Auth's own `session.activeOrganizationId` via `setActiveOrganization`
 * -- prefer that when it points at a workspace the user is still
 * actually a member of (they could have been removed from it, or it
 * could have been deleted, since it was made active), and fall back to
 * `getWorkspaceId`'s most-recently-joined heuristic otherwise.
 */
export async function resolveActiveWorkspaceId(
  userId: string,
  activeOrganizationId: string | null | undefined
) {
  if (activeOrganizationId) {
    // Same cached lookup withSafeErrors/requirePermission use -- one member
    // query per request instead of one per check.
    const stillMember = await getMembershipCached(userId, activeOrganizationId)
    if (stillMember) return activeOrganizationId
  }
  return getWorkspaceId(userId)
}

export type AuthUser = {
  id: string
  name: string | null
  email: string
  avatarUrl: string | null
}
export type AuthContext = { user: AuthUser; workspaceId: string }
