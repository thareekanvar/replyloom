import { z } from "zod"
import {
  PERSONALIZATION_REQUIRED_MESSAGE,
  isPersonalized,
} from "@/features/broadcasts/lib/confirm"

export const loginSchema = z.object({
  email: z.string().min(1, "Email is required").email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
})

export const signupSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().min(1, "Email is required").email("Invalid email address"),
  password: z
    .string()
    .min(1, "Password is required")
    .min(8, "Password must be at least 8 characters"),
})

export const createWorkspaceSchema = z.object({
  name: z.string().min(1, "Workspace name is required").trim(),
})

export const createSessionSchema = z.object({
  label: z.string().min(1, "Name is required").trim(),
  phoneNumber: z.string().optional(),
})

export const addContactSchema = z.object({
  waSessionId: z.string().min(1, "Please select a WhatsApp integration"),
  name: z.string().optional(),
  phoneNumber: z.string().min(1, "Phone number is required"),
  defaultCountryCode: z.string().optional(),
})

export const inviteMemberSchema = z.object({
  email: z
    .string()
    .min(1, "Email is required")
    .email("Invalid email address"),
  role: z.string().min(1, "Role is required"),
})

export const createWebhookSchema = z.object({
  url: z
    .string()
    .min(1, "URL is required")
    .url("Please enter a valid URL"),
  events: z.array(z.string()).min(1, "Select at least one event"),
})

export const createDealSchema = z.object({
  title: z.string().min(1, "Title is required").trim(),
  contactId: z.string().min(1, "Please select a contact"),
  stageId: z.string().min(1, "Please select a stage"),
  value: z.string().optional(),
})

export const createScheduledSchema = z.object({
  waSessionId: z.string().min(1, "Please select a session"),
  contactId: z.string().min(1, "Please select a contact"),
  body: z.string().min(1, "Message is required").trim(),
  sendAt: z.string().min(1, "Send time is required"),
})

export const createCampaignSchema = z.object({
  name: z.string().min(1, "Campaign name is required").trim(),
  waSessionId: z.string().min(1, "Please select a session"),
  messageText: z
    .string()
    .min(1, "Message is required")
    .trim()
    .refine(isPersonalized, PERSONALIZATION_REQUIRED_MESSAGE),
  // Campaigns target a contact list, never raw contact selection -- see
  // claude/broadcast-anti-spam-design-2026-09-23.md.
  contactListId: z.string().min(1, "Please select a contact list"),
  scheduledAt: z.string().optional(),
})

export const createAutoReplySchema = z.object({
  keyword: z.string().min(1, "Keyword is required").trim(),
  matchType: z.enum(["exact", "contains", "regex"]),
  context: z.enum(["group", "private", "all"]),
  replyText: z.string().min(1, "Reply text is required").trim(),
  waSessionId: z.string().optional(),
})

export const searchSchema = z.object({
  query: z.string().min(1, "Please enter a search term"),
})

export const roleFormSchema = z.object({
  name: z.string().min(1, "Role name is required").trim(),
  description: z.string(),
  permissions: z.array(z.string()),
})

// ── Form types (derived from schemas) ──

export type LoginInput = z.infer<typeof loginSchema>
export type SignupInput = z.infer<typeof signupSchema>
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>
export type CreateSessionInput = z.infer<typeof createSessionSchema>
export type AddContactInput = z.infer<typeof addContactSchema>
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>
export type CreateDealInput = z.infer<typeof createDealSchema>
export type CreateScheduledInput = z.infer<typeof createScheduledSchema>
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>
export type CreateAutoReplyInput = z.infer<typeof createAutoReplySchema>
export type SearchInput = z.infer<typeof searchSchema>
export type RoleFormInput = z.infer<typeof roleFormSchema>

// ── API types (what the server functions expect) ──

export interface BroadcastCampaignInput {
  waSessionId: string
  name: string
  messageText: string
  contactListId: string
  scheduledAt?: number
  mediaKey?: string
  confirmedRecipientCount?: number
}

export interface ScheduledMessageInput {
  waSessionId: string
  toJid: string
  body: string
  sendAt: number
}

export interface DealInput {
  stageId: string
  contactId: string
  title: string
  valueCents?: number
}
