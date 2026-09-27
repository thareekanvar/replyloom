import { createServerFn } from "@tanstack/react-start"
import { env } from "cloudflare:workers"
import {
  createDb,
  eq,
  and,
  inArray,
  desc,
  roles,
  member,
  user,
  invitation,
  organization,
  teams,
  teamMembers,
  PERMISSIONS,
} from "@workspace/db"
import { inviteMemberInput, createRoleInput, updateRoleInput, updateMemberRoleInput } from "@/lib/server-schemas"
import { UserFacingError, withSafeErrors } from "@/lib/errors"
import { escapeHtml } from "@/lib/html"
import { sendEmail } from "@/lib/resend"
import { toEpochSeconds } from "@/lib/dates"
import { requirePermission, requireWorkspaceAccess } from "@/lib/auth"
import { getSessionCached } from "@/lib/session-cache"

function getDb() {
  return createDb(env.DB)
}

export { PERMISSIONS }

const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key))

/** "Owner" is magic in hasPermission(), so it can't be created/renamed into. */
function sanitizeRoleInput(name: string | undefined, permissions: string[] | undefined) {
  if (name !== undefined && name.trim().toLowerCase() === "owner") {
    throw new UserFacingError('"Owner" is a reserved role name.')
  }
  if (permissions === undefined) return undefined
  return [...new Set(permissions.filter((p) => PERMISSION_KEYS.has(p)))]
}

/**
 * Privilege-escalation guard for anything that hands out a role (invite,
 * role change): the role must exist in this workspace, only an Owner can
 * grant Owner, and a non-owner can't grant a role carrying any permission
 * they don't hold themselves (an Admin can't mint someone with manage_roles).
 */
async function assertCanGrantRole(workspaceId: string, callerRole: string, targetRole: string) {
  const callerIsOwner = callerRole.toLowerCase() === "owner"
  if (targetRole.toLowerCase() === "owner" && !callerIsOwner) {
    throw new UserFacingError("Only an Owner can grant the Owner role.")
  }
  const rows = await getDb()
    .select({ name: roles.name, permissions: roles.permissions })
    .from(roles)
    .where(and(eq(roles.workspaceId, workspaceId), inArray(roles.name, [targetRole, callerRole])))
    .all()
  const target = rows.find((r) => r.name === targetRole)
  if (!target) throw new UserFacingError("That role does not belong to this workspace.")
  if (callerIsOwner) return
  const callerPerms = new Set(rows.find((r) => r.name === callerRole)?.permissions ?? [])
  if (target.permissions.some((p) => !callerPerms.has(p))) {
    throw new UserFacingError("You can't grant a role with more access than your own.")
  }
}

/** Non-owners can't change or remove an Owner. */
async function assertCanManageMember(workspaceId: string, callerRole: string, memberId: string) {
  const target = await getDb()
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.id, memberId), eq(member.organizationId, workspaceId)))
    .get()
  if (!target) throw new UserFacingError("Member not found.")
  if (target.role.toLowerCase() === "owner" && callerRole.toLowerCase() !== "owner") {
    throw new UserFacingError("Only an Owner can change or remove another Owner.")
  }
}

