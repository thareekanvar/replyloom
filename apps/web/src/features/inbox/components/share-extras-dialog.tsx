import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@workspace/ui/components/tabs"
import {
  BarChart3Icon,
  Loader2Icon,
  LocateFixedIcon,
  MapPinIcon,
  PlusIcon,
  SendIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { searchContacts } from "@/features/contacts/hooks/use-contacts"
import { useDebouncedValue } from "@/hooks/use-debounced-value"

function contactVCard(name: string, phoneNumber: string | null): string {
  const digits = (phoneNumber ?? "").replace(/[^\d+]/g, "")
  const tel = digits || phoneNumber || ""
  return `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL;type=VOICE;waid=${digits.replace("+", "")}:${tel}\nEND:VCARD`
}

/** One dialog, three tabs -- poll, location, contact card -- for the
 * composer's "share more than text" options that don't fit the file
 * attach flow (MediaSendDialog). Each tab sends immediately on submit,
 * same as picking a file does. */
export function ShareExtrasDialog({
  open,
  onOpenChange,
  workspaceId,
  defaultTab = "poll",
  onSendPoll,
  onSendLocation,
  onSendContacts,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  defaultTab?: "poll" | "location" | "contact"
  onSendPoll: (opts: {
    name: string
    values: string[]
    selectableCount?: number
  }) => Promise<unknown>
  onSendLocation: (opts: {
    latitude: number
    longitude: number
    name?: string
    address?: string
  }) => Promise<unknown>
  onSendContacts: (opts: {
    contacts: Array<{ displayName: string; vcard: string }>
  }) => Promise<unknown>
}) {
  const [tab, setTab] = useState<"poll" | "location" | "contact">(defaultTab)

  // ── Poll state ──
  const [pollQuestion, setPollQuestion] = useState("")
  const [pollOptions, setPollOptions] = useState(["", ""])
  const [pollMultiple, setPollMultiple] = useState(false)
  const [sendingPoll, setSendingPoll] = useState(false)

  // ── Location state ──
  const [lat, setLat] = useState("")
  const [lng, setLng] = useState("")
  const [placeName, setPlaceName] = useState("")
  const [address, setAddress] = useState("")
  const [locating, setLocating] = useState(false)
  const [sendingLocation, setSendingLocation] = useState(false)

  // ── Contact state ──
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set())
  const [contactSearch, setContactSearch] = useState("")
  const [sendingContacts, setSendingContacts] = useState(false)
  // Bounded server-side search (20 rows) instead of loading every contact.
  const debouncedContactSearch = useDebouncedValue(contactSearch.trim())
  const contactsQuery = useQuery({
    queryKey: ["contact-search", workspaceId, null, debouncedContactSearch],
    queryFn: () =>
      searchContacts({ data: { workspaceId, query: debouncedContactSearch } }),
    enabled: open && tab === "contact",
    staleTime: 30_000,
  })
  const filteredContacts = contactsQuery.data ?? []
  // Selected contacts must survive the search results changing.
  type PickerContact = (typeof filteredContacts)[number]
  const [knownContacts, setKnownContacts] = useState<Map<string, PickerContact>>(new Map())
  useEffect(() => {
    if (!contactsQuery.data?.length) return
    setKnownContacts((prev) => {
      const next = new Map(prev)
      for (const c of contactsQuery.data) next.set(c.id, c)
      return next
    })
  }, [contactsQuery.data])

  function reset() {
    setPollQuestion("")
    setPollOptions(["", ""])
    setPollMultiple(false)
    setLat("")
    setLng("")
    setPlaceName("")
    setAddress("")
    setSelectedContactIds(new Set())
    setContactSearch("")
  }

  function close() {
    onOpenChange(false)
    reset()
  }

  async function submitPoll() {
    const question = pollQuestion.trim()
    const values = pollOptions.map((o) => o.trim()).filter(Boolean)
    if (!question || values.length < 2) {
      toast.error("A poll needs a question and at least 2 options.")
      return
    }
    setSendingPoll(true)
    try {
      await onSendPoll({
        name: question,
        values,
        selectableCount: pollMultiple ? values.length : 1,
      })
      toast.success("Poll sent")
      close()
    } catch (err: any) {
      toast.error(err?.message ?? "Poll failed to send.")
    } finally {
      setSendingPoll(false)
    }
  }

  function useCurrentLocation() {
    // lib.dom types this as always present per spec, but some browsers /
    // restricted contexts (older Safari, some embedded webviews) genuinely
    // don't implement it -- real feature detection, not a type nicety.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!navigator.geolocation) {
      toast.error("Location isn't available in this browser.")
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(6))
        setLng(pos.coords.longitude.toFixed(6))
        setLocating(false)
      },
      () => {
        toast.error("Couldn't get your location.")
        setLocating(false)
      }
    )
  }

  async function submitLocation() {
    const latitude = parseFloat(lat)
    const longitude = parseFloat(lng)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      toast.error("Enter a valid latitude and longitude.")
      return
    }
    setSendingLocation(true)
    try {
      await onSendLocation({
        latitude,
        longitude,
        name: placeName.trim() || undefined,
        address: address.trim() || undefined,
      })
      toast.success("Location sent")
      close()
    } catch (err: any) {
      toast.error(err?.message ?? "Location failed to send.")
    } finally {
      setSendingLocation(false)
    }
  }

  async function submitContacts() {
    const chosen = [...selectedContactIds]
      .map((id) => knownContacts.get(id))
      .filter((c): c is PickerContact => !!c)
    if (chosen.length === 0) {
      toast.error("Pick at least one contact to share.")
      return
    }
    setSendingContacts(true)
    try {
      await onSendContacts({
        contacts: chosen.map((c) => ({
          displayName: c.name ?? c.phoneNumber ?? "Contact",
          vcard: contactVCard(c.name ?? c.phoneNumber ?? "Contact", c.phoneNumber),
        })),
      })
      toast.success(chosen.length > 1 ? "Contacts sent" : "Contact sent")
      close()
    } catch (err: any) {
      toast.error(err?.message ?? "Contact failed to send.")
    } finally {
      setSendingContacts(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => (v ? onOpenChange(v) : close())}>
      <SheetContent
        side="bottom"
        className="mx-auto flex max-h-[88vh] flex-col gap-0 overflow-y-auto rounded-t-2xl sm:max-w-md"
      >
        <SheetHeader>
          <SheetTitle>Share more</SheetTitle>
          <SheetDescription>
            Send a poll, a location, or a contact card.
          </SheetDescription>
        </SheetHeader>

        <Tabs value={tab} onValueChange={(v) => v && setTab(v as typeof tab)}>
          <TabsList className="w-full">
            <TabsTrigger value="poll" className="flex-1 gap-1.5">
              <BarChart3Icon className="size-3.5" /> Poll
            </TabsTrigger>
            <TabsTrigger value="location" className="flex-1 gap-1.5">
              <MapPinIcon className="size-3.5" /> Location
            </TabsTrigger>
            <TabsTrigger value="contact" className="flex-1 gap-1.5">
              <UserRoundIcon className="size-3.5" /> Contact
            </TabsTrigger>
          </TabsList>

          <TabsContent value="poll" className="flex flex-col gap-3 pt-3">
            <div className="flex flex-col gap-1.5">
              <Label>Question</Label>
              <Input
                value={pollQuestion}
                onChange={(e) => setPollQuestion(e.target.value)}
                placeholder="What should we order?"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Options</Label>
              {pollOptions.map((opt, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Input
                    value={opt}
                    onChange={(e) =>
                      setPollOptions((opts) =>
                        opts.map((o, oi) => (oi === i ? e.target.value : o))
                      )
                    }
                    placeholder={`Option ${i + 1}`}
                  />
                  {pollOptions.length > 2 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      aria-label="Remove option"
                      onClick={() =>
                        setPollOptions((opts) => opts.filter((_, oi) => oi !== i))
                      }
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))}
              {pollOptions.length < 12 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start gap-1.5"
                  onClick={() => setPollOptions((opts) => [...opts, ""])}
                >
                  <PlusIcon className="size-3.5" /> Add option
                </Button>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={pollMultiple}
                onCheckedChange={(v) => setPollMultiple(v === true)}
              />
              Allow multiple answers
            </label>
            <Button
              className="gap-1.5 self-end"
              disabled={sendingPoll}
              onClick={submitPoll}
            >
              {sendingPoll ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <SendIcon className="size-4" />
              )}
              Send poll
            </Button>
          </TabsContent>

          <TabsContent value="location" className="flex flex-col gap-3 pt-3">
            <Button
              variant="outline"
              size="sm"
              className="w-fit gap-1.5"
              onClick={useCurrentLocation}
              disabled={locating}
            >
              {locating ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <LocateFixedIcon className="size-3.5" />
              )}
              Use my current location
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1.5">
                <Label>Latitude</Label>
                <Input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="12.9716" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Longitude</Label>
                <Input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="77.5946" />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Place name (optional)</Label>
              <Input value={placeName} onChange={(e) => setPlaceName(e.target.value)} placeholder="Our office" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Address (optional)</Label>
              <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St" />
            </div>
            <Button
              className="gap-1.5 self-end"
              disabled={sendingLocation}
              onClick={submitLocation}
            >
              {sendingLocation ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <SendIcon className="size-4" />
              )}
              Send location
            </Button>
          </TabsContent>

          <TabsContent value="contact" className="flex flex-col gap-3 pt-3">
            <Input
              value={contactSearch}
              onChange={(e) => setContactSearch(e.target.value)}
              placeholder="Search contacts…"
            />
            <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1">
              {contactsQuery.isLoading ? (
                <p className="p-3 text-center text-xs text-muted-foreground">Loading…</p>
              ) : filteredContacts.length === 0 ? (
                <p className="p-3 text-center text-xs text-muted-foreground">No contacts found.</p>
              ) : (
                filteredContacts.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                  >
                    <Checkbox
                      checked={selectedContactIds.has(c.id)}
                      onCheckedChange={(v) =>
                        setSelectedContactIds((prev) => {
                          const next = new Set(prev)
                          if (v === true) next.add(c.id)
                          else next.delete(c.id)
                          return next
                        })
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{c.name ?? c.phoneNumber ?? "Unknown"}</span>
                    {c.phoneNumber && (
                      <span className="shrink-0 text-xs text-muted-foreground">{c.phoneNumber}</span>
                    )}
                  </label>
                ))
              )}
            </div>
            <Button
              className="gap-1.5 self-end"
              disabled={sendingContacts || selectedContactIds.size === 0}
              onClick={submitContacts}
            >
              {sendingContacts ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <SendIcon className="size-4" />
              )}
              Send {selectedContactIds.size > 1 ? `${selectedContactIds.size} contacts` : "contact"}
            </Button>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}
