import { useState } from "react"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
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
import { XIcon, MailIcon } from "lucide-react"
import { Panel } from "@workspace/ui/components/panel"

export interface PendingInvitation {
  id: string
  email: string
  role: string | null
  createdAt: number
}

export function InvitationsList({
  invitations,
  onCancel,
}: {
  invitations: PendingInvitation[]
  onCancel: (id: string) => void
}) {
  const [canceling, setCanceling] = useState<PendingInvitation | null>(null)

  if (invitations.length === 0) return null

  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="px-1 text-xs font-medium text-muted-foreground">
          Pending invitations
        </p>
        <Panel className="divide-y divide-border">
          {invitations.map((inv) => (
            <div
              key={inv.id}
              className="flex items-center justify-between gap-3 p-4"
            >
              <div className="flex items-center gap-2.5">
                <MailIcon className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">{inv.email}</p>
                  <p className="text-xs text-muted-foreground">
                    Invited as {inv.role ?? "Viewer"}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="secondary" className="text-[10px]">
                  Pending
                </Badge>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setCanceling(inv)}
                >
                  <XIcon />
                </Button>
              </div>
            </div>
          ))}
        </Panel>
      </div>

      <AlertDialog
        open={!!canceling}
        onOpenChange={(open) => !open && setCanceling(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Cancel invitation to {canceling?.email}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The invite link they were sent will stop working.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (canceling) onCancel(canceling.id)
                setCanceling(null)
              }}
            >
              Cancel invite
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
