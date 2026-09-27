import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Button } from "@workspace/ui/components/button"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogCancel,
  AlertDialogAction,
} from "@workspace/ui/components/alert-dialog"
import { UserXIcon } from "lucide-react"
import { useState } from "react"

export interface Member {
  memberId: string
  userId: string
  name: string
  email: string
  role: string
}

interface RoleOption {
  id: string
  name: string
}

export function MembersList({
  members,
  roles,
  currentUserId,
  onChangeRole,
  onRemove,
}: {
  members: Member[]
  roles: RoleOption[]
  currentUserId: string
  onChangeRole: (memberId: string, role: string) => void
  onRemove: (memberId: string) => void
}) {
  const [removing, setRemoving] = useState<Member | null>(null)

  if (members.length === 0) {
    return <p className="p-5 text-sm text-muted-foreground">No members yet.</p>
  }

  return (
    <>
      <div className="divide-y divide-border">
        {members.map((m) => {
          const isSelf = m.userId === currentUserId
          const isOwner = m.role === "Owner"
          return (
            <div
              key={m.memberId}
              className="flex items-center justify-between gap-3 p-5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {m.name}{" "}
                  {isSelf && (
                    <span className="text-xs font-normal text-muted-foreground">
                      (you)
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {m.email}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Select
                  value={m.role}
                  onValueChange={(v) => v && onChangeRole(m.memberId, v)}
                  disabled={isOwner}
                >
                  <SelectTrigger className="h-8 w-32 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((r) => (
                      <SelectItem key={r.id} value={r.name}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={isOwner || isSelf}
                  onClick={() => setRemoving(m)}
                  title={
                    isOwner
                      ? "The workspace owner can't be removed"
                      : "Remove from workspace"
                  }
                >
                  <UserXIcon />
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      <AlertDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              They&rsquo;ll immediately lose access to this workspace. You can
              invite them again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removing) onRemove(removing.memberId)
                setRemoving(null)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
