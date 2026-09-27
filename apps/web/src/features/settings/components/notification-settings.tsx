import { useEffect, useState } from "react"
import { Badge } from "@workspace/ui/components/badge"
import { Panel } from "@workspace/ui/components/panel"
import { Switch } from "@workspace/ui/components/switch"
import { BellIcon, Volume2Icon, MailIcon } from "lucide-react"
import { toast } from "sonner"

export interface NotificationPrefs {
  desktopEnabled: boolean
  soundEnabled: boolean
  emailDigestEnabled: boolean
}

function Row({
  icon,
  title,
  description,
  right,
}: {
  icon: React.ReactNode
  title: React.ReactNode
  description: string
  right: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 p-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          {icon}
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{title}</span>
          <span className="text-sm text-muted-foreground">{description}</span>
        </div>
      </div>
      <div className="shrink-0 pt-1.5">{right}</div>
    </div>
  )
}

export function NotificationSettings({
  prefs,
  onChange,
}: {
  prefs: NotificationPrefs
  onChange: (patch: Partial<NotificationPrefs>) => void
}) {
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >("default")

  useEffect(() => {
    if (typeof window === "undefined" || typeof Notification === "undefined") {
      setPermission("unsupported")
      return
    }
    setPermission(Notification.permission)
  }, [])

  async function handleDesktopToggle(checked: boolean) {
    if (!checked) {
      onChange({ desktopEnabled: false })
      return
    }
    if (typeof Notification === "undefined") {
      toast.error("Your browser doesn't support desktop notifications.")
      return
    }
    if (Notification.permission === "denied") {
      toast.error(
        "Notifications are blocked for this site. Allow them in your browser's site settings first."
      )
      return
    }
    const result =
      Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission()
    setPermission(result)
    if (result !== "granted") {
      toast.error(
        "Desktop notifications need permission from your browser to turn on."
      )
      return
    }
    onChange({ desktopEnabled: true })
    new Notification("Desktop notifications on", {
      body: "You'll be alerted here when new WhatsApp messages come in.",
    })
  }

  return (
    <Panel className="divide-y divide-border">
      <Row
        icon={<BellIcon className="size-4" />}
        title="Desktop notifications"
        description={
          permission === "denied"
            ? "Blocked by your browser — allow notifications for this site to turn it on."
            : "Get a system notification when a new message arrives while you're away from this tab."
        }
        right={
          <Switch
            checked={prefs.desktopEnabled}
            onCheckedChange={handleDesktopToggle}
            disabled={permission === "denied"}
          />
        }
      />
      <Row
        icon={<Volume2Icon className="size-4" />}
        title="Message sound"
        description="Play a short chime whenever a new message comes into the inbox."
        right={
          <Switch
            checked={prefs.soundEnabled}
            onCheckedChange={(checked) => onChange({ soundEnabled: checked })}
          />
        }
      />
      <Row
        icon={<MailIcon className="size-4" />}
        title={
          <span className="inline-flex items-center gap-2">
            Email digest
            <Badge variant="outline" className="text-[10px]">
              Coming soon
            </Badge>
          </span>
        }
        description="A daily summary of unread conversations, sent to your email."
        right={<Switch checked={false} disabled />}
      />
    </Panel>
  )
}
