import { useState, useEffect } from "react"
import { Link, useRouteContext } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import {
  SmartphoneIcon,
  MessageSquareIcon,
  SparklesIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  XIcon,
  CheckIcon,
} from "lucide-react"
import { getSessions } from "@/features/integrations/hooks/use-sessions"
import { getAutoReplyRules } from "@/features/settings/hooks/use-settings"
import { getConversationsPage } from "@/features/inbox/hooks/use-conversations"

interface Step {
  id: string
  title: string
  description: string
  icon: typeof SmartphoneIcon
  href: string
  done: boolean
}

const STORAGE_KEY = "onboarding_checklist_dismissed"

function readDismissed(workspaceId: string): boolean {
  try {
    return localStorage.getItem(`${STORAGE_KEY}_${workspaceId}`) === "true"
  } catch {
    return false
  }
}

function writeDismissed(workspaceId: string, value: boolean) {
  try {
    localStorage.setItem(`${STORAGE_KEY}_${workspaceId}`, String(value))
  } catch {
    // localStorage unavailable — ignore
  }
}

export function SetupChecklist() {
  const { workspaceId } = useRouteContext({ from: "/_app" })
  const [expanded, setExpanded] = useState(true)
  const [dismissed, setDismissed] = useState(() => readDismissed(workspaceId))

  const sessionsQuery = useQuery({
    queryKey: ["sessions", workspaceId],
    queryFn: () => getSessions({ data: { workspaceId } }),
    staleTime: 30_000,
  })

  const conversationsQuery = useQuery({
    queryKey: ["onboarding-conversations", workspaceId],
    queryFn: () =>
      getConversationsPage({ data: { workspaceId, limit: 1 } }),
    staleTime: 30_000,
  })

  const rulesQuery = useQuery({
    queryKey: ["auto-reply-rules", workspaceId],
    queryFn: () => getAutoReplyRules({ data: { workspaceId } }),
    staleTime: 30_000,
  })

  const hasIntegrations = (sessionsQuery.data?.length ?? 0) > 0
  const hasConversations =
    (conversationsQuery.data?.items.length ?? 0) > 0
  const hasAutoReplies = (rulesQuery.data?.length ?? 0) > 0

  const steps: Step[] = [
    {
      id: "integration",
      title: "Connect a WhatsApp number",
      description: "Link your business number to start sending and receiving.",
      icon: SmartphoneIcon,
      href: "/integrations",
      done: hasIntegrations,
    },
    {
      id: "conversation",
      title: "Receive your first message",
      description: "Send yourself a test message to see it appear in the inbox.",
      icon: MessageSquareIcon,
      href: "/inbox",
      done: hasConversations,
    },
    {
      id: "auto-reply",
      title: "Set up auto-replies",
      description: "Reply to keywords automatically — no coding needed.",
      icon: SparklesIcon,
      href: "/automation",
      done: hasAutoReplies,
    },
  ]

  const completedCount = steps.filter((s) => s.done).length
  const allDone = completedCount === steps.length

  // Persist dismiss state to localStorage
  useEffect(() => {
    writeDismissed(workspaceId, dismissed)
  }, [dismissed, workspaceId])

  // Auto-hide after everything is done
  useEffect(() => {
    if (allDone && !dismissed) {
      const timer = setTimeout(() => setDismissed(true), 4000)
      return () => clearTimeout(timer)
    }
  }, [allDone, dismissed])

  // Don't render at all if dismissed
  if (dismissed) return null

  const loading =
    sessionsQuery.isLoading ||
    conversationsQuery.isLoading ||
    rulesQuery.isLoading

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[340px] overflow-hidden rounded-xl border border-border bg-background shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">
            Get started with Replyloom
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {loading
              ? "Loading…"
              : allDone
                ? "All done — you're ready to go!"
                : `${completedCount} of ${steps.length} done — a couple more steps and you're ready.`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "Collapse checklist" : "Expand checklist"}
          >
            {expanded ? (
              <ChevronDownIcon className="size-4" />
            ) : (
              <ChevronUpIcon className="size-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss checklist"
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-muted">
        <div
          className="h-full bg-primary transition-all duration-500"
          style={{
            width: loading
              ? "0%"
              : `${(completedCount / steps.length) * 100}%`,
          }}
        />
      </div>

      {/* Steps */}
      {expanded && (
        <div className="divide-y divide-border">
          {steps.map((step) => {
            const Icon = step.icon
            return (
              <Link
                key={step.id}
                to={step.href}
                className={cn(
                  "flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50",
                  step.done && "opacity-60"
                )}
              >
                <div
                  className={cn(
                    "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
                    step.done
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {step.done ? (
                    <CheckIcon className="size-3.5" />
                  ) : (
                    <Icon className="size-3.5" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-sm font-medium",
                      step.done
                        ? "text-muted-foreground line-through"
                        : "text-foreground"
                    )}
                  >
                    {step.title}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {step.description}
                  </p>
                </div>
                {!step.done && (
                  <ChevronUpIcon className="mt-1 size-4 shrink-0 rotate-90 text-muted-foreground" />
                )}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
