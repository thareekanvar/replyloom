import { describe, it, expect } from "vitest"
import { filterBroadcastContacts } from "./filter-broadcast-contacts.ts"

const contacts = [
  {
    id: "1",
    name: "Alice Johnson",
    phoneNumber: "+919999000111",
    jid: "alice@s.whatsapp.net",
  },
  {
    id: "2",
    name: "Bob Smith",
    phoneNumber: "+919999000222",
    jid: "bob@s.whatsapp.net",
  },
]

describe("filterBroadcastContacts", () => {
  it("matches contact name, phone number, and JID case-insensitively", () => {
    expect(filterBroadcastContacts(contacts, "JOHN")).toEqual([contacts[0]])
    expect(filterBroadcastContacts(contacts, "000222")).toEqual([contacts[1]])
    expect(filterBroadcastContacts(contacts, "BOB@S.WHATSAPP.NET")).toEqual([
      contacts[1],
    ])
  })

  it("returns all contacts for an empty search", () => {
    expect(filterBroadcastContacts(contacts, "  ")).toEqual(contacts)
  })
})
