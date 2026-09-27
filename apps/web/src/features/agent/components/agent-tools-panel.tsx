import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Textarea } from "@workspace/ui/components/textarea"
import { Panel } from "@workspace/ui/components/panel"
import { Badge } from "@workspace/ui/components/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"
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
import { Loader2Icon, PlugIcon, PlusIcon, TrashIcon } from "lucide-react"
import {
  getAgentTools,
  createAgentTool,
  deleteAgentTool,
} from "@/features/agent/hooks/use-agent"
import { TableSkeleton } from "@/components/skeletons"

export function AgentToolsPanel({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)

  const toolsQuery = useQuery({
    queryKey: ["agent-tools", workspaceId],
    queryFn: () => getAgentTools({ data: { workspaceId } }),
    staleTime: 15_000,
  })
  const tools = toolsQuery.data ?? []

  const createMutation = useMutation({
    mutationFn: (data: {
      workspaceId: string
      name: string
      description: string
      url: string
      method?: "GET" | "POST"
      parameters?: Record<string, unknown>
      authToken?: string
    }) => createAgentTool({ data }),
    onSuccess: () => {
      toast.success("Tool created")
      queryClient.invalidateQueries({ queryKey: ["agent-tools", workspaceId] })
      setOpen(false)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (data: { id: string; workspaceId: string }) =>
      deleteAgentTool({ data }),
    onSuccess: () => {
      toast.success("Tool deleted")
      queryClient.invalidateQueries({ queryKey: ["agent-tools", workspaceId] })
    },
  })

  return (
    <Panel className="flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <PlugIcon className="size-4 text-primary" />
            <h2 className="text-lg font-semibold">The tools it can use</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            The agent always has the built-in CRM tools (customer, deals,
            recent conversation, hand off to human). Add your own webhook
            here to let it call your systems — no code changes needed.
          </p>
        </div>
        <CreateAgentToolSheet
          workspaceId={workspaceId}
          open={open}
          onOpenChange={setOpen}
          onCreate={(data) => createMutation.mutate(data)}
          isPending={createMutation.isPending}
        />
      </div>

      {toolsQuery.isLoading ? (
        <TableSkeleton rows={3} columns={4} />
      ) : tools.length === 0 ? (
        <Empty className="py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PlugIcon />
            </EmptyMedia>
            <EmptyTitle>No custom tools yet</EmptyTitle>
            <EmptyDescription>
              Built-ins only. Add a webhook tool to unlock your own APIs.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Endpoint</TableHead>
              <TableHead>Auth</TableHead>
              <TableHead className="text-right">{""}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tools.map((t) => (
              <TableRow key={t.id}>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{t.name}</span>
                    <span className="max-w-64 truncate text-xs text-muted-foreground">
                      {t.description}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="max-w-56 truncate font-mono text-xs">
                  {t.url}
                </TableCell>
                <TableCell>
                  <Badge variant={t.hasAuth ? "secondary" : "outline"}>
                    {t.hasAuth ? "Bearer" : "None"}
                  </Badge>
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
                        <AlertDialogTitle>Delete tool?</AlertDialogTitle>
                        <AlertDialogDescription>
                          &ldquo;{t.name}&rdquo; will stop being offered to the
                          agent. This can&rsquo;t be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() =>
                            deleteMutation.mutate({ id: t.id, workspaceId })
                          }
                        >
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
      )}
    </Panel>
  )
}

export function CreateAgentToolSheet({
  workspaceId,
  open,
  onOpenChange,
  onCreate,
  isPending,
}: {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (
    data: {
      workspaceId: string
      name: string
      description: string
      url: string
      method?: "GET" | "POST"
      parameters?: Record<string, unknown>
      authToken?: string
    }
  ) => void
  isPending: boolean
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [url, setUrl] = useState("")
  const [method, setMethod] = useState<"GET" | "POST">("POST")
  const [parameters, setParameters] = useState("")
  const [authToken, setAuthToken] = useState("")

  function reset() {
    setName("")
    setDescription("")
    setUrl("")
    setMethod("POST")
    setParameters("")
    setAuthToken("")
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !description.trim() || !url.trim()) return

    let parsedParameters: Record<string, unknown> | undefined
    if (parameters.trim()) {
      try {
        parsedParameters = JSON.parse(parameters) as Record<string, unknown>
      } catch {
        toast.error("Parameters must be valid JSON")
        return
      }
    }

    onCreate({
      workspaceId,
      name: name.trim(),
      description: description.trim(),
      url: url.trim(),
      method,
      parameters: parsedParameters,
      authToken: authToken.trim() || undefined,
    })
    reset()
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger render={<Button />}>
        <PlusIcon />
        New Tool
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Add a webhook tool</SheetTitle>
          <SheetDescription>
            Give the agent one of your endpoints to call. The auth token is
            applied server-side only — never shown to the model or a customer.
          </SheetDescription>
        </SheetHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-6 py-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="tool-name">Name (how the agent calls it)</Label>
            <Input
              id="tool-name"
              placeholder="e.g. lookup_order"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="tool-description">
              Description (tells the agent when to use it)
            </Label>
            <Textarea
              id="tool-description"
              className="min-h-16"
              placeholder="e.g. Look up a customer's order by order number"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="tool-url">Endpoint URL</Label>
            <Input
              id="tool-url"
              type="url"
              placeholder="https://your-server.com/api/orders"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label>Method</Label>
            <Select
              value={method}
              onValueChange={(v) =>
                // `v` is cast, not verified -- Select's own value type is a
                // plain string, so guard the fallback for real.
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                setMethod((v as "GET" | "POST") ?? "POST")
              }
            >
              <SelectTrigger>
                <SelectValue>
                  {(v) => (v == null ? "" : v === "GET" ? "GET" : "POST")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="GET">GET</SelectItem>
                <SelectItem value="POST">POST</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="tool-params">Parameters (JSON Schema, optional)</Label>
            <Textarea
              id="tool-params"
              className="min-h-20 font-mono text-xs"
              placeholder='{"properties":{"orderId":{"type":"string","description":"Order number"}},"required":["orderId"]}'
              value={parameters}
              onChange={(e) => setParameters(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="tool-auth">Bearer token (optional)</Label>
            <Input
              id="tool-auth"
              type="password"
              placeholder="Sent as Authorization: Bearer …"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
            />
          </div>

          <SheetFooter>
            <Button
              type="submit"
              disabled={
                !name.trim() || !description.trim() || !url.trim() || isPending
              }
            >
              {isPending && <Loader2Icon className="animate-spin" />}
              Add tool
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}