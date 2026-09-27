import { useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"
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
import { normalizePhoneNumber } from "@workspace/db/phone"
import { getSessions } from "@/features/integrations/hooks/use-sessions"
import { MAX_IMPORT_ROWS_PER_CALL, bulkImportContacts } from "../hooks/use-contacts"
import type { BulkImportRow } from "../hooks/use-contacts"
import {
  UploadIcon,
  FileSpreadsheetIcon,
  CheckCircle2Icon,
  XCircleIcon,
} from "lucide-react"
import { toast } from "sonner"

/** Per-file ceiling -- bigger lists should be split (keeps D1 write bursts sane). */
const MAX_IMPORT_ROWS = 50_000

// Minimal RFC4180-ish CSV parser — handles quoted fields (with embedded
// commas/newlines) without pulling in a CSV dependency for two columns.
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ",") {
      row.push(field)
      field = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else {
      field += c
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0))
}

function toRawRows(raw: string[][]): BulkImportRow[] {
  if (raw.length === 0) return []

  const header = raw[0].map((h) => h.trim().toLowerCase())
  const looksLikeHeader = header.some(
    (h) => h.includes("phone") || h.includes("name")
  )
  const nameIdx = looksLikeHeader
    ? header.findIndex((h) => h.includes("name"))
    : raw[0].length > 1
      ? 0
      : -1
  const phoneIdx = looksLikeHeader
    ? header.findIndex(
        (h) =>
          h.includes("phone") || h.includes("number") || h.includes("mobile")
      )
    : raw[0].length > 1
      ? 1
      : 0
  const dataRows = looksLikeHeader ? raw.slice(1) : raw

  return dataRows.map((cells) => ({
    name: (nameIdx >= 0 ? cells[nameIdx]?.trim() : undefined) || undefined,
    // `cells` is a row from a user-uploaded CSV -- a short/ragged row
    // means `cells[phoneIdx]`/`cells[0]` can genuinely be undefined even
    // though plain array indexing doesn't say so in `cells`' type.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    phoneNumber: (phoneIdx >= 0 ? cells[phoneIdx] : cells[0])?.trim() ?? "",
  }))
}

interface ParsedRow extends BulkImportRow {
  valid: boolean
  reason?: string
  preview: string
}

function withNormalization(
  raw: BulkImportRow[],
  defaultCountryCode?: string
): ParsedRow[] {
  return raw.map((r) => {
    const normalized = normalizePhoneNumber(r.phoneNumber, defaultCountryCode)
    return {
      ...r,
      valid: normalized.ok,
      reason: normalized.ok ? undefined : normalized.reason,
      preview: normalized.ok ? normalized.e164 : r.phoneNumber,
    }
  })
}

