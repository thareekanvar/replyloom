import { Button } from "@workspace/ui/components/button"
import { Panel } from "@workspace/ui/components/panel"
import { Switch } from "@workspace/ui/components/switch"
import { Input } from "@workspace/ui/components/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogCancel,
  AlertDialogAction,
} from "@workspace/ui/components/alert-dialog"
import {
  MessageCircleIcon,
  EllipsisVerticalIcon,
  TrashIcon,
  ArrowUpRightIcon,
} from "lucide-react"
import { useState } from "react"

interface Session {
  id: string
  label: string
  phoneNumber: string | null
  connectedJid: string | null
  status:
    | "idle"
    | "connecting"
    | "qr"
    | "authenticated"
    | "connected"
    | "disconnected"
    | "close"
  createdAt: number
}

const STATUS_LABEL: Record<Session["status"], string> = {
  idle: "Not connected — connect a number to start sending and receiving messages.",
  connecting: "Connecting…",
  qr: "Waiting for a QR code scan to finish linking.",
  authenticated: "Authenticating…",
  connected: "Active and receiving messages.",
  disconnected: "Disconnected — reconnect to resume sending and receiving.",
  close: "Disconnected — reconnect to resume sending and receiving.",
}

// Integration card in the style of a typical "connected apps" catalog: a
// colored app-icon tile, a name + linkable identifier, a one-line status
// description, and a footer of "View integration" + an on/off switch —
// same shape as third-party integration catalogs (Linear, Zapier, ...),
// just for the one integration type this app actually has: WhatsApp
// numbers. "Session card" internally — this is the data type name
// (waSessions) — but the UI speaks "integration" throughout.
export function SessionCard({
  session,
  onOpenConnect,
  onDisconnect,
  onDelete,
}: {
  session: Session
  onOpenConnect: (id: string) => void
  onDisconnect: (id: string) => void
  onDelete: (id: string) => void
}) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState("")
  const canDelete = deleteConfirmText.trim() === session.label.trim()

  const isConnected = session.status === "connected"
  const isPending =
    session.status === "connecting" ||
    session.status === "qr" ||
    session.status === "authenticated"
  const number =
    session.phoneNumber ??
    session.connectedJid?.split(":")[0]?.split("@")[0] ??
    null

  return (
    <Panel className="flex flex-col gap-3 p-4 transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{session.label}</p>
          {number ? (
            <button
              type="button"
              onClick={() => onOpenConnect(session.id)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary hover:underline"
            >
              {number}
              <ArrowUpRightIcon className="size-3" />
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">
              Not linked to a number yet
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-sm">
            <MessageCircleIcon className="size-5" />
          </span>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {STATUS_LABEL[session.status]}
      </p>

      <div className="mt-1 flex items-center justify-between gap-2 border-t border-border pt-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOpenConnect(session.id)}
        >
          {isConnected
            ? "View integration"
            : isPending
              ? "Show QR code"
              : "Connect"}
        </Button>
        <div className="flex items-center gap-1">
          <Switch
            checked={isConnected}
            onCheckedChange={(checked) => {
              if (checked) onOpenConnect(session.id)
              else setConfirmDisconnect(true)
            }}
            aria-label={isConnected ? "Disconnect" : "Connect"}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" />}
            >
              <EllipsisVerticalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setConfirmDelete(true)}
              >
                <TrashIcon />
                Delete integration
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {session.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              This integration will stop sending and receiving messages until
              you scan a new QR code to reconnect it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onDisconnect(session.id)
                setConfirmDisconnect(false)
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmDelete}
        onOpenChange={(open) => {
          setConfirmDelete(open)
          if (!open) setDeleteConfirmText("")
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {session.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes this integration and everything synced
              from it &mdash; conversations, messages, contacts, groups,
              campaigns and automations for this number. To pause it and keep
              your data, use Disconnect instead. This can&rsquo;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2">
            <label htmlFor={`delete-confirm-${session.id}`} className="text-xs text-muted-foreground">
              Type <span className="font-semibold text-foreground">{session.label}</span> to confirm
            </label>
            <Input
              id={`delete-confirm-${session.id}`}
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              autoComplete="off"
              autoFocus
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!canDelete}
              onClick={() => {
                if (!canDelete) return
                onDelete(session.id)
                setConfirmDelete(false)
                setDeleteConfirmText("")
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  )
}
