import { useState } from "react"
import { useQuery, useMutation } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Panel } from "@workspace/ui/components/panel"
import { Badge } from "@workspace/ui/components/badge"
import { Loader2Icon, SendIcon, SparklesIcon } from "lucide-react"
import {
  getAgentConfig,
  testAgentReply
  
} from "@/features/agent/hooks/use-agent"
import type {AgentReplyResult} from "@/features/agent/hooks/use-agent";

export function AgentTestPanel({ workspaceId }: { workspaceId: string }) {
  const configQuery = useQuery({
    queryKey: ["agent-config", workspaceId],
    queryFn: () => getAgentConfig({ data: { workspaceId } }),
    staleTime: 30_000,
  })

  const [message, setMessage] = useState("")
  const testMutation = useMutation({
    mutationFn: (msg: string) =>
      testAgentReply({ data: { workspaceId, message: msg } }),
  })

  const enabled = configQuery.data?.enabled ?? false
  const canRun = enabled && message.trim().length > 0 && !testMutation.isPending

  function run() {
    if (!canRun) return
    testMutation.mutate(message.trim())
  }

  return (
    <Panel className="p-4 sm:p-5">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <SparklesIcon className="size-4 text-primary" />
            <h2 className="text-lg font-semibold">Try it</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Send a sample customer message and preview the real pipeline —
            intent check, knowledge base, tools.
          </p>
        </div>

        <div className="flex gap-2">
          <Input
            placeholder='e.g. "Where is my order?"'
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") run()
            }}
          />
          <Button onClick={run} disabled={!canRun}>
            {testMutation.isPending ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <SendIcon />
            )}
            Test
          </Button>
        </div>

        {!enabled && (
          <p className="text-xs text-muted-foreground">
            The agent is off — turn it on in the panel above to test it.
          </p>
        )}

        {testMutation.data && (
          <ReplyResult result={testMutation.data} />
        )}
        {testMutation.isError && (
          <p className="text-sm text-destructive">
            {(testMutation.error).message}
          </p>
        )}
      </div>
    </Panel>
  )
}

function ReplyResult({ result }: { result: AgentReplyResult }) {
  // `result` is a `res as AgentReplyResult` cast on a raw worker-fetch
  // response (use-agent.ts) -- the interface's `usedTools`/`usedContext`
  // arrays are declared required, but nothing actually guarantees the
  // response shape matches at runtime, so keep the optional chains.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {result.cached && <Badge variant="outline">Cached</Badge>}
        {result.blocked && (
          <Badge variant="secondary">Refused — {result.blockReason}</Badge>
        )}
        {result.usedTools?.length > 0 && (
          <Badge variant="outline">
            Tools: {result.usedTools.join(", ")}
          </Badge>
        )}
        {result.usedContext?.length > 0 && (
          <Badge variant="outline">
            {result.usedContext.length} source
            {result.usedContext.length === 1 ? "" : "s"}
          </Badge>
        )}
        {!result.blocked && !result.usedTools?.length && !result.usedContext?.length && (
          <Badge variant="outline">Prompt only</Badge>
        )}
      </div>
      {/* eslint-enable @typescript-eslint/no-unnecessary-condition */}
      <p className="whitespace-pre-wrap text-sm">{result.text || "(no reply)"}</p>
    </div>
  )
}