import { useState } from "react"
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { LoadMoreButton } from "@/components/load-more-button"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { toast } from "sonner"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { PlusIcon, Loader2Icon } from "lucide-react"
import { createContactList, getWorkspaceGroups } from "../hooks/use-contact-lists"
import { shownOf, totalOf } from "@/lib/format-count"

type GroupOption = Awaited<ReturnType<typeof getWorkspaceGroups>>["items"][number]

const RULE_FIELDS = [
  { value: "whatsappGroup", field: "whatsappGroup", label: "Member of WhatsApp group", op: "member_of" },
  { value: "tag", field: "tag", label: "Has tag", op: "has_tag" },
  { value: "lifecycleStage", field: "lifecycleStage", label: "Lifecycle stage is", op: "equals" },
  { value: "organizationName", field: "organizationName", label: "Organization contains", op: "contains" },
  { value: "lastContactedBefore", field: "lastContactedAt", label: "Last contacted before", op: "before" },
  { value: "lastContactedAfter", field: "lastContactedAt", label: "Last contacted after", op: "after" },
  { value: "customFieldContains", field: "customField", label: "Custom field contains", op: "contains" },
  { value: "customFieldEquals", field: "customField", label: "Custom field equals", op: "equals" },
] as const

export function CreateListSheet({
  workspaceId,
  onCreated,
}: {
  workspaceId: string
  onCreated?: (listId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [kind, setKind] = useState<"static" | "smart">("static")
  const [field, setField] = useState<(typeof RULE_FIELDS)[number]["value"]>("tag")
  const [value, setValue] = useState("")
  const [customKey, setCustomKey] = useState("")
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: createContactList,
    onSuccess: (list) => {
      queryClient.invalidateQueries({ queryKey: ["contact-lists", workspaceId] })
      toast.success("List created")
      onCreated?.(list.id)
      setOpen(false)
      setName("")
      setValue("")
      setCustomKey("")
      setKind("static")
    },
    onError: (err: any) => toast.error(err?.message ?? "Couldn't create the list."),
  })

  const ruleDef = RULE_FIELDS.find((f) => f.value === field)!
  const isGroupRule = ruleDef.field === "whatsappGroup"

  // Searchable, cursor-paged group picker (workspaces can have thousands).
  const [groupSearch, setGroupSearch] = useState("")
  const groupQ = useDebouncedValue(groupSearch.trim())
  const groupsQuery = useInfiniteQuery({
    queryKey: ["workspace-groups", workspaceId, groupQ],
    queryFn: ({ pageParam }) =>
      getWorkspaceGroups({ data: { workspaceId, q: groupQ, cursor: pageParam } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: open && kind === "smart" && isGroupRule,
    staleTime: 60_000,
  })
  const groupsLoading = groupsQuery.isLoading
  const [pickedGroup, setPickedGroup] = useState<GroupOption | null>(null)
  const loadedGroups = groupsQuery.data?.pages.flatMap((p) => p.items) ?? []
  const waGroups =
    pickedGroup && !loadedGroups.some((g) => g.id === pickedGroup.id)
      ? [pickedGroup, ...loadedGroups]
      : loadedGroups

  function submit() {
    if (!name.trim()) {
      toast.error("Give this list a name.")
      return
    }
    if (kind === "smart" && !value.trim()) {
      toast.error(isGroupRule ? "Pick a WhatsApp group." : "Enter a value for the rule.")
      return
    }
    if (kind === "smart" && ruleDef.field === "customField" && !/^[A-Za-z0-9_]{1,40}$/.test(customKey.trim())) {
      toast.error("Custom field key can only use letters, numbers and underscores.")
      return
    }
    mutation.mutate({
      data: {
        workspaceId,
        name,
        kind,
        rule:
          kind === "smart"
            ? {
                field: ruleDef.field,
                op: ruleDef.op,
                value: value.trim(),
                ...(ruleDef.field === "customField" ? { key: customKey.trim() } : {}),
              }
            : null,
      },
    })
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button size="sm" />}>
        <PlusIcon />
        New list
      </SheetTrigger>
      <SheetContent side="right" className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Create contact list</SheetTitle>
          <SheetDescription>
            Broadcasts can only target a list -- static lists are built by hand,
            smart lists snapshot everyone matching a rule right now.
          </SheetDescription>
        </SheetHeader>
        <form
          id="create-list-form"
          className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Active customers — Sept" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Type</label>
            <Select value={kind} onValueChange={(v) => setKind(v as "static" | "smart")}>
              <SelectTrigger>
                <SelectValue>{(v) => (v === "smart" ? "Smart (rule-based)" : "Static (manual)")}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="static">Static (manual)</SelectItem>
                <SelectItem value="smart">Smart (rule-based)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === "smart" && (
            <div className="flex flex-col gap-2 rounded-md border p-3">
              <label className="text-sm font-medium">Rule</label>
                <Select
                  value={field}
                  onValueChange={(v) => {
                    setField(v as typeof field)
                    setValue("")
                  }}
                >
                <SelectTrigger className="w-full">
                  <SelectValue>{() => RULE_FIELDS.find((f) => f.value === field)?.label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {RULE_FIELDS.map((f) => (
                    <SelectItem key={f.value} value={f.value}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {ruleDef.field === "customField" && (
                <Input
                  value={customKey}
                  onChange={(e) => setCustomKey(e.target.value)}
                  placeholder="Field key, e.g. city"
                />
              )}
              {isGroupRule ? (
                <>
                  <Input
                    value={groupSearch}
                    onChange={(e) => setGroupSearch(e.target.value)}
                    placeholder="Search groups"
                  />
                  <Select
                    value={value}
                    onValueChange={(v) => {
                      setValue(v ?? "")
                      setPickedGroup(waGroups.find((g) => g.id === v) ?? null)
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        {() => {
                          const g = waGroups.find((x) => x.id === value)
                          if (g) return g.name ?? g.jid.split("@")[0]
                          return groupsLoading
                            ? "Loading groups..."
                            : waGroups.length === 0
                              ? "No groups synced yet"
                              : "Choose a group"
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {waGroups.map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          <span className="truncate">{g.name ?? g.jid.split("@")[0]}</span>
                          <span className="ms-auto ps-2 text-xs text-muted-foreground">
                            {g.participantCount} · {g.sessionLabel}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <LoadMoreButton
                    hasMore={!!groupsQuery.hasNextPage}
                    shown={shownOf(groupsQuery.data)}
                    total={totalOf(groupsQuery.data)}
                    loading={groupsQuery.isFetchingNextPage}
                    onLoadMore={() => groupsQuery.fetchNextPage()}
                    label="Load more groups"
                  />
                  <p className="text-xs text-muted-foreground">
                    Group members are often people you&apos;ve never chatted with 1:1. The
                    workspace&apos;s list-sourcing setting still applies, and everyone still goes
                    through opt-out, cooldown and ownership checks before a broadcast.
                  </p>
                </>
              ) : (
                <Input
                  type={ruleDef.field === "lastContactedAt" ? "date" : "text"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="value"
                />
              )}
              <p className="text-xs text-muted-foreground">
                Membership is snapshotted once, on demand ("Refresh") -- not
                re-evaluated live every time the list is viewed.
              </p>
            </div>
          )}
        </form>
        <SheetFooter>
          <Button type="submit" form="create-list-form" disabled={mutation.isPending}>
            {mutation.isPending && <Loader2Icon className="animate-spin" />}
            Create list
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
