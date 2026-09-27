import { useState } from "react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"
import { Loader2Icon, PlusIcon } from "lucide-react"

const MAX_DOC_CHARS = 100_000

export function IngestAgentDocSheet({
  workspaceId,
  onIngest,
  isPending,
}: {
  workspaceId: string
  onIngest: (data: {
    workspaceId: string
    source: string
    text: string
    docId?: string
  }) => void
  isPending: boolean
}) {
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState("")
  const [docId, setDocId] = useState("")
  const [text, setText] = useState("")

  const overLimit = text.length > MAX_DOC_CHARS
  const canSubmit = Boolean(source.trim()) && Boolean(text.trim()) && !overLimit

  function reset() {
    setSource("")
    setDocId("")
    setText("")
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || isPending) return
    onIngest({
      workspaceId,
      source: source.trim(),
      text,
      docId: docId.trim() || undefined,
    })
    // Clear the form on success — the parent closes the sheet and toasts.
    // (the `!canSubmit || isPending` guard above already returned early,
    // so `isPending` is always false here — no need to check it again.)
    reset()
    setOpen(false)
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button />}>
        <PlusIcon />
        Add document
      </SheetTrigger>
      <SheetContent side="right" className="gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle>Add to the knowledge base</SheetTitle>
          <SheetDescription>
            The agent only answers from this content — anything else gets
            handed to a human.
          </SheetDescription>
        </SheetHeader>

        <form
          id="ingest-agent-doc-form"
          onSubmit={handleSubmit}
          className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="doc-source">Source name</Label>
            <Input
              id="doc-source"
              placeholder="e.g. shipping-policy"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              autoFocus
              required
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="doc-docid">Document ID (optional)</Label>
            <Input
              id="doc-docid"
              placeholder="Re-adding the same ID replaces it"
              value={docId}
              onChange={(e) => setDocId(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Give the same ID to a newer version to swap it in place.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="doc-text">Document content</Label>
              <span className="text-xs text-muted-foreground tabular-nums">
                {text.length.toLocaleString()}
                <span className="opacity-60">
                  /{MAX_DOC_CHARS.toLocaleString()}
                </span>
              </span>
            </div>
            <textarea
              id="doc-text"
              className={`min-h-44 resize-none rounded-xl border bg-input/50 px-3 py-2.5 text-sm shadow-xs transition-[border-color,box-shadow,background-color] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 ${
                overLimit
                  ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20"
                  : ""
              }`}
              placeholder="Paste the doc the agent should know — policies, FAQs, product specs…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
            />
            {overLimit && (
              <p className="text-xs text-destructive">
                That&rsquo;s over the {MAX_DOC_CHARS.toLocaleString()}
                -character limit.
              </p>
            )}
          </div>
        </form>

        <SheetFooter className="border-t bg-popover px-6 py-4">
          <Button
            form="ingest-agent-doc-form"
            type="submit"
            disabled={!canSubmit || isPending}
            className="w-full"
          >
            {isPending ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <PlusIcon />
            )}
            {isPending ? "Ingesting…" : "Add document"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}