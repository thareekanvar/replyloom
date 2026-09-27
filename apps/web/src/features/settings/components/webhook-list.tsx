import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Switch } from "@workspace/ui/components/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { TrashIcon, WebhookIcon } from "lucide-react"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"
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

export interface Webhook {
  id: string
  url: string
  events: string[]
  enabled: boolean
  createdAt: number
}

export function WebhookList({
  webhooks,
  onToggle,
  onDelete,
}: {
  webhooks: Webhook[]
  onToggle: (id: string, enabled: boolean) => void
  onDelete: (id: string) => void
}) {
  if (webhooks.length === 0) {
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WebhookIcon />
          </EmptyMedia>
          <EmptyTitle>No webhooks yet</EmptyTitle>
          <EmptyDescription>
            Add one to receive message events on your own server.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>URL</TableHead>
          <TableHead>Events</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">{""}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {webhooks.map((w) => (
          <TableRow key={w.id}>
            <TableCell className="max-w-64 truncate font-mono text-xs">
              {w.url}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {w.events.map((e) => (
                  <Badge key={e} variant="outline">
                    {e}
                  </Badge>
                ))}
              </div>
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-2">
                <Switch
                  checked={w.enabled}
                  onCheckedChange={(next) => onToggle(w.id, next)}
                  aria-label={`${w.enabled ? "Disable" : "Enable"} webhook for ${w.url}`}
                />
                <span className="text-xs text-muted-foreground">
                  {w.enabled ? "On" : "Off"}
                </span>
              </div>
            </TableCell>
            <TableCell className="text-right">
              <AlertDialog>
                <AlertDialogTrigger
                  render={<Button variant="ghost" size="icon" />}
                >
                  <TrashIcon />
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete webhook?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will stop sending events to{" "}
                      <span className="font-mono">{w.url}</span>. This
                      can&rsquo;t be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => onDelete(w.id)}>
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
