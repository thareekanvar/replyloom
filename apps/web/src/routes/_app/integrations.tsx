import { createFileRoute, useRouteContext } from "@tanstack/react-router"
import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { SessionCard } from "@/features/integrations/components/session-card"
import { CreateSessionDialog } from "@/features/integrations/components/create-session-dialog"
import { QrConnectDialog } from "@/features/integrations/components/qr-connect-dialog"
import {
  getSessions,
  createSession,
  deleteSession,
  disconnectSession,
} from "@/features/integrations/hooks/use-sessions"
import { SmartphoneIcon, SearchIcon, PlusIcon } from "lucide-react"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@workspace/ui/components/empty"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { CardGridSkeleton } from "@/components/skeletons"
import { toast } from "sonner"

export const Route = createFileRoute("/_app/integrations")({
  staticData: { title: "Integrations" },
  component: IntegrationsPage,
})

function IntegrationsPage() {
  const { workspaceId } = useRouteContext({ from: "/_app" })
  const queryClient = useQueryClient()
  const [connectSessionId, setConnectSessionId] = useState<string | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [query, setQuery] = useState("")

  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ["sessions", workspaceId],
    queryFn: () => getSessions({ data: { workspaceId } }),
    staleTime: 10_000,
  })

  // Errors from these are already toasted globally by the QueryClient's
  // mutationCache (see lib/query-client.ts) — only success feedback here.
  const createMutation = useMutation({
    mutationFn: (vars: { label: string; phoneNumber?: string }) =>
      createSession({ data: { workspaceId, ...vars } }),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ["sessions", workspaceId] })
      toast.success("Session created")
      // Go straight into the QR flow — the user just said what number
      // this is, the natural next step is linking it, not another click.
      setConnectSessionId(session.id)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (sessionId: string) => deleteSession({ data: { sessionId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions", workspaceId] })
      toast.success("Session deleted")
    },
  })

  function handleDisconnect(sessionId: string) {
    disconnectSession({ data: { sessionId } }).catch((err) => {
      console.error(err)
      toast.error("Couldn't disconnect this session. Please try again.")
    })
    setTimeout(
      () =>
        queryClient.invalidateQueries({ queryKey: ["sessions", workspaceId] }),
      1000
    )
  }

  const connectSession = sessions.find((s) => s.id === connectSessionId)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Integrations</h2>
          <p className="text-sm text-muted-foreground">
            Connect WhatsApp numbers so your team can send and receive messages
            from one inbox.
          </p>
        </div>
        <CreateSessionDialog
          onCreate={(label, phoneNumber) =>
            createMutation.mutate({ label, phoneNumber })
          }
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
        />
      </div>

      {sessions.length > 0 && (
        <div className="relative max-w-xs">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search integrations…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {isLoading ? (
        <CardGridSkeleton count={6} />
      ) : sessions.length === 0 ? (
        <Empty className="rounded-2xl border border-dashed border-border bg-card py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SmartphoneIcon />
            </EmptyMedia>
            <EmptyTitle>No integrations yet</EmptyTitle>
            <EmptyDescription>
              Add a WhatsApp number to start sending and receiving messages.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
              <PlusIcon className="size-4" />
              Create your first integration
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {sessions
            .filter((s) => {
              const q = query.trim().toLowerCase()
              if (!q) return true
              return (
                s.label.toLowerCase().includes(q) ||
                (s.phoneNumber ?? "").includes(q)
              )
            })
            .map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                onOpenConnect={setConnectSessionId}
                onDisconnect={handleDisconnect}
                onDelete={(id) => deleteMutation.mutate(id)}
              />
            ))}
        </div>
      )}

      {connectSession && (
        <QrConnectDialog
          sessionId={connectSession.id}
          sessionLabel={connectSession.label}
          open={!!connectSessionId}
          isConnected={connectSession.status === "connected"}
          onOpenChange={(open) => !open && setConnectSessionId(null)}
          onConnected={() =>
            queryClient.invalidateQueries({
              queryKey: ["sessions", workspaceId],
            })
          }
        />
      )}
    </div>
  )
}
