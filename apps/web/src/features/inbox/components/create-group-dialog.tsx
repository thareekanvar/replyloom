import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Loader2Icon, PlusIcon, UsersIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { getSessions } from "@/features/integrations/hooks/use-sessions"
import { useCreateGroup } from "../hooks/use-group-actions"

export function CreateGroupDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
}) {
  const [sessionId, setSessionId] = useState<string>("")
  const [subject, setSubject] = useState("")
  const [participants, setParticipants] = useState([""])

  const sessionsQuery = useQuery({
    queryKey: ["sessions", workspaceId],
    queryFn: () => getSessions({ data: { workspaceId } }),
    enabled: open,
  })
  const connectedSessions = (sessionsQuery.data ?? []).filter(
    (s) => s.status === "connected"
  )

  const createGroup = useCreateGroup(workspaceId)

  function reset() {
    setSessionId("")
    setSubject("")
    setParticipants([""])
  }

  function close() {
    onOpenChange(false)
    reset()
  }

  async function submit() {
    const name = subject.trim()
    const numbers = participants.map((p) => p.trim()).filter(Boolean)
    if (!sessionId) {
      toast.error("Pick which number creates the group.")
      return
    }
    if (!name) {
      toast.error("Give the group a name.")
      return
    }
    if (numbers.length === 0) {
      toast.error("Add at least one participant's phone number.")
      return
    }
    try {
      await createGroup.mutateAsync({
        sessionId,
        subject: name,
        participants: numbers,
      })
      toast.success(`"${name}" created — it'll appear in your inbox shortly.`)
      close()
    } catch {
      // useCreateGroup already toasts the error
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => (v ? onOpenChange(v) : close())}>
      <SheetContent side="right" className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <UsersIcon className="size-4" /> New group
          </SheetTitle>
          <SheetDescription>
            Create a WhatsApp group from one of your connected numbers.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
          <div className="flex flex-col gap-1.5">
            <Label>From number</Label>
            <Select value={sessionId} onValueChange={(v) => v && setSessionId(v)}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a connected number" />
              </SelectTrigger>
              <SelectContent>
                {connectedSessions.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No connected numbers yet
                  </div>
                ) : (
                  connectedSessions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Group name</Label>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Project Falcon"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Participants (phone numbers)</Label>
            {participants.map((p, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  value={p}
                  onChange={(e) =>
                    setParticipants((prev) =>
                      prev.map((v, vi) => (vi === i ? e.target.value : v))
                    )
                  }
                  placeholder="+1 555 123 4567"
                />
                {participants.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    aria-label="Remove"
                    onClick={() =>
                      setParticipants((prev) => prev.filter((_, vi) => vi !== i))
                    }
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="w-fit gap-1.5"
              onClick={() => setParticipants((prev) => [...prev, ""])}
            >
              <PlusIcon className="size-3.5" /> Add participant
            </Button>
          </div>
        </div>

        <SheetFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button disabled={createGroup.isPending} onClick={submit} className="gap-1.5">
            {createGroup.isPending && <Loader2Icon className="size-4 animate-spin" />}
            Create group
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
