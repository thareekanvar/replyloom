import { AgentConfigPanel } from "@/features/agent/components/agent-config-panel"
import { AgentTestPanel } from "@/features/agent/components/agent-test-panel"
import { AgentKnowledgePanel } from "@/features/agent/components/agent-knowledge-panel"
import { AgentToolsPanel } from "@/features/agent/components/agent-tools-panel"
import { AgentEscalationsPanel } from "@/features/agent/components/agent-escalations-panel"
import type { AgentSubView } from "@/components/automation-nav"

export function AgentSection({
  workspaceId,
  view,
}: {
  workspaceId: string
  view: AgentSubView
}) {
  switch (view) {
    case "knowledge":
      return <AgentKnowledgePanel workspaceId={workspaceId} />
    case "tools":
      return <AgentToolsPanel workspaceId={workspaceId} />
    case "escalations":
      return <AgentEscalationsPanel workspaceId={workspaceId} />
    case "setup":
    default:
      return (
        <div className="flex flex-col gap-6">
          <AgentConfigPanel workspaceId={workspaceId} />
          <AgentTestPanel workspaceId={workspaceId} />
        </div>
      )
  }
}