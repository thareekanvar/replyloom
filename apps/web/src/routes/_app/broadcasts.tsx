// `onError`'s `err` is typed `Error`, but createServerFn's RPC
// boundary doesn't actually guarantee that shape survives the
// round trip -- keep the `err?.message ?? fallback` defensive
// reads below rather than trust the annotation blindly.
/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { createFileRoute, useRouteContext } from "@tanstack/react-router"
import { useState } from "react"
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { LoadMoreButton } from "@/components/load-more-button"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"
import { toast } from "sonner"
import {
  getCampaigns,
  createCampaign,
  deleteCampaign,
  getScheduledMessages,
  createScheduledMessage,
  cancelScheduledMessage,
} from "@/features/broadcasts/hooks/use-broadcasts"
import { CampaignList } from "@/features/broadcasts/components/campaign-list"
import { CreateCampaignDialog } from "@/features/broadcasts/components/create-campaign-dialog"
import type { BroadcastCampaignInput } from "@/features/broadcasts/components/create-campaign-dialog"
import { ScheduledList } from "@/features/broadcasts/components/scheduled-list"
import { CreateScheduledDialog } from "@/features/broadcasts/components/create-scheduled-dialog"
import type { ScheduledMessageInput } from "@/features/broadcasts/components/create-scheduled-dialog"
import { Panel } from "@workspace/ui/components/panel"
import { TableSkeleton } from "@/components/skeletons"
import { shownOf, totalOf } from "@/lib/format-count"

export const Route = createFileRoute("/_app/broadcasts")({
  staticData: { title: "Broadcasts" },
  component: BroadcastsPage,
})

function BroadcastsPage() {
  const { workspaceId } = useRouteContext({ from: "/_app" })
  const queryClient = useQueryClient()
  const [tab, setTab] = useState("campaigns")

  const campaignsQuery = useInfiniteQuery({
    queryKey: ["broadcast-campaigns", workspaceId],
    queryFn: ({ pageParam }) =>
      getCampaigns({ data: { workspaceId, cursor: pageParam } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 10_000,
    // No polling: campaigns move server-side (queue + scheduler), and the
    // worker pushes `campaign-progress` events over the session WebSocket.
    // RealtimeProvider patches sent/failed/pending counts in place per
    // recipient and refetches once on each status change
    // (running / completed / failed).
  })

  const scheduledQuery = useInfiniteQuery({
    queryKey: ["scheduled-messages", workspaceId],
    queryFn: ({ pageParam }) =>
      getScheduledMessages({ data: { workspaceId, cursor: pageParam } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 15_000,
  })

  const createCampaignMutation = useMutation({
    mutationFn: (data: BroadcastCampaignInput) =>
      createCampaign({ data: { workspaceId, ...data } }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["broadcast-campaigns", workspaceId],
      })
      toast.success("Broadcast created")
    },
    onError: (err: Error) =>
      toast.error(err?.message ?? "Couldn't create the broadcast."),
  })

  const deleteCampaignMutation = useMutation({
    mutationFn: (campaignId: string) =>
      deleteCampaign({ data: { campaignId } }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({
        queryKey: ["broadcast-campaigns", workspaceId],
      })
      if (res.reason === "running") {
        toast.error("You can't delete a broadcast while it's sending.")
        return
      }
      toast.success("Broadcast deleted")
    },
    onError: (err: Error) =>
      toast.error(err?.message ?? "Couldn't delete the broadcast."),
  })

  const createScheduledMutation = useMutation({
    mutationFn: (data: ScheduledMessageInput) =>
      createScheduledMessage({ data: { workspaceId, ...data } }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["scheduled-messages", workspaceId],
      })
      toast.success("Message scheduled")
    },
    onError: (err: Error) =>
      toast.error(err?.message ?? "Couldn't schedule the message."),
  })

  const cancelScheduledMutation = useMutation({
    mutationFn: (id: string) => cancelScheduledMessage({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["scheduled-messages", workspaceId],
      })
      toast.success("Scheduled message cancelled")
    },
    onError: (err: Error) =>
      toast.error(err?.message ?? "Couldn't cancel the message."),
  })

  return (
    <div className="flex flex-1 flex-col gap-4">
      <Tabs value={tab} onValueChange={(value) => setTab(value ?? "campaigns")}>
        <div className="flex items-center justify-between">
          <TabsList>
            <TabsTrigger value="campaigns">Broadcasts</TabsTrigger>
            <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
          </TabsList>
          {tab === "campaigns" ? (
            <CreateCampaignDialog
              workspaceId={workspaceId}
              onCreate={(data) => createCampaignMutation.mutateAsync(data)}
            />
          ) : (
            <CreateScheduledDialog
              workspaceId={workspaceId}
              onCreate={(data) => createScheduledMutation.mutateAsync(data)}
            />
          )}
        </div>

        <TabsContent value="campaigns" className="mt-4">
          <Panel>
            {campaignsQuery.isLoading ? (
              <TableSkeleton rows={5} columns={5} />
            ) : (
              <CampaignList
                campaigns={campaignsQuery.data?.pages.flatMap((p) => p.items) ?? []}
                onDelete={(id) => deleteCampaignMutation.mutate(id)}
              />
            )}
            <LoadMoreButton
              hasMore={!!campaignsQuery.hasNextPage}
              shown={shownOf(campaignsQuery.data)}
              total={totalOf(campaignsQuery.data)}
              loading={campaignsQuery.isFetchingNextPage}
              onLoadMore={() => campaignsQuery.fetchNextPage()}
            />
          </Panel>
        </TabsContent>
        <TabsContent value="scheduled" className="mt-4">
          <Panel>
            {scheduledQuery.isLoading ? (
              <TableSkeleton rows={5} columns={4} />
            ) : (
              <ScheduledList
                messages={scheduledQuery.data?.pages.flatMap((p) => p.items) ?? []}
                onCancel={(id) => cancelScheduledMutation.mutate(id)}
              />
            )}
            <LoadMoreButton
              hasMore={!!scheduledQuery.hasNextPage}
              shown={shownOf(scheduledQuery.data)}
              total={totalOf(scheduledQuery.data)}
              loading={scheduledQuery.isFetchingNextPage}
              onLoadMore={() => scheduledQuery.fetchNextPage()}
            />
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  )
}

/* eslint-enable @typescript-eslint/no-unnecessary-condition */
