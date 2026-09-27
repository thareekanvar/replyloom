import { useState } from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors
  
  
} from "@dnd-kit/core"
import type {DragEndEvent, DragStartEvent} from "@dnd-kit/core";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  getPipeline,
  getStageDeals,
  createDeal,
  moveDeal,
  updateDeal,
  deleteDeal,
} from "../hooks/use-pipeline"
import { PipelineColumn  } from "./pipeline-column"
import type {Stage} from "./pipeline-column";
import { DealCard  } from "./deal-card"
import type {Deal} from "./deal-card";
import { CreateDealDialog  } from "./create-deal-dialog"
import type {DealInput} from "./create-deal-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import { toast } from "sonner"
import { Panel } from "@workspace/ui/components/panel"
import { PipelineBoardSkeleton } from "@/components/skeletons"

export function PipelineBoard({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient()
  const queryKey = ["pipeline", workspaceId]
  const [activeDeal, setActiveDeal] = useState<Deal | null>(null)
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Deal | null>(null)
  // Must stay above the isLoading early return (Rules of Hooks).
  const [loadingStageId, setLoadingStageId] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => getPipeline({ data: { workspaceId } }),
    staleTime: 15_000,
  })

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  const createMutation = useMutation({
    mutationFn: (vars: DealInput) =>
      createDeal({ data: { workspaceId, ...vars } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success("Deal created")
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ dealId, ...vars }: DealInput & { dealId: string }) =>
      updateDeal({ data: { workspaceId, ...vars, dealId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success("Deal updated")
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (dealId: string) => deleteDeal({ data: { dealId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success("Deal deleted")
    },
  })

  const moveMutation = useMutation({
    mutationFn: (vars: { dealId: string; stageId: string; position: number }) =>
      moveDeal({ data: vars }),
    // Optimistic: the board should feel instant, not wait on a round trip
    // to reflect where the card was dropped.
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<typeof data>(queryKey)
      queryClient.setQueryData<typeof data>(queryKey, (old) =>
        old
          ? {
              ...old,
              deals: old.deals.map((d) =>
                d.id === vars.dealId
                  ? { ...d, stageId: vars.stageId, position: vars.position }
                  : d
              ),
            }
          : old
      )
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous)
        queryClient.setQueryData(queryKey, context.previous)
      toast.error("Couldn't move the deal. Please try again.")
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })

  function handleDragStart(event: DragStartEvent) {
    const deal = event.active.data.current?.deal as Deal | undefined
    if (deal) setActiveDeal(deal)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDeal(null)
    const dealId = event.active.id as string
    const stageId = event.over?.id as string | undefined
    if (!stageId) return

    const deal = data?.deals.find((d) => d.id === dealId)
    if (!deal || deal.stageId === stageId) return // dropped back in place

    moveMutation.mutate({ dealId, stageId, position: Date.now() })
  }

  function handleMoveToStage(deal: Deal, stageId: string) {
    moveMutation.mutate({ dealId: deal.id, stageId, position: Date.now() })
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 flex-col gap-4 overflow-hidden">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Pipeline</h2>
            <p className="text-sm text-muted-foreground">
              Drag deals between stages as they progress.
            </p>
          </div>
        </div>
        <Panel className="flex flex-1 flex-col overflow-hidden p-3">
          <PipelineBoardSkeleton />
        </Panel>
      </div>
    )
  }

  const stages: Stage[] = data?.stages ?? []
  const deals: Deal[] = data?.deals ?? []

  // Columns show their first page; "Load more" appends the next page of
  // that stage into the same cache entry (keeps drag-and-drop optimistic
  // updates working on one list).
  async function loadMoreForStage(stageId: string) {
    const stage = data?.stages.find((st) => st.id === stageId)
    if (!stage?.nextCursor || loadingStageId) return
    setLoadingStageId(stageId)
    try {
      const page = await getStageDeals({
        data: { workspaceId, stageId, cursor: stage.nextCursor },
      })
      queryClient.setQueryData<typeof data>(queryKey, (old) =>
        old
          ? {
              ...old,
              stages: old.stages.map((st) =>
                st.id === stageId ? { ...st, nextCursor: page.nextCursor } : st
              ),
              deals: [
                ...old.deals,
                ...page.items.filter((d) => !old.deals.some((x) => x.id === d.id)),
              ],
            }
          : old
      )
    } catch (err: any) {
      toast.error(err?.message ?? "Couldn't load more deals.")
    } finally {
      setLoadingStageId(null)
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-hidden">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Pipeline</h2>
          <p className="text-sm text-muted-foreground">
            Drag deals between stages as they progress.
          </p>
        </div>
        <CreateDealDialog
          workspaceId={workspaceId}
          stages={stages}
          deal={editingDeal}
          onCreate={(vars) => createMutation.mutateAsync(vars)}
          onUpdate={(dealId, vars) =>
            updateMutation.mutateAsync({ ...vars, dealId })
          }
          onCancelEdit={() => setEditingDeal(null)}
        />
      </div>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this deal?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{deleteTarget?.title}&rdquo; will be permanently removed
              from the pipeline. This can&rsquo;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget)
                  deleteMutation.mutate(deleteTarget.id)
                setDeleteTarget(null)
              }}
              disabled={deleteMutation.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Panel className="flex flex-1 flex-col overflow-hidden p-3">
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex flex-1 gap-3 overflow-x-auto pb-2">
            {stages.map((stage) => (
              <PipelineColumn
                key={stage.id}
                stage={stage}
                stages={stages}
                deals={deals.filter((d) => d.stageId === stage.id)}
                hasMore={!!data?.stages.find((st) => st.id === stage.id)?.nextCursor}
                loadingMore={loadingStageId === stage.id}
                onLoadMore={() => loadMoreForStage(stage.id)}
                onEdit={setEditingDeal}
                onDelete={setDeleteTarget}
                onMoveToStage={handleMoveToStage}
              />
            ))}
          </div>
          <DragOverlay>
            {activeDeal && (
              <DealCard
                deal={activeDeal}
                dragging
                stages={stages}
                onEdit={() => {}}
                onDelete={() => {}}
                onMoveToStage={() => {}}
              />
            )}
          </DragOverlay>
        </DndContext>
      </Panel>
    </div>
  )
}
