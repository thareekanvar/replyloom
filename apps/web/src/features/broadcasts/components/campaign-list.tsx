import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"
import { MegaphoneIcon, TrashIcon } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from "@workspace/ui/components/alert-dialog"
import { cn } from "@workspace/ui/lib/utils"

export interface Campaign {
  id: string
  name: string
  status: "draft" | "scheduled" | "running" | "completed" | "failed"
  scheduledAt: number | null
  createdAt: number
  /** Set by the worker's campaign-level circuit breaker. */
  pausedForFailureRate?: boolean
  stats: { total: number; sent: number; failed: number; pending: number }
}

const STATUS_VARIANT: Record<
  Campaign["status"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  draft: "outline",
  scheduled: "outline",
  running: "secondary",
  completed: "default",
  failed: "destructive",
}

function formatDate(epochSeconds: number) {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function CampaignProgress({ c }: { c: Campaign }) {
  const { total, sent, failed } = c.stats
  const done = sent + failed
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  if (total === 0) return null
  return (
    <div className="flex min-w-32 flex-col items-start gap-1">
      <div className="flex w-full items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${Math.max(pct, 3)}%` }}
          />
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {pct}%
        </span>
      </div>
      <span
        className={cn(
          "text-xs text-muted-foreground",
          failed > 0 && "text-destructive"
        )}
      >
        {sent} sent · {failed} failed
        {c.stats.pending > 0 && ` · ${c.stats.pending} pending`}
      </span>
    </div>
  )
}

export function CampaignList({
  campaigns,
  onDelete,
}: {
  campaigns: Campaign[]
  onDelete: (id: string) => void
}) {
  if (campaigns.length === 0) {
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MegaphoneIcon />
          </EmptyMedia>
          <EmptyTitle>No broadcasts yet</EmptyTitle>
          <EmptyDescription>
            Create one to message a group of contacts safely.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const canDelete = (c: Campaign) => c.status !== "running"

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Campaign</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Progress</TableHead>
          <TableHead className="text-right">{"Scheduled / Created"}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {campaigns.map((c) => (
          <TableRow key={c.id}>
            <TableCell className="font-medium">{c.name}</TableCell>
            <TableCell>
              {c.pausedForFailureRate ? (
                <Badge
                  variant="destructive"
                  title="Stopped automatically: too many sends to this list failed. That usually means stale numbers or the message is being blocked -- clean the list before trying again."
                >
                  Auto-stopped · high failures
                </Badge>
              ) : (
                <Badge variant={STATUS_VARIANT[c.status]} className="capitalize">
                  {c.status}
                </Badge>
              )}
            </TableCell>
            <TableCell>
              <CampaignProgress c={c} />
            </TableCell>
            <TableCell className="text-right">
              <div className="flex items-center justify-end gap-2">
                <span className="text-sm text-muted-foreground">
                  {formatDate(c.scheduledAt ?? c.createdAt)}
                </span>
                {canDelete(c) && (
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete broadcast "${c.name}"`}
                        />
                      }
                    >
                      <TrashIcon className="size-4" />
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete broadcast?</AlertDialogTitle>
                        <AlertDialogDescription>
                          &ldquo;{c.name}&rdquo; and its recipient list will be
                          permanently removed. This can&rsquo;t be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => onDelete(c.id)}>
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}