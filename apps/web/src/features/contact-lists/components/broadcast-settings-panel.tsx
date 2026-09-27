import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Panel } from "@workspace/ui/components/panel"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Loader2Icon } from "lucide-react"
import {
  getWorkspaceBroadcastSettings,
  updateWorkspaceBroadcastSettings,
} from "../hooks/use-contact-lists"

const COOLDOWN_OPTIONS = [2, 3, 7, 14] as const
const SOURCING_MODES = [
  { value: "warn", label: "Allow, but flag cold/imported contacts" },
  { value: "conversation_only", label: "Only contacts with an existing conversation" },
  { value: "unrestricted", label: "No restriction" },
] as const

export function BroadcastSettingsPanel({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient()
  const { data: settings } = useQuery({
    queryKey: ["broadcast-settings", workspaceId],
    queryFn: () => getWorkspaceBroadcastSettings({ data: { workspaceId } }),
  })

  const [ceiling, setCeiling] = useState(500)
  const [cooldownDays, setCooldownDays] = useState<(typeof COOLDOWN_OPTIONS)[number]>(7)
  const [sourcingMode, setSourcingMode] = useState<(typeof SOURCING_MODES)[number]["value"]>("warn")

  useEffect(() => {
    if (settings) {
      setCeiling(settings.recipientCeiling)
      setCooldownDays(settings.cooldownDays as (typeof COOLDOWN_OPTIONS)[number])
      setSourcingMode(settings.listSourcingMode)
    }
  }, [settings])

  const mutation = useMutation({
    mutationFn: updateWorkspaceBroadcastSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["broadcast-settings", workspaceId] })
      toast.success("Broadcast settings saved")
    },
    onError: (err: any) => toast.error(err?.message ?? "Couldn't save settings."),
  })

  return (
    <Panel className="flex w-full flex-col gap-4 p-4">
      <div>
        <h3 className="font-medium">Anti-ban protection</h3>
        <p className="text-xs text-muted-foreground">
          These limits apply to every broadcast in this workspace. The
          recipient ceiling can never be raised past this workspace&apos;s
          hard maximum.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium">Recipient ceiling per campaign</label>
        <Input
          type="number"
          min={1}
          value={ceiling}
          onChange={(e) => setCeiling(Number(e.target.value) || 0)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium">Per-contact cooldown</label>
        <Select
          value={String(cooldownDays)}
          onValueChange={(v) => setCooldownDays((Number(v) || 7) as (typeof COOLDOWN_OPTIONS)[number])}
        >
          <SelectTrigger className="w-full">
            <SelectValue>{() => `${cooldownDays} days`}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {COOLDOWN_OPTIONS.map((d) => (
              <SelectItem key={d} value={String(d)}>
                {d} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium">List sourcing</label>
        <Select value={sourcingMode} onValueChange={(v) => setSourcingMode(v as typeof sourcingMode)}>
          <SelectTrigger className="w-full">
            <SelectValue>{() => SOURCING_MODES.find((m) => m.value === sourcingMode)?.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SOURCING_MODES.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      </div>

      <Button
        type="button"
        className="w-fit"
        disabled={mutation.isPending}
        onClick={() =>
          mutation.mutate({
            data: { workspaceId, recipientCeiling: ceiling, cooldownDays, listSourcingMode: sourcingMode },
          })
        }
      >
        {mutation.isPending && <Loader2Icon className="animate-spin" />}
        Save settings
      </Button>
    </Panel>
  )
}
