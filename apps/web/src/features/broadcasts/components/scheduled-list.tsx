import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { XIcon, CalendarClockIcon } from "lucide-react"
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

export interface ScheduledMessage {
  id: string
  toJid: string
  body: string | null
  sendAt: number
  status: "pending" | "sent" | "failed" | "cancelled"
}

const STATUS_VARIANT: Record<
  ScheduledMessage["status"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  pending: "secondary",
  sent: "default",
  failed: "destructive",
  cancelled: "outline",
}

function formatDate(epochSeconds: number) {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function ScheduledList({
  messages,
  onCancel,
}: {
  messages: ScheduledMessage[]
  onCancel: (id: string) => void
}) {
  if (messages.length === 0) {
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarClockIcon />
          </EmptyMedia>
          <EmptyTitle>No scheduled messages yet</EmptyTitle>
          <EmptyDescription>
            One-off messages you schedule for later will show up here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>To</TableHead>
          <TableHead>Message</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Send at</TableHead>
          <TableHead className="text-right">{""}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {messages.map((m) => (
          <TableRow key={m.id}>
            <TableCell className="font-medium">
              {m.toJid.split("@")[0]}
            </TableCell>
            <TableCell className="max-w-64 truncate text-sm text-muted-foreground">
              {m.body}
            </TableCell>
            <TableCell>
              <Badge variant={STATUS_VARIANT[m.status]} className="capitalize">
                {m.status}
              </Badge>
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {formatDate(m.sendAt)}
            </TableCell>
            <TableCell className="text-right">
              {m.status === "pending" && (
                <AlertDialog>
                  <AlertDialogTrigger
                    render={<Button variant="ghost" size="icon" />}
                  >
                    <XIcon />
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Cancel scheduled message?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        This message to {m.toJid.split("@")[0]} will not be
                        sent. This can&rsquo;t be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep it</AlertDialogCancel>
                      <AlertDialogAction onClick={() => onCancel(m.id)}>
                        Cancel message
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