export const getTeams = createServerFn()
  .validator((data: { workspaceId: string }) => data)
  .handler(withSafeErrors(async ({ data }) => {
    await requireWorkspaceAccess(data.workspaceId)
    const db = getDb()
    // Two queries total (was 1 + one per team).
    const rows = await db.select().from(teams).where(eq(teams.workspaceId, data.workspaceId)).all()
    if (rows.length === 0) return []
    const links = await db
      .select({ teamId: teamMembers.teamId, userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(eq(teams.workspaceId, data.workspaceId))
      .all()
    const byTeam = new Map<string, { userId: string }[]>()
    for (const l of links) {
      const list = byTeam.get(l.teamId) ?? []
      list.push({ userId: l.userId })
      byTeam.set(l.teamId, list)
    }
    return rows.map((team) => ({ ...team, members: byTeam.get(team.id) ?? [] }))
  }))

export const createTeam = createServerFn({ method: "POST" })
  .validator((data: { workspaceId: string; name: string; description?: string }) => data)
  .handler(withSafeErrors(async ({ data }) => {
    await requirePermission(data.workspaceId, "manage_members")
    return getDb().insert(teams).values({ workspaceId: data.workspaceId, name: data.name.trim(), description: data.description?.trim() || null }).returning().get()
  }, "Couldn't create the team. Its name might already be in use."))

export const setTeamMembers = createServerFn({ method: "POST" })
  .validator((data: { workspaceId: string; teamId: string; userIds: string[] }) => {
    if (!Array.isArray(data.userIds) || data.userIds.length > 500) {
      throw new Error("A team can have at most 500 members.")
    }
    return data
  })
  .handler(withSafeErrors(async ({ data }) => {
    await requirePermission(data.workspaceId, "manage_members")
    const db = getDb()
    const team = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, data.teamId), eq(teams.workspaceId, data.workspaceId))).get()
    if (!team) throw new Error("Team not found.")
    if (data.userIds.length) {
      // Unique ids, then inArray() in 90-id chunks -- D1 caps a statement at
      // 100 bound parameters, so one inArray() over an unbounded list would
      // start failing past ~98 users.
      const wanted = Array.from(new Set(data.userIds))
      const found = new Set<string>()
      for (let i = 0; i < wanted.length; i += 90) {
        const chunk = wanted.slice(i, i + 90)
        const rows = await db
          .select({ userId: member.userId })
          .from(member)
          .where(and(eq(member.organizationId, data.workspaceId), inArray(member.userId, chunk)))
          .all()
        for (const r of rows) found.add(r.userId)
      }
      if (found.size !== wanted.length) throw new Error("Every team member must belong to this workspace.")
    }
    // One atomic batch: replace the membership set.
    const userIds = Array.from(new Set(data.userIds))
    await db.batch([
      db.delete(teamMembers).where(eq(teamMembers.teamId, data.teamId)),
      // 2 bound params per row; chunk to stay under D1's 100-param cap.
      ...Array.from({ length: Math.ceil(userIds.length / 40) }, (_, i) =>
        db.insert(teamMembers).values(userIds.slice(i * 40, i * 40 + 40).map((userId) => ({ teamId: data.teamId, userId })))
      ),
    ])
    return { ok: true }
  }, "Couldn't update the team members."))

// ── Roles ──────────────────────────────────────────────────────────────

export const getRoles = createServerFn()
  .validator((data: { workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      return db
        .select()
        .from(roles)
        .where(eq(roles.workspaceId, data.workspaceId))
        .orderBy(desc(roles.isDefault))
        .all()
    })
  )

export const createRole = createServerFn({ method: "POST" })
  .validator(createRoleInput)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_roles")
      const permissions = sanitizeRoleInput(data.name, data.permissions) ?? []
      const db = getDb()
      const role = await db
        .insert(roles)
        .values({
          workspaceId: data.workspaceId,
          name: data.name.trim(),
          description: data.description?.trim() || null,
          permissions,
        })
        .returning()
        .get()
      return role
    }, "Couldn't create the role. Its name might already be in use.")
  )

export const updateRole = createServerFn({ method: "POST" })
  .validator(updateRoleInput)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_roles")
      const db = getDb()
      const { roleId, workspaceId, ...updates } = data
      const existing = await db.select({ name: roles.name }).from(roles).where(and(eq(roles.id, roleId), eq(roles.workspaceId, workspaceId))).get()
      if (!existing) throw new Error("Role not found.")
      if (existing.name.toLowerCase() === "owner") throw new UserFacingError("The Owner role can't be edited.")
      updates.permissions = sanitizeRoleInput(updates.name, updates.permissions)
      const fields: Record<string, unknown> = {}
      if (updates.name !== undefined) fields.name = updates.name.trim()
      if (updates.description !== undefined)
        fields.description = updates.description.trim() || null
      if (updates.permissions !== undefined)
        fields.permissions = updates.permissions
      if (Object.keys(fields).length === 0) return null

      await db.update(roles).set(fields).where(and(eq(roles.id, roleId), eq(roles.workspaceId, workspaceId)))
      if (updates.name !== undefined && updates.name.trim() !== existing.name) {
        await db.update(member).set({ role: updates.name.trim() }).where(and(eq(member.organizationId, workspaceId), eq(member.role, existing.name)))
      }
      return { ok: true }
    }, "Couldn't update the role. Please try again.")
  )

