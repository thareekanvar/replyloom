import { createFileRoute, useRouteContext } from "@tanstack/react-router"
import { PipelineBoard } from "@/features/pipeline/components/pipeline-board"

export const Route = createFileRoute("/_app/pipeline")({
  staticData: { title: "Pipeline" },
  component: PipelinePage,
})

function PipelinePage() {
  const { workspaceId } = useRouteContext({ from: "/_app" })
  return <PipelineBoard workspaceId={workspaceId} />
}
