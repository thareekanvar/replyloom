import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Textarea } from "@workspace/ui/components/textarea"
import { Switch } from "@workspace/ui/components/switch"
import { Panel } from "@workspace/ui/components/panel"
import { Badge } from "@workspace/ui/components/badge"
import { Loader2Icon, SparklesIcon, SaveIcon } from "lucide-react"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  getAgentConfig,
  updateAgentConfig,
} from "@/features/agent/hooks/use-agent"

export function AgentConfigPanel({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient()

  const configQuery = useQuery({
    queryKey: ["agent-config", workspaceId],
    queryFn: () => getAgentConfig({ data: { workspaceId } }),
    staleTime: 30_000,
  })

  const config = configQuery.data

  const [enabled, setEnabled] = useState(false)
  const [businessName, setBusinessName] = useState("")
  const [scopeDescription, setScopeDescription] = useState("")
  const [systemPrompt, setSystemPrompt] = useState("")
  const [replyInGroups, setReplyInGroups] = useState(false)
  const [formLoadedFor, setFormLoadedFor] = useState<string | undefined>()

  const saveMutation = useMutation({
    mutationFn: (data: {
      workspaceId: string
      enabled: boolean
      businessName: string
      scopeDescription: string
      systemPrompt: string
      replyInGroups: boolean
    }) => updateAgentConfig({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-config", workspaceId] })
      toast.success("Agent settings saved")
    },
  })

  if (configQuery.isLoading) {
    return (
      <Panel className="flex flex-col gap-5 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-3 w-64" />
          </div>
          <Skeleton className="h-6 w-10 rounded-full" />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-24 w-full rounded-md" />
        </div>
        <Skeleton className="h-9 w-28 self-end rounded-md" />
      </Panel>
    )
  }

  // `systemPrompt` is a nullable D1 column (packages/db/src/schema/agent.ts)
  // even though the API response type declares it as `string` -- default
  // it defensively rather than trust that type all the way through.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  if (formLoadedFor !== workspaceId && config) {
    setFormLoadedFor(workspaceId)
    setEnabled(config.enabled)
    setBusinessName(config.businessName)
    setScopeDescription(config.scopeDescription)
    setSystemPrompt(config.systemPrompt ?? "")
    setReplyInGroups(config.replyInGroups)
  }

  const dirty =
    !formLoadedFor || !config
      ? false
      : enabled !== config.enabled ||
        businessName !== config.businessName ||
        scopeDescription !== config.scopeDescription ||
        systemPrompt !== (config.systemPrompt ?? "") ||
        replyInGroups !== config.replyInGroups
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */

  return (
    <Panel className="p-4 sm:p-5">
      <div className="flex flex-col gap-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1 pr-2">
            <div className="flex items-center gap-2">
              <SparklesIcon className="size-4 text-primary" />
              <h2 className="text-lg font-semibold">AI Agent</h2>
              <Badge variant={enabled ? "default" : "outline"}>
                {enabled ? "On" : "Off"}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Answers messages the keyword rules don&rsquo;t catch — grounded
              in your knowledge base and handed to a human when it&rsquo;s out
              of scope.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Enable AI agent"
            />
            <span className="text-xs text-muted-foreground">
              {enabled ? "Active" : "Standing by"}
            </span>
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-business-name">Business name</Label>
            <Input
              id="agent-business-name"
              placeholder="e.g. Acme Coffee Roasters"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              How the agent introduces itself.
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-3">
            <div className="flex flex-col gap-0.5">
              <Label className="text-sm">Reply in groups</Label>
              <p className="text-xs text-muted-foreground">
                Off by default — it only answers private chats.
              </p>
            </div>
            <Switch
              checked={replyInGroups}
              onCheckedChange={setReplyInGroups}
              aria-label="Reply in groups"
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="agent-scope">What you support</Label>
          <Textarea
            id="agent-scope"
            className="min-h-24"
            placeholder="e.g. Coffee subscriptions, order questions, machine advice. We don't do custom roasting requests."
            value={scopeDescription}
            onChange={(e) => setScopeDescription(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Anything outside this is politely refused and handed to a human.
          </p>
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/20 p-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="agent-system-prompt" className="text-sm font-semibold">
              Custom system prompt
            </Label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Add business-specific instructions for how the AI should respond.
              These are added to the support agent&rsquo;s base rules and knowledge
              grounding.
            </p>
          </div>
          <Textarea
            id="agent-system-prompt"
            className="min-h-36 resize-y bg-background"
            placeholder={`Example:\n- Be warm and concise.\n- Always mention our 30-day return policy for refund questions.\n- Ask for the order number before checking an order.`}
            value={systemPrompt}
            maxLength={4000}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>Do not include API keys, passwords, or other secrets.</span>
            <span>{systemPrompt.length}/4000</span>
          </div>
        </div>

        {dirty && (
          <div className="flex justify-end">
            <Button
              onClick={() =>
                saveMutation.mutate({
                  workspaceId,
                  enabled,
                  businessName: businessName.trim(),
                  scopeDescription: scopeDescription.trim(),
                  systemPrompt: systemPrompt.trim(),
                  replyInGroups,
                })
              }
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending && (
                <Loader2Icon className="animate-spin" />
              )}
              <SaveIcon />
              {saveMutation.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        )}
      </div>
    </Panel>
  )
}