export const deleteRole = createServerFn({ method: "POST" })
  .validator((data: { roleId: string; workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_roles")
      const db = getDb()
      const role = await db
        .select()
        .from(roles)
        .where(eq(roles.id, data.roleId))
        .get()
      if (!role) return { ok: true }
      if (role.isDefault)
        throw new Error(
          "The built-in Owner/Admin/Agent/Viewer roles can't be deleted."
        )

      const inUse = await db
        .select({ userId: member.userId })
        .from(member)
        .where(
          and(
            eq(member.organizationId, data.workspaceId),
            eq(member.role, role.name)
          )
        )
        .get()
      if (inUse)
        throw new Error(
          `"${role.name}" is still assigned to a team member — reassign them first.`
        )

      await db.delete(roles).where(eq(roles.id, data.roleId))
      return { ok: true }
    }, "Couldn't delete the role. Please try again.")
  )

// ── Members ────────────────────────────────────────────────────────────

export const getMembers = createServerFn()
  .validator((data: { workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      return db
        .select({
          userId: member.userId,
          role: member.role,
          name: user.name,
          email: user.email,
          memberId: member.id,
        })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(eq(member.organizationId, data.workspaceId))
        .all()
    })
  )

export const updateMemberRole = createServerFn({ method: "POST" })
  .validator(updateMemberRoleInput)
  .handler(
    withSafeErrors(async ({ data }) => {
      const { role: callerRole } = await requirePermission(data.workspaceId, "manage_members")
      await assertCanManageMember(data.workspaceId, callerRole, data.memberId)
      await assertCanGrantRole(data.workspaceId, callerRole, data.role)
      const db = getDb()
      await db
        .update(member)
        .set({ role: data.role })
        .where(and(eq(member.id, data.memberId), eq(member.organizationId, data.workspaceId)))
      return { ok: true }
    }, "Couldn't update this member's role. Please try again.")
  )

export const removeMember = createServerFn({ method: "POST" })
  .validator((data: { workspaceId: string; memberId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const { role: callerRole } = await requirePermission(data.workspaceId, "manage_members")
      await assertCanManageMember(data.workspaceId, callerRole, data.memberId)
      const db = getDb()
      await db.delete(member).where(and(eq(member.id, data.memberId), eq(member.organizationId, data.workspaceId)))
      return { ok: true }
    }, "Couldn't remove this member. Please try again.")
  )

// ── Invitations ────────────────────────────────────────────────────────
//
// Deliberately not using Better Auth's own createInvitation/acceptInvitation
// endpoints: those validate `role` against a fixed "owner"|"admin"|"member"
// set (or roles pre-registered in code via its access-control API), which
// would reject any of our dynamic, user-created role names. The
// `invitation` table is already schema-compatible with Better Auth's own
// shape (see packages/db/src/schema/auth.ts) — we just read and write it
// directly instead, and send the email ourselves via Resend.

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

export const getInvitations = createServerFn()
  .validator((data: { workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_members")
      const db = getDb()
      const rows = await db
        .select()
        .from(invitation)
        .where(
          and(
            eq(invitation.organizationId, data.workspaceId),
            eq(invitation.status, "pending")
          )
        )
        .orderBy(desc(invitation.createdAt))
        .all()
      return rows.map((r) => ({
        ...r,
        createdAt: toEpochSeconds(r.createdAt)!,
        expiresAt: toEpochSeconds(r.expiresAt)!,
      }))
    })
  )

