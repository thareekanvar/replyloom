import { createFileRoute, useRouteContext } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import {
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { Panel } from "@workspace/ui/components/panel"
import { toast } from "sonner"
import {
  getAutoReplyRules,
  createAutoReplyRule,
  updateAutoReplyRule,
  toggleAutoReplyRule,
  deleteAutoReplyRule,
} from "@/features/settings/hooks/use-settings"
import {
  AutoReplyList
  
} from "@/features/settings/components/auto-reply-list"
import type {AutoReplyRule} from "@/features/settings/components/auto-reply-list";
import {
  CreateAutoReplyDialog
  
} from "@/features/settings/components/create-auto-reply-dialog"
import type {CreateAutoReplyInput} from "@/features/settings/components/create-auto-reply-dialog";
import {
  getTemplatesPage,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from "@/features/templates/hooks/use-templates"
import {
  TemplateList
  
} from "@/features/templates/components/template-list"
import type {TemplateRow} from "@/features/templates/components/template-list";
import {
  CreateTemplateDialog
  
} from "@/features/templates/components/create-template-dialog"
import type {CreateTemplateInput} from "@/features/templates/components/create-template-dialog";
import {
  getMediaAssetsPage,
  createMediaAsset,
  deleteMediaAsset,
} from "@/features/media/hooks/use-media-assets"
import { GalleryGrid } from "@/features/media/components/gallery-grid"
import { UploadAssetButton } from "@/features/media/components/upload-asset-button"
import { AgentSection } from "@/features/agent/components/agent-tab"
import { AutomationNav  } from "@/components/automation-nav"
import type {AutomationView} from "@/components/automation-nav";
import { TableSkeleton, CardGridSkeleton } from "@/components/skeletons"
import { LoadMoreButton } from "@/components/load-more-button"
import { shownOf, totalOf } from "@/lib/format-count"

export const Route = createFileRoute("/_app/automation")({
  staticData: { title: "Automation" },
  validateSearch: (
    search: Record<string, unknown>
  ): {
    view?: "agent"
    tab?: "setup" | "knowledge" | "tools" | "escalations"
  } => ({
    ...(search.view === "agent" ? { view: "agent" as const } : {}),
    ...(search.tab === "knowledge" ||
    search.tab === "tools" ||
    search.tab === "escalations"
      ? { tab: search.tab }
      : {}),
  }),
  component: AutomationPage,
})

function AutomationPage() {
  const { workspaceId } = useRouteContext({ from: "/_app" })
  const queryClient = useQueryClient()
  const requested = Route.useSearch()
  const [view, setView] = useState<AutomationView>(
    requested.view === "agent"
      ? { kind: "agent", tab: requested.tab ?? "setup" }
      : { kind: "gallery" }
  )
  useEffect(() => {
    if (requested.view === "agent")
      setView({ kind: "agent", tab: requested.tab ?? "setup" })
  }, [requested.view, requested.tab])

  // ── Media gallery ──
  const assetsQuery = useInfiniteQuery({
    queryKey: ["media-assets", workspaceId, "paged"],
    queryFn: ({ pageParam }) =>
      getMediaAssetsPage({ data: { workspaceId, cursor: pageParam } }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 15_000,
  })

  const deleteAssetMutation = useMutation({
    mutationFn: (data: { id: string; mediaKey: string }) =>
      deleteMediaAsset({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media-assets", workspaceId] })
      toast.success("Asset deleted")
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't delete the asset."),
  })

  function handleUploaded(asset: {
    mediaKey: string
    mediaMime: string
    mediaType: "image" | "video" | "audio" | "document"
    fileName: string
    fileSizeBytes: number
  }) {
    createMediaAsset({ data: { workspaceId, ...asset } }).then(() => {
      queryClient.invalidateQueries({ queryKey: ["media-assets", workspaceId] })
    })
  }

  // ── Auto-reply ──
  const rulesQuery = useQuery({
    queryKey: ["auto-reply-rules", workspaceId],
    queryFn: () => getAutoReplyRules({ data: { workspaceId } }),
    staleTime: 15_000,
  })

  const createRuleMutation = useMutation({
    mutationFn: (data: CreateAutoReplyInput) =>
      createAutoReplyRule({ data: { workspaceId, ...data } }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["auto-reply-rules", workspaceId],
      })
      toast.success("Auto-reply rule created")
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't create the rule."),
  })

  const updateRuleMutation = useMutation({
    mutationFn: (vars: { id: string } & CreateAutoReplyInput) =>
      updateAutoReplyRule({ data: vars }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["auto-reply-rules", workspaceId],
      })
      toast.success("Rule updated")
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't update the rule."),
  })

  const toggleRuleMutation = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      toggleAutoReplyRule({ data: vars }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["auto-reply-rules", workspaceId],
      }),
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't update the rule."),
  })

  const deleteRuleMutation = useMutation({
    mutationFn: (id: string) => deleteAutoReplyRule({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["auto-reply-rules", workspaceId],
      })
      toast.success("Rule deleted")
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't delete the rule."),
  })

  const [editingRule, setEditingRule] = useState<AutoReplyRule | null>(null)
  const [editingTemplate, setEditingTemplate] = useState<TemplateRow | null>(
    null
  )

  // ── Templates (one shared list — every template is available in both the
  // composer picker and the broadcast dialog) ──
  const templatesQuery = useInfiniteQuery({
    queryKey: ["templates", workspaceId, "paged"],
    queryFn: ({ pageParam }) =>
      getTemplatesPage({ data: { workspaceId, cursor: pageParam } }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 15_000,
  })

  const createTemplateMutation = useMutation({
    mutationFn: (data: CreateTemplateInput) =>
      createTemplate({ data: { workspaceId, ...data } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["templates", workspaceId] })
      toast.success("Template created")
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't create the template."),
  })

  const updateTemplateMutation = useMutation({
    mutationFn: (vars: { id: string } & CreateTemplateInput) =>
      updateTemplate({ data: vars }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["templates", workspaceId] })
      toast.success("Template updated")
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't update the template."),
  })

  const deleteTemplateMutation = useMutation({
    mutationFn: (id: string) => deleteTemplate({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["templates", workspaceId] })
      toast.success("Template deleted")
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't delete the template."),
  })

  const templates =
    templatesQuery.data?.pages.flatMap((page) => page.items) ?? []
  const assets = assetsQuery.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Automation</h1>
        <p className="text-sm text-muted-foreground">
          The building blocks that go into a conversation without being typed
          fresh each time — reusable media and templates, keyword auto-replies,
          and the AI agent.
        </p>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-4 lg:flex-row">
        <AutomationNav view={view} onSelect={setView} />

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {view.kind === "gallery" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Media Gallery</h2>
                  <p className="text-sm text-muted-foreground">
                    Upload once, reuse everywhere — templates and broadcasts can
                    pick from here instead of re-uploading.
                  </p>
                </div>
                <UploadAssetButton onUploaded={handleUploaded} />
              </div>
              <Panel className="p-3">
                {assetsQuery.isLoading ? (
                  <CardGridSkeleton
                    count={5}
                    columns="sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
                  />
                ) : (
                  <GalleryGrid
                    assets={assets}
                    onDelete={(a) =>
                      deleteAssetMutation.mutate({
                        id: a.id,
                        mediaKey: a.mediaKey,
                      })
                    }
                  />
                )}
                <LoadMoreButton
                  hasMore={!!assetsQuery.hasNextPage}
                  loading={assetsQuery.isFetchingNextPage}
                  onLoadMore={() => assetsQuery.fetchNextPage()}
                  label="Load more media"
                  shown={shownOf(assetsQuery.data)}
                  total={totalOf(assetsQuery.data)}
                />
              </Panel>
            </>
          )}

          {view.kind === "auto-reply" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Auto-Reply Rules</h2>
                  <p className="text-sm text-muted-foreground">
                    Reply automatically to messages that match a keyword.
                  </p>
                </div>
                <CreateAutoReplyDialog
                  workspaceId={workspaceId}
                  rule={editingRule}
                  onCreate={(data) => createRuleMutation.mutateAsync(data)}
                  onUpdate={(id, data) =>
                    updateRuleMutation.mutateAsync({ id, ...data })
                  }
                  onCancelEdit={() => setEditingRule(null)}
                />
              </div>
              <Panel>
                {rulesQuery.isLoading ? (
                  <TableSkeleton rows={4} columns={6} />
                ) : (
                  <AutoReplyList
                    rules={rulesQuery.data ?? []}
                    onToggle={(id, enabled) =>
                      toggleRuleMutation.mutate({ id, enabled })
                    }
                    onDelete={(id) => deleteRuleMutation.mutate(id)}
                    onEdit={setEditingRule}
                  />
                )}
              </Panel>
            </>
          )}

          {view.kind === "templates" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Templates</h2>
                  <p className="text-sm text-muted-foreground">
                    Reusable messages quick-inserted from the composer or used
                    for broadcasts, with {"{{name}}"}-style variables filled in
                    per recipient.
                  </p>
                </div>
                <CreateTemplateDialog
                  workspaceId={workspaceId}
                  template={editingTemplate}
                  onCreate={(data) => createTemplateMutation.mutateAsync(data)}
                  onUpdate={(id, data) =>
                    updateTemplateMutation.mutateAsync({ id, ...data })
                  }
                  onCancelEdit={() => setEditingTemplate(null)}
                />
              </div>
              <Panel>
                {templatesQuery.isLoading ? (
                  <TableSkeleton rows={4} columns={6} />
                ) : (
                  <TemplateList
                    templates={templates}
                    onDelete={(id) => deleteTemplateMutation.mutate(id)}
                    onEdit={setEditingTemplate}
                  />
                )}
                <LoadMoreButton
                  hasMore={!!templatesQuery.hasNextPage}
                  loading={templatesQuery.isFetchingNextPage}
                  onLoadMore={() => templatesQuery.fetchNextPage()}
                  label="Load more templates"
                  shown={shownOf(templatesQuery.data)}
                  total={totalOf(templatesQuery.data)}
                />
              </Panel>
            </>
          )}

          {view.kind === "agent" && (
            <AgentSection workspaceId={workspaceId} view={view.tab} />
          )}
        </div>
      </div>
    </div>
  )
}
