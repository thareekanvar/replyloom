import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@workspace/ui/components/button"
import { Panel } from "@workspace/ui/components/panel"
import { Badge } from "@workspace/ui/components/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"
import { Loader2Icon, UserRoundCheckIcon } from "lucide-react"
import {
  getAgentEscalations,
  resolveAgentEscalation,
} from "@/features/agent/hooks/use-agent"

export function AgentEscalationsPanel({
  workspaceId,
  onChanged,
}: {
  workspaceId: string
  onChanged?: () => void
}) {
  const queryClient = useQueryClient()

  const escQuery = useQuery({
    queryKey: ["agent-escalations", workspaceId],
    queryFn: () => getAgentEscalations({ data: { workspaceId } }),
    staleTime: 15_000,
  })

  const resolveMutation = useMutation({
    mutationFn: (id: string) => resolveAgentEscalation({ data: { id } }),
    onSuccess: () => {
      toast.success("Escalation marked resolved")
      queryClient.invalidateQueries({
        queryKey: ["agent-escalations", workspaceId],
      })
      onChanged?.()
    },
  })

  const escalations = escQuery.data ?? []
  const pending = escalations.filter((e) => e.status === "pending")

  return (
    <Panel className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <UserRoundCheckIcon className="size-4 text-primary" />
          <h2 className="text-lg font-semibold">Human hand-offs</h2>
          {pending.length > 0 && (
            <Badge>{pending.length} waiting</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Every time the agent can&rsquo;t answer confidently, it flags the
          conversation here so a person follows up.
        </p>
      </div>

      {escQuery.isLoading ? null : escalations.length === 0 ? (
        <Empty className="py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UserRoundCheckIcon />
            </EmptyMedia>
            <EmptyTitle>No escalations yet</EmptyTitle>
            <EmptyDescription>
              When the agent can&rsquo;t answer, it&rsquo;ll show up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reason</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">{""}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {escalations.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="max-w-md">
                  <span className="line-clamp-2 text-sm">{e.reason}</span>
                  {e.remoteJid && (
                    <span className="block font-mono text-xs text-muted-foreground">
                      {e.remoteJid}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={e.status === "pending" ? "secondary" : "outline"}
                    className="capitalize"
                  >
                    {e.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  {e.status === "pending" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => resolveMutation.mutate(e.id)}
                      disabled={resolveMutation.isPending}
                    >
                      {resolveMutation.isPending && (
                        <Loader2Icon className="animate-spin" />
                      )}
                      Mark resolved
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  )
}