export const inviteMember = createServerFn({ method: "POST" })
  .validator(inviteMemberInput)
  .handler(
    withSafeErrors(async ({ data }) => {
      // Inviter identity + authority come from the session, never the body.
      const { userId: inviterId, role: callerRole } = await requirePermission(data.workspaceId, "manage_members")
      await assertCanGrantRole(data.workspaceId, callerRole, data.role)
      const db = getDb()
      const email = data.email

      const alreadyMember = await db
        .select({ userId: member.userId })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(
          and(
            eq(member.organizationId, data.workspaceId),
            eq(user.email, email)
          )
        )
        .get()
      if (alreadyMember)
        throw new Error("This person is already a member of the workspace.")

      const org = await db
        .select()
        .from(organization)
        .where(eq(organization.id, data.workspaceId))
        .get()
      if (!org) throw new Error("Workspace not found.")

      const invite = await db
        .insert(invitation)
        .values({
          id: crypto.randomUUID(),
          email,
          inviterId,
          organizationId: data.workspaceId,
          role: data.role,
          status: "pending",
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + INVITE_EXPIRY_MS),
        })
        .returning()
        .get()

      const acceptUrl = `${env.BETTER_AUTH_URL}/accept-invite?id=${invite.id}`
      await sendEmail({
        to: email,
        subject: `You've been invited to join ${org.name.replace(/[\r\n]+/g, " ")}`,
        html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
          <h2>You're invited to ${escapeHtml(org.name)}</h2>
          <p>You've been invited to join as <strong>${escapeHtml(data.role)}</strong>.</p>
          <p><a href="${acceptUrl}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">Accept invitation</a></p>
          <p style="color:#666;font-size:13px">This invite expires in 7 days. If the button doesn't work, copy this link: ${acceptUrl}</p>
        </div>
      `,
      })

      return invite
    }, "Couldn't send the invitation. Please try again.")
  )

export const cancelInvitation = createServerFn({ method: "POST" })
  .validator((data: { workspaceId: string; invitationId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_members")
      const db = getDb()
      await db
        .update(invitation)
        .set({ status: "canceled" })
        .where(
          and(
            eq(invitation.id, data.invitationId),
            eq(invitation.organizationId, data.workspaceId)
          )
        )
      return { ok: true }
    }, "Couldn't cancel the invitation. Please try again.")
  )

// Read by the (possibly signed-out) recipient of an invite link, so it
// can't require a session -- but it must never dump the whole row (org id,
// expiry, metadata) for an arbitrary UUID. Only what the accept screen
// renders is returned; acceptInvitation re-checks everything that matters.
export const getInvitationById = createServerFn()
  .validator((data: { invitationId: string }) => {
    if (typeof data.invitationId !== "string" || data.invitationId.length > 64) {
      throw new Error("Invalid invitation.")
    }
    return data
  })
  .handler(
    withSafeErrors(async ({ data }) => {
      // Public (the invitee may not have an account yet), so it's a
      // capability-URL lookup: return only what the accept page renders --
      // never inviter ids, org ids or timestamps -- and mask the email so a
      // leaked link doesn't disclose who was invited.
      const db = getDb()
      const invite = await db
        .select({
          email: invitation.email,
          role: invitation.role,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
          organizationName: organization.name,
        })
        .from(invitation)
        .leftJoin(organization, eq(organization.id, invitation.organizationId))
        .where(eq(invitation.id, data.invitationId))
        .get()
      if (!invite) return null
      const expired = new Date(invite.expiresAt).getTime() < Date.now()
      const session = await getSessionCached()
      const sessionEmail = session?.user.email.toLowerCase() ?? null
      const emailMatches = sessionEmail === null ? null : sessionEmail === invite.email.toLowerCase()
      const [local = "", domain = ""] = invite.email.split("@")
      return {
        // Full address only to its owner; everyone else sees it masked.
        email: emailMatches
          ? invite.email
          : `${local.slice(0, 2)}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`,
        emailMatches,
        role: invite.role,
        status: expired && invite.status === "pending" ? ("expired" as const) : invite.status,
        organizationName: invite.organizationName ?? "this workspace",
      }
    })
  )

export const acceptInvitation = createServerFn({ method: "POST" })
  .validator(
    (data: { invitationId: string; userId: string; userEmail: string }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const invite = await db
        .select()
        .from(invitation)
        .where(eq(invitation.id, data.invitationId))
        .get()
      if (!invite) throw new Error("This invitation no longer exists.")
      if (invite.status !== "pending")
        throw new Error("This invitation has already been used or canceled.")
      if (new Date(invite.expiresAt).getTime() < Date.now())
        throw new Error("This invitation has expired.")
      // Identity comes from the session, never from the request body -- the
      // old code let any caller holding an invite id add an arbitrary userId.
      const session = await getSessionCached()
      if (!session) throw new Error("Please sign in to accept this invitation.")
      const sessionUserId = session.user.id
      if (invite.email.toLowerCase() !== session.user.email.toLowerCase()) {
        throw new Error(
          "This invitation was sent to a different email address."
        )
      }

      await db.insert(member).values({
        id: crypto.randomUUID(),
        userId: sessionUserId,
        organizationId: invite.organizationId,
        role: invite.role ?? "Viewer",
        createdAt: new Date(),
      })
      await db
        .update(invitation)
        .set({ status: "accepted" })
        .where(eq(invitation.id, data.invitationId))

      return { ok: true, workspaceId: invite.organizationId }
    }, "Couldn't accept the invitation. Please try again.")
  )
