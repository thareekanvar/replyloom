import { useQuery } from "@tanstack/react-query"
import { Badge } from "@workspace/ui/components/badge"
import { Panel } from "@workspace/ui/components/panel"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { getSendingLimits } from "@/features/broadcasts/hooks/use-broadcasts"

export function SendingLimitsPanel({ workspaceId }: { workspaceId: string }) {
  const { data: limits = [], isLoading } = useQuery({
    queryKey: ["sending-limits", workspaceId],
    queryFn: () => getSendingLimits({ data: { workspaceId } }),
    staleTime: 60_000,
  })

  return (
    <Panel className="flex w-full flex-col gap-4 p-4">
      <div>
        <h3 className="font-medium">Daily sending limit per number</h3>
        <p className="text-xs text-muted-foreground">
          New numbers warm up gradually: 10% of the full limit for the first 3 days, then 25%,
          50%, 75%, and 100% after 4 weeks. Broadcast messages over today&apos;s limit wait and
          go out the next day. They are never dropped.
        </p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Number</TableHead>
            <TableHead>Age</TableHead>
            <TableHead>Warm-up</TableHead>
            <TableHead className="w-64">Sent today</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={4} className="h-16 text-center text-sm text-muted-foreground">
                Loading...
              </TableCell>
            </TableRow>
          ) : limits.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="h-16 text-center text-sm text-muted-foreground">
                No WhatsApp numbers connected yet.
              </TableCell>
            </TableRow>
          ) : (
            limits.map((l) => {
              const pct = l.dailyLimit ? Math.min(100, (l.sentToday / l.dailyLimit) * 100) : 0
              return (
                <TableRow key={l.id}>
                  <TableCell>
                    <div className="font-medium">{l.label}</div>
                    <div className="text-xs text-muted-foreground">{l.phoneNumber ?? "—"}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {l.ageDays} day{l.ageDays === 1 ? "" : "s"}
                  </TableCell>
                  <TableCell>
                    {l.warmUpPercent >= 100 ? (
                      <Badge variant="outline">Fully warmed</Badge>
                    ) : (
                      <Badge variant="secondary">{l.warmUpPercent}% of limit</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <div className="flex justify-between text-xs">
                        <span className="tabular-nums">
                          {l.sentToday} / {l.dailyLimit}
                        </span>
                        <span className="text-muted-foreground">
                          {l.remainingToday === 0 && l.resetsAt
                            ? `resets ${new Date(l.resetsAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                            : `${l.remainingToday} left`}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full ${pct >= 100 ? "bg-destructive" : "bg-primary"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>
    </Panel>
  )
}