export function BulkImportDialog({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false)
  const [waSessionId, setWaSessionId] = useState<string>("")
  const [defaultCountryCode, setDefaultCountryCode] = useState("")
  const [rawRows, setRawRows] = useState<BulkImportRow[]>([])
  const [fileName, setFileName] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions", workspaceId],
    queryFn: () => getSessions({ data: { workspaceId } }),
    enabled: open,
    staleTime: 10_000,
  })

  const rows = useMemo(
    () => withNormalization(rawRows, defaultCountryCode || undefined),
    [rawRows, defaultCountryCode]
  )
  const validRows = useMemo(() => rows.filter((r) => r.valid), [rows])
  const invalidCount = rows.length - validRows.length

  const importMutation = useMutation({
    mutationFn: async () => {
      if (validRows.length > MAX_IMPORT_ROWS) {
        throw new Error(`That file has ${validRows.length.toLocaleString()} rows — import at most ${MAX_IMPORT_ROWS.toLocaleString()} at a time.`)
      }
      const summary = { total: 0, created: 0, updated: 0, skipped: 0, invalid: 0 }
      // Sequential chunks: each is one bounded server call (see MAX_IMPORT_ROWS_PER_CALL).
      for (let i = 0; i < validRows.length; i += MAX_IMPORT_ROWS_PER_CALL) {
        const part = await bulkImportContacts({
          data: {
            workspaceId,
            waSessionId,
            defaultCountryCode: defaultCountryCode || undefined,
            rows: validRows.slice(i, i + MAX_IMPORT_ROWS_PER_CALL).map((r) => ({
              name: r.name,
              phoneNumber: r.phoneNumber,
            })),
          },
        })
        summary.total += part.total
        summary.created += part.created
        summary.updated += part.updated
        summary.skipped += part.skipped
        summary.invalid += part.invalid
      }
      return summary
    },
    onSuccess: (summary) => {
      queryClient.invalidateQueries({ queryKey: ["contacts", workspaceId] })
      toast.success(
        `Imported ${summary.created} new contact${summary.created === 1 ? "" : "s"}` +
          (summary.updated ? `, updated ${summary.updated}` : "") +
          (summary.skipped
            ? `, skipped ${summary.skipped} duplicate${summary.skipped === 1 ? "" : "s"}`
            : "")
      )
      reset()
      setOpen(false)
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't import contacts."),
  })

  function reset() {
    setRawRows([])
    setFileName(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  function handleFile(file: File) {
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? "")
      setRawRows(toRawRows(parseCsv(text)))
    }
    reader.readAsText(file)
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <SheetTrigger render={<Button variant="outline" size="sm" />}>
        <UploadIcon />
        <span className="hidden lg:inline">Import CSV</span>
      </SheetTrigger>
      <SheetContent side="right" className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Bulk import contacts</SheetTitle>
          <SheetDescription>
            Upload a CSV with <span className="font-mono">name</span> and{" "}
            <span className="font-mono">phone</span> columns (a header row is
            optional). Every number is purified — cleaned up and checked —
            before anything is saved, so a broadcast never gets sent to a
            malformed number.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="import-session">WhatsApp integration</Label>
            <Select
              value={waSessionId}
              onValueChange={(v) => setWaSessionId(v ?? "")}
            >
              <SelectTrigger id="import-session" className="w-full">
                <SelectValue>
                  {(v) =>
                    v
                      ? (sessions.find((s) => s.id === v)?.label ?? "")
                      : "Choose which number these contacts belong to"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {sessions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="import-cc">Default country code (optional)</Label>
            <input
              id="import-cc"
              placeholder="e.g. 1 or 44 — used for numbers with no country code"
              value={defaultCountryCode}
              onChange={(e) => setDefaultCountryCode(e.target.value)}
              className="flex h-9 rounded-md border border-input bg-input/50 px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label>CSV file</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleFile(file)
              }}
              className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
            />
          </div>

          {rows.length === 0 ? (
            <Empty className="rounded-xl border border-dashed border-border py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileSpreadsheetIcon />
                </EmptyMedia>
                <EmptyTitle>No file selected</EmptyTitle>
                <EmptyDescription>
                  Pick a CSV to preview the contacts before importing.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="truncate">{fileName}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge variant="secondary" className="gap-1">
                    <CheckCircle2Icon className="size-3" />
                    {validRows.length} valid
                  </Badge>
                  {invalidCount > 0 && (
                    <Badge variant="destructive" className="gap-1">
                      <XCircleIcon className="size-3" />
                      {invalidCount} invalid
                    </Badge>
                  )}
                </span>
              </div>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Number</TableHead>
                      <TableHead className="text-right">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.slice(0, 200).map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-sm">
                          {r.name ?? (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {r.preview}
                        </TableCell>
                        <TableCell className="text-right">
                          {r.valid ? (
                            <Badge variant="secondary" className="text-[10px]">
                              Valid
                            </Badge>
                          ) : (
                            <Badge
                              variant="destructive"
                              className="text-[10px]"
                              title={r.reason}
                            >
                              Invalid
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>

        <SheetFooter>
          <Button
            disabled={
              !waSessionId || validRows.length === 0 || importMutation.isPending
            }
            onClick={() => importMutation.mutate()}
          >
            {importMutation.isPending
              ? "Importing…"
              : `Import ${validRows.length || ""} contact${validRows.length === 1 ? "" : "s"}`}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
