import { useState, useRef  } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Textarea } from "@workspace/ui/components/textarea"
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
import { Loader2Icon, BookOpenIcon, TrashIcon, PlusIcon, UploadIcon } from "lucide-react"
import { TableSkeleton } from "@/components/skeletons"
import {
  ingestAgentDocument,
  getKnowledgeBase,
  deleteKnowledgeDoc
  
} from "@/features/agent/hooks/use-agent"
import type {KnowledgeDoc} from "@/features/agent/hooks/use-agent";
import { extractTextFromDocument } from "@/features/agent/lib/extract-document"

const MAX_DOC_CHARS = 100_000

export function AgentKnowledgePanel({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient()

  const kbQuery = useQuery({
    queryKey: ["agent-knowledge", workspaceId],
    queryFn: () => getKnowledgeBase({ data: { workspaceId } }),
    staleTime: 15_000,
  })

  const [source, setSource] = useState("")
  const [docId, setDocId] = useState("")
  const [text, setText] = useState("")
  const [loadingDoc, setLoadingDoc] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleFile(file?: File | null) {
    if (!file) return
    setLoadingDoc(true)
    try {
      const { source: name, text: extracted } = await extractTextFromDocument(file)
      setSource(name)
      setText(extracted)
      toast.success(
        `Loaded ${file.name}${extracted.length >= MAX_DOC_CHARS - 1_000 ? ` — over the ${MAX_DOC_CHARS.toLocaleString()}-char limit, trim it before ingesting.` : " — review then Ingest"}`
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read that file.")
    } finally {
      setLoadingDoc(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const ingestMutation = useMutation({
    mutationFn: (data: {
      workspaceId: string
      source: string
      text: string
      docId?: string
    }) => ingestAgentDocument({ data }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({
        queryKey: ["agent-knowledge", workspaceId],
      })
      toast.success(
        `Ingested ${res?.chunks ?? 0} chunk(s) into the knowledge base${
          res?.deleted ? `, replaced ${res.deleted} old` : ""
        }`
      )
      setSource("")
      setDocId("")
      setText("")
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (doc: KnowledgeDoc) =>
      deleteKnowledgeDoc({
        data: {
          workspaceId,
          docId: doc.docId,
          source: doc.docId ? undefined : doc.source,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["agent-knowledge", workspaceId],
      })
      toast.success("Document removed from the knowledge base")
    },
  })

  const docs = kbQuery.data ?? []
  const canIngest = !!source.trim() && !!text.trim() && text.length <= MAX_DOC_CHARS

  return (
    <div className="flex flex-col gap-4">
      <Panel className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <BookOpenIcon className="size-4 text-primary" />
            <h2 className="text-lg font-semibold">Knowledge base</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Documents your agent can answer from. The agent only ever answers
            from this content — anything else gets handed to a human.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="kb-source">Source name</Label>
            <Input
              id="kb-source"
              placeholder="e.g. shipping-policy"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="kb-docid">Document ID (optional)</Label>
            <Input
              id="kb-docid"
              placeholder="Re-uploading the same ID replaces it"
              value={docId}
              onChange={(e) => setDocId(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="kb-text">Document content</Label>
          <Textarea
            id="kb-text"
            className="min-h-40"
            placeholder="Paste the doc the agent should know — policies, FAQs, product specs…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {text.length.toLocaleString()} / {MAX_DOC_CHARS.toLocaleString()}{" "}
              characters
            </p>
            <div className="flex gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.markdown,.csv,.json,.log,.html,.htm,.xml,.yaml,.yml,application/pdf,text/*"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={loadingDoc}
              >
                {loadingDoc ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <UploadIcon />
                )}
                Upload file
              </Button>
              <Button
                onClick={() =>
                  ingestMutation.mutate({
                    workspaceId,
                    source: source.trim(),
                    text,
                    docId: docId.trim() || undefined,
                  })
                }
                disabled={!canIngest || ingestMutation.isPending}
              >
                {ingestMutation.isPending && (
                  <Loader2Icon className="animate-spin" />
                )}
                <PlusIcon />
                Ingest document
              </Button>
            </div>
          </div>
        </div>
      </Panel>

      <Panel>
        {kbQuery.isLoading ? (
          <TableSkeleton rows={3} columns={4} />
        ) : docs.length === 0 ? (
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BookOpenIcon />
              </EmptyMedia>
              <EmptyTitle>No documents yet</EmptyTitle>
              <EmptyDescription>
                Ingest your policies and FAQs above so the agent can answer
                from them.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Document ID</TableHead>
                <TableHead>Chunks</TableHead>
                <TableHead className="text-right">{""}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.map((d) => (
                <TableRow key={d.docId ?? d.source}>
                  <TableCell className="max-w-64 truncate font-medium">
                    {d.source}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {d.docId ?? "(none)"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{d.chunks}</Badge>
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
                          <AlertDialogTitle>Remove document?</AlertDialogTitle>
                          <AlertDialogDescription>
                            &ldquo;{d.source}&rdquo; ({d.chunks} chunk
                            {d.chunks === 1 ? "" : "s"}) will stop being used
                            as grounding. This can&rsquo;t be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => deleteMutation.mutate(d)}>
                            Remove
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
    </div>
  )
}