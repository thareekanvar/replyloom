import { describe, expect, it } from "vitest"
import { canAssignMember, hasPermission } from "@workspace/db"

describe("workspace permissions", () => {
  it("gives owners every permission", () => {
    expect(hasPermission("Owner", "manage_roles")).toBe(true)
  })

  it("uses the persisted permission set for non-owners", () => {
    expect(hasPermission("Agent", "assign_conversations", ["view_inbox"])).toBe(false)
    expect(hasPermission("Agent", "view_inbox", ["view_inbox"])).toBe(true)
  })

  it("lets agents assign conversations when their role grants it", () => {
    expect(hasPermission("Agent", "assign_conversations", ["assign_conversations"])).toBe(true)
  })

  it("rejects assignment to a member from another workspace", () => {
    expect(canAssignMember("workspace-a", "workspace-b")).toBe(false)
    expect(canAssignMember("workspace-a", "workspace-a")).toBe(true)
  })
})
