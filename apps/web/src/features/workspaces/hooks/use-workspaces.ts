import { createServerFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { env } from "cloudflare:workers"
import {
  createDb,
  eq,
  and,
  member,
  roles,
  DEFAULT_ROLE_PRESETS,
} from "@workspace/db"
import { auth } from "@/lib/auth-server"
import { resolveActiveWorkspaceId } from "@/lib/auth"
import { withSafeErrors } from "@/lib/errors"

function getDb() {
  return createDb(env.DB)
}

async function requireSession() {
  const result = await auth.api.getSession({ headers: getRequestHeaders() })
  if (!result) throw new Error("You need to sign in again.")
  return result
}

/** Every workspace the signed-in user belongs to, with their role in each
 * and which one is currently active (per Better Auth's own
 * `session.activeOrganizationId` -- see lib/auth.ts, which reads the same
 * field to resolve the workspace for the rest of the app). */
export const getMyWorkspaces = createServerFn().handler(
  withSafeErrors(async () => {
    const session = await requireSession()
    const orgs = await auth.api.listOrganizations({
      headers: getRequestHeaders(),
    })

    const db = getDb()
    const memberships = await db
      .select({ organizationId: member.organizationId, role: member.role })
      .from(member)
      .where(eq(member.userId, session.user.id))
      .all()
    const roleByOrg = new Map(
      memberships.map((m) => [m.organizationId, m.role])
    )

    // Same resolution the rest of the app uses (see getCurrentUser in
    // lib/auth.ts) -- session.activeOrganizationId is only ever set once
    // someone has explicitly switched, so a fresh account with no switch
    // yet needs the same "most recently joined" fallback here too,
    // otherwise this list would show no workspace as active at all.
    const activeWorkspaceId = await resolveActiveWorkspaceId(
      session.user.id,
      session.session.activeOrganizationId
    )

    return orgs
      .map((org) => ({
        id: org.id,
        name: org.name,
        // Better Auth's Organization type says `slug` is required, but
        // it's an optional column in practice across versions -- keep
        // the fallback.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        slug: org.slug ?? null,
        role: roleByOrg.get(org.id) ?? "member",
        active: org.id === activeWorkspaceId,
      }))
      .sort((a, b) =>
        a.active === b.active ? a.name.localeCompare(b.name) : a.active ? -1 : 1
      )
  })
)

/** Creates a new workspace owned by the signed-in user and, since this
 * runs with a real session (unlike the sign-up flow's userId-only variant
 * in lib/auth.ts), Better Auth makes it the active workspace automatically. */
export const createWorkspace = createServerFn({ method: "POST" })
  .validator((data: { name: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const session = await requireSession()
      const name = data.name.trim()
      if (!name) throw new Error("Workspace name can't be empty.")

      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "") +
        "-" +
        crypto.randomUUID().slice(0, 8)

      const org = await auth.api.createOrganization({
        headers: getRequestHeaders(),
        body: { name, slug },
      })
      // Better Auth's type says this always returns an organization, but
      // the actual implementation can resolve to a falsy value on failure
      // (same defensive check as lib/auth.ts's seedWorkspaceForUser).
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!org) throw new Error("Couldn't create the workspace.")

      const db = getDb()
      await db.insert(roles).values(
        DEFAULT_ROLE_PRESETS.map((preset) => ({
          workspaceId: org.id,
          name: preset.name,
          description: preset.description,
          permissions: preset.permissions,
          isDefault: true,
        }))
      )
      // Line up with the seeded "Owner" role name (see lib/auth.ts's
      // ensureWorkspace, kept in sync deliberately) instead of the org
      // plugin's own static "owner" string, so Team settings shows one
      // consistent spelling either way a workspace gets created.
      await db
        .update(member)
        .set({ role: "Owner" })
        .where(
          and(
            eq(member.userId, session.user.id),
            eq(member.organizationId, org.id)
          )
        )

      return { id: org.id, name: org.name, slug: org.slug }
    }, "Couldn't create the workspace. Please try again.")
  )

/** Switches the signed-in user's active workspace. The app re-reads
 * `session.activeOrganizationId` on next load (see getCurrentUser in
 * lib/auth.ts), so callers should reload/navigate after this resolves. */
export const switchWorkspace = createServerFn({ method: "POST" })
  .validator((data: { organizationId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireSession()
      const result = await auth.api.setActiveOrganization({
        headers: getRequestHeaders(),
        body: { organizationId: data.organizationId },
      })
      if (!result) throw new Error("Couldn't switch workspaces.")
      return { ok: true }
    }, "Couldn't switch workspaces. Please try again.")
  )
