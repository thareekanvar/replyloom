import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Switch } from "@workspace/ui/components/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { TrashIcon, ReplyIcon, PencilIcon } from "lucide-react"
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

export interface AutoReplyRule {
  id: string
  keyword: string
  matchType: "exact" | "contains" | "regex"
  context: "group" | "private" | "all"
  replyText: string | null
  waSessionId: string | null
  enabled: boolean
  priority: number
}

export function AutoReplyList({
  rules,
  onToggle,
  onDelete,
  onEdit,
}: {
  rules: AutoReplyRule[]
  onToggle: (id: string, enabled: boolean) => void
  onDelete: (id: string) => void
  onEdit: (rule: AutoReplyRule) => void
}) {
  if (rules.length === 0) {
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ReplyIcon />
          </EmptyMedia>
          <EmptyTitle>No auto-reply rules yet</EmptyTitle>
          <EmptyDescription>
            Add one to reply to keywords automatically.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Keyword</TableHead>
          <TableHead>Match</TableHead>
          <TableHead>Context</TableHead>
          <TableHead>Reply</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">{""}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-medium">{r.keyword}</TableCell>
            <TableCell>
              <Badge variant="outline" className="capitalize">
                {r.matchType}
              </Badge>
            </TableCell>
            <TableCell className="text-sm text-muted-foreground capitalize">
              {r.context}
            </TableCell>
            <TableCell className="max-w-64 truncate text-sm text-muted-foreground">
              {r.replyText}
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-2">
                <Switch
                  checked={r.enabled}
                  onCheckedChange={(next) => onToggle(r.id, next)}
                  aria-label={`${r.enabled ? "Disable" : "Enable"} rule "${r.keyword}"`}
                />
                <span className="text-xs text-muted-foreground">
                  {r.enabled ? "On" : "Off"}
                </span>
              </div>
            </TableCell>
            <TableCell className="text-right">
              <div className="flex items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit rule "${r.keyword}"`}
                  onClick={() => onEdit(r)}
                >
                  <PencilIcon className="size-4" />
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger
                    render={<Button variant="ghost" size="icon" />}
                  >
                    <TrashIcon />
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Delete auto-reply rule?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently delete the rule for &ldquo;
                        {r.keyword}&rdquo;. This can&rsquo;t be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => onDelete(r.id)}>
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}