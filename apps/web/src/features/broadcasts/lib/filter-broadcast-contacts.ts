export interface BroadcastContactSearchable {
  name: string | null
  phoneNumber: string | null
  jid: string
}

export function filterBroadcastContacts<T extends BroadcastContactSearchable>(
  contacts: T[],
  search: string
) {
  const query = search.trim().toLowerCase()
  if (!query) return contacts

  return contacts.filter((contact) =>
    [contact.name, contact.phoneNumber, contact.jid]
      .filter(Boolean)
      .some((field) => field!.toLowerCase().includes(query))
  )
}
