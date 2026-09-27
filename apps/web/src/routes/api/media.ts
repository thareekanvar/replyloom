import { createFileRoute } from "@tanstack/react-router"
import { proxyWorkspaceMedia } from "@/lib/wa-server"

export const Route = createFileRoute("/api/media")({
  server: {
    handlers: {
      GET: ({ request }) => proxyWorkspaceMedia(request),
    },
  },
})
