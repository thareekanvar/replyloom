/**
 * Catalog of permission strings a workspace's custom roles can grant.
 * Purely descriptive today (nothing in the app enforces these yet) — the
 * Roles UI lets a workspace owner assign them per role so enforcement can
 * be layered in later without a schema or data migration.
 */
export interface PermissionDef {
  key: string
  label: string
  description: string
}

export const PERMISSIONS: PermissionDef[] = [
  { key: "manage_members", label: "Manage team", description: "Invite teammates, change roles, remove members." },
  { key: "manage_roles", label: "Manage roles", description: "Create and edit custom roles and their permissions." },
  { key: "manage_integrations", label: "Manage integrations", description: "Connect, disconnect or delete WhatsApp numbers." },
  { key: "manage_contacts", label: "Manage contacts", description: "Edit, delete and bulk-import contacts." },
  { key: "send_messages", label: "Send messages", description: "Reply in the inbox and send scheduled messages." },
  { key: "manage_broadcasts", label: "Manage broadcasts", description: "Create and send broadcast campaigns." },
  { key: "manage_settings", label: "Manage workspace settings", description: "Auto-reply rules, webhooks and workspace configuration." },
  { key: "view_inbox", label: "View inbox", description: "Read conversations and contact history." },
  { key: "assign_conversations", label: "Assign conversations", description: "Assign conversations and leads to workspace members." },
]

export const DEFAULT_ROLE_PRESETS: { name: string; description: string; permissions: string[] }[] = [
  {
    name: "Owner",
    description: "Full access to everything in this workspace.",
    permissions: PERMISSIONS.map((p) => p.key),
  },
  {
    name: "Admin",
    description: "Can manage the team, integrations and all CRM data.",
    permissions: PERMISSIONS.map((p) => p.key).filter((k) => k !== "manage_roles"),
  },
  {
    name: "Agent",
    description: "Handles conversations, contacts and broadcasts day to day.",
    permissions: ["view_inbox", "send_messages", "assign_conversations", "manage_contacts", "manage_broadcasts"],
  },
  {
    name: "Viewer",
    description: "Read-only access to the inbox and contacts.",
    permissions: ["view_inbox"],
  },
]

/** Returns true when a role is allowed to perform the requested operation. */
export function hasPermission(roleName: string | null | undefined, permission: string, rolePermissions: string[] = []) {
  if (roleName?.toLowerCase() === "owner") return true
  return rolePermissions.includes(permission)
}

/** Only workspace members can be assigned CRM ownership. */
export function canAssignMember(memberWorkspaceId: string | null | undefined, workspaceId: string) {
  return !!memberWorkspaceId && memberWorkspaceId === workspaceId
}
