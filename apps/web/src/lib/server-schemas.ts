/**
 * Runtime input schemas for server functions. `.validator((d: T) => d)` is
 * only a compile-time cast -- anything can arrive over the wire -- so the
 * sensitive mutations parse with zod (unknown keys stripped, sizes bounded).
 */
import { z } from "zod"

const id = z.string().min(1).max(128)
const workspaceId = id
const roleName = z.string().trim().min(1).max(50)

export const inviteMemberInput = z.object({
  workspaceId,
  email: z.string().trim().toLowerCase().email().max(254),
  role: roleName,
  inviterId: z.string().optional(),
})

export const createRoleInput = z.object({
  workspaceId,
  name: roleName,
  description: z.string().max(300).optional(),
  permissions: z.array(z.string().max(64)).max(50),
})

export const updateRoleInput = z.object({
  roleId: id,
  workspaceId,
  name: roleName.optional(),
  description: z.string().max(300).optional(),
  permissions: z.array(z.string().max(64)).max(50).optional(),
})

export const updateMemberRoleInput = z.object({ workspaceId, memberId: id, role: roleName })

export const createWebhookInput = z.object({
  workspaceId,
  url: z.string().trim().url().max(2048),
  events: z.array(z.string().max(64)).min(1).max(20),
})

const ruleFields = {
  waSessionId: id.optional(),
  keyword: z.string().min(1).max(200),
  matchType: z.enum(["exact", "contains", "regex"]),
  context: z.enum(["group", "private", "all"]),
  replyText: z.string().min(1).max(4096),
}
export const createAutoReplyRuleInput = z.object({ workspaceId, ...ruleFields })
export const updateAutoReplyRuleInput = z.object({ id, ...ruleFields })

export const createCampaignInput = z.object({
  workspaceId,
  waSessionId: id,
  name: z.string().trim().min(1).max(200),
  messageText: z.string().min(1).max(4096),
  contactListId: id,
  scheduledAt: z.number().int().positive().optional(),
  mediaKey: z.string().max(512).optional(),
  confirmedRecipientCount: z.number().int().nonnegative().optional(),
})
