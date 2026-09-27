import { useEffect, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import QRCode from "qrcode"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { Button } from "@workspace/ui/components/button"
import { Switch } from "@workspace/ui/components/switch"
import { Label } from "@workspace/ui/components/label"
import {
  CheckCircle2Icon,
  Loader2Icon,
  AlertCircleIcon,
  RefreshCwIcon,
} from "lucide-react"
import { toast } from "sonner"
import { getSessionStatus, connectSession } from "../hooks/use-sessions"
import { useRealtimeEvent } from "@/features/realtime/hooks/use-realtime-event"

export function QrConnectDialog({
  sessionId,
  sessionLabel,
  open,
  isConnected = false,
  onOpenChange,
  onConnected,
}: {
  sessionId: string
  sessionLabel: string
  open: boolean
  // Already-linked number ("View integration"): show the sync options it
  // was linked with as read-only -- they only apply at pairing time, so
  // changing them here would do nothing (and Continue would reconnect).
  isConnected?: boolean
  onOpenChange: (open: boolean) => void
  onConnected: () => void
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const startedRef = useRef(false)
  const connectedRef = useRef(false)
  const queryClient = useQueryClient()

  // Asked once, before the first connection attempt each time the dialog
  // opens -- history/group-member sync are the two heaviest things a fresh
  // connect does (see the D1 rows_read investigation this week). History
  // defaults ON so a new number actually shows its chats after linking
  // (users consistently expect "connect → see my conversations"); group
  // member resolution stays OFF (heavier write loop, opt-in). History is
  // only offered on first connect — to re-import later, delete the
  // integration and start a new session.
  const [step, setStep] = useState<"options" | "connecting">("options")
  const [syncHistory, setSyncHistory] = useState(true)
  const [syncGroupMembers, setSyncGroupMembers] = useState(false)

  const { data, error } = useQuery({
    queryKey: ["session-status", sessionId],
    queryFn: () => getSessionStatus({ data: { sessionId } }),
    enabled: open && (step === "connecting" || isConnected),
  })

  // No polling: the session's WebSocket pushes a `session-status` event on
  // every QR rotation, on connect and on disconnect -- each one triggers a
  // single status read (which carries the fresh QR string). `socket-open`
  // covers a QR that was issued before this session's socket came up.
  useRealtimeEvent((event) => {
    if (!open || step !== "connecting") return
    if (event.sessionId !== sessionId) return
    if (event.type === "session-status" || event.type === "socket-open") {
      queryClient.invalidateQueries({
        queryKey: ["session-status", sessionId],
      })
    }
  })

  // Reset local state whenever the dialog closes, so reopening starts
  // clean at the options step again.
  const disconnectedSinceRef = useRef<number | null>(null)
  const preparingSinceRef = useRef<number | null>(null)
  useEffect(() => {
    if (open) return
    startedRef.current = false
    connectedRef.current = false
    disconnectedSinceRef.current = null
    preparingSinceRef.current = null
    setQrDataUrl(null)
    setStep("options")
    setSyncHistory(true)
    setSyncGroupMembers(false)
    // Drop the cached status too: useQuery hands back cached data even
    // while disabled, so a stale "connected" from a previous run would
    // trip the auto-close effect below the moment the dialog reopens.
    queryClient.removeQueries({ queryKey: ["session-status", sessionId] })
  }, [open, queryClient, sessionId])

  // Tick while the dialog is open so the "stuck preparing" check below
  // re-evaluates without waiting on the next status poll.
  useEffect(() => {
    if (!open || step !== "connecting") return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [open, step])

  function startConnecting() {
    if (startedRef.current) return
    startedRef.current = true
    preparingSinceRef.current = Date.now()
    setStep("connecting")
    connectSession({
      data: { sessionId, syncHistory, syncGroupMembers },
    }).catch(() =>
      toast.error("Couldn't start the connection. Please try again.")
    )
  }

  useEffect(() => {
    if (!data?.qr) {
      setQrDataUrl(null)
      return
    }
    preparingSinceRef.current = null
    QRCode.toDataURL(data.qr, { width: 240, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null))
  }, [data?.qr])

  useEffect(() => {
    // Only auto-close when a connection attempt started in THIS dialog
    // session finishes -- never on open (e.g. "View integration" on an
    // already-connected number with a cached "connected" status).
    if (step !== "connecting" || !startedRef.current) return
    if (data?.connection !== "connected" || connectedRef.current) return
    connectedRef.current = true
    // Small delay so the worker's D1 write (markSessionStatus) has time to
    // land before we invalidate the sessions query — without this the
    // session card would briefly show "Not connected" on a stale read.
    const timer = setTimeout(() => {
      onConnected()
      onOpenChange(false)
    }, 600)
    return () => clearTimeout(timer)
  }, [step, data?.connection, onConnected, onOpenChange])

  function handleRetry() {
    startedRef.current = false
    connectedRef.current = false
    disconnectedSinceRef.current = null
    preparingSinceRef.current = null
    setQrDataUrl(null)
    queryClient.removeQueries({ queryKey: ["session-status", sessionId] })
    startedRef.current = true
    setStep("connecting")
    connectSession({
      data: { sessionId, syncHistory, syncGroupMembers, force: true },
    }).catch(() =>
      toast.error("Couldn't start the connection. Please try again.")
    )
  }

  const connection = data?.connection ?? "connecting"

  // The worker reports "idle" both before a connection attempt has started
  // and momentarily right after POST /connect (it flips to "connecting"
  // only once the async startSocket() work actually begins) -- it's a
  // loading state, not a failure, so it must not trip isFailed.
  //
  // "disconnected" is trickier: the worker also parks in "disconnected" for
  // ~3s during its own automatic reconnect before retrying startSocket().
  // A status poll landing in that window would otherwise flash a false
  // "Connection failed" mid-retry. Debounce it past that retry window so
  // only a disconnect that actually sticks counts as a real failure.
  if (connection !== "disconnected") {
    disconnectedSinceRef.current = null
  } else if (disconnectedSinceRef.current === null) {
    disconnectedSinceRef.current = Date.now()
  }

  // "Preparing your connection…" is the spinner shown until a QR arrives.
  // If pairing dies server-side before any QR is issued (e.g. WhatsApp
  // rejecting the registration payload), the status can sit on
  // "connecting"/"idle" with no qr for a long time — time-box it so the
  // user gets a Retry instead of an infinite spinner.
  if (!qrDataUrl && connection !== "connected" && !isDisconnectedLong()) {
    if (preparingSinceRef.current === null) preparingSinceRef.current = now
  } else {
    preparingSinceRef.current = null
  }
  const preparingTooLong =
    preparingSinceRef.current !== null &&
    now - preparingSinceRef.current > 15_000

  function isDisconnectedLong() {
    return (
      connection === "disconnected" &&
      disconnectedSinceRef.current !== null &&
      Date.now() - disconnectedSinceRef.current > 4000
    )
  }

  const isFailed = Boolean(error) || isDisconnectedLong() || preparingTooLong

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {isConnected ? sessionLabel : `Connect ${sessionLabel}`}
          </SheetTitle>
          <SheetDescription>
            {isConnected
              ? "This number is linked and syncing."
              : "Scan this code with WhatsApp to link the number."}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col items-center gap-4 overflow-y-auto px-6 pb-6">
          {isConnected && step === "options" ? (
            <div className="flex w-full flex-col gap-4">
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2Icon className="size-4 text-primary" />
                <span className="font-medium">Connected</span>
                {data?.user && (
                  <span className="text-muted-foreground">
                    {data.user.split(":")[0]}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label
                  htmlFor="sync-history-ro"
                  className="text-sm font-medium"
                >
                  Import chat history
                </Label>
                <Switch
                  id="sync-history-ro"
                  checked={data?.syncHistory ?? false}
                  disabled
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label
                  htmlFor="sync-group-members-ro"
                  className="text-sm font-medium"
                >
                  Sync group members
                </Label>
                <Switch
                  id="sync-group-members-ro"
                  checked={data?.syncGroupMembers ?? false}
                  disabled
                />
              </div>
              <p className="text-xs text-muted-foreground">
                These were set when the number was linked and only apply at
                pairing time. To change them, delete this integration and
                connect the number again.
              </p>
            </div>
          ) : step === "options" ? (
            <div className="flex w-full flex-col gap-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="sync-history" className="text-sm font-medium">
                    Import chat history
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Bring in this number's existing conversations. On by default
                    -- turn off to only record messages from now on.
                  </p>
                </div>
                <Switch
                  id="sync-history"
                  checked={syncHistory}
                  onCheckedChange={setSyncHistory}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label
                    htmlFor="sync-group-members"
                    className="text-sm font-medium"
                  >
                    Sync group members
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Add every group's participants as contacts automatically.
                    Off by default -- you can always sync a specific group's
                    members later.
                  </p>
                </div>
                <Switch
                  id="sync-group-members"
                  checked={syncGroupMembers}
                  onCheckedChange={setSyncGroupMembers}
                />
              </div>
              <Button onClick={startConnecting} className="mt-2">
                Continue
              </Button>
            </div>
          ) : connection === "connected" ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                <CheckCircle2Icon className="size-7" />
              </div>
              <div>
                <p className="text-sm font-medium">Connected</p>
                {data?.user && (
                  <p className="text-xs text-muted-foreground">
                    {data.user.split(":")[0]}
                  </p>
                )}
              </div>
            </div>
          ) : isFailed ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <div className="flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <AlertCircleIcon className="size-7" />
              </div>
              <div>
                <p className="text-sm font-medium">Connection failed</p>
                <p className="text-xs text-muted-foreground">
                  {error
                    ? "Could not reach the WhatsApp service. Check your network and try again."
                    : "WhatsApp closed the connection before a QR code was ready. This can happen from network issues, WhatsApp rotating the QR, or a rejected pairing request."}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={handleRetry}>
                <RefreshCwIcon />
                Retry connection
              </Button>
            </div>
          ) : qrDataUrl ? (
            <>
              <div className="overflow-hidden rounded-xl border bg-white p-3">
                <img
                  src={qrDataUrl}
                  alt="WhatsApp QR code"
                  width={220}
                  height={220}
                />
              </div>
              <ol className="w-full list-decimal space-y-1 ps-4 text-xs text-muted-foreground">
                <li>Open WhatsApp on your phone</li>
                <li>Go to Settings → Linked Devices</li>
                <li>Tap "Link a Device" and scan this code</li>
              </ol>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
                </span>
                Waiting for scan…
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                Preparing your connection…
              </p>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
