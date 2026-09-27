import { createFileRoute, useNavigate, Link } from "@tanstack/react-router"
import { useQuery, useMutation } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { Button } from "@workspace/ui/components/button"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@workspace/ui/components/empty"
import { MailCheckIcon, MessageCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { getCurrentUser } from "@/lib/auth"
import {
  getInvitationById,
  acceptInvitation,
} from "@/features/team/hooks/use-team"
import { DetailCardSkeleton } from "@/components/skeletons"

export const Route = createFileRoute("/accept-invite")({
  component: AcceptInvitePage,
  validateSearch: (search: Record<string, unknown>): { id?: string } => ({
    id: typeof search.id === "string" ? search.id : undefined,
  }),
})

function AcceptInvitePage() {
  const { id } = Route.useSearch()
  const navigate = useNavigate()
  const [accepted, setAccepted] = useState(false)

  const inviteQuery = useQuery({
    queryKey: ["invitation", id],
    queryFn: () => getInvitationById({ data: { invitationId: id! } }),
    enabled: !!id,
  })

  const userQuery = useQuery({
    queryKey: ["current-user-for-invite"],
    queryFn: () => getCurrentUser(),
  })

  const acceptMutation = useMutation({
    mutationFn: () =>
      acceptInvitation({
        data: {
          invitationId: id!,
          userId: userQuery.data!.user.id,
          userEmail: userQuery.data!.user.email,
        },
      }),
    onSuccess: () => {
      setAccepted(true)
      toast.success("You're in!")
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't accept this invitation."),
  })

  useEffect(() => {
    if (accepted) {
      const t = setTimeout(() => navigate({ to: "/inbox" }), 1200)
      return () => clearTimeout(t)
    }
  }, [accepted, navigate])

  if (!id) {
    return (
      <CenterCard>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MailCheckIcon />
            </EmptyMedia>
            <EmptyTitle>Invalid invitation link</EmptyTitle>
            <EmptyDescription>
              This link is missing its invitation id.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CenterCard>
    )
  }

  if (inviteQuery.isLoading || userQuery.isLoading) {
    return (
      <CenterCard>
        <DetailCardSkeleton />
      </CenterCard>
    )
  }

  const invite = inviteQuery.data
  if (!invite || invite.status !== "pending") {
    return (
      <CenterCard>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MailCheckIcon />
            </EmptyMedia>
            <EmptyTitle>
              {invite
                ? "This invitation is no longer valid"
                : "Invitation not found"}
            </EmptyTitle>
            <EmptyDescription>
              Ask whoever invited you to send a new one.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CenterCard>
    )
  }

  const user = userQuery.data?.user
  const emailMismatch =
    user && invite.emailMatches === false

  return (
    <CenterCard>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageCircleIcon />
          </EmptyMedia>
          <EmptyTitle>Join {invite.organizationName}</EmptyTitle>
          <EmptyDescription>
            {invite.email} was invited as{" "}
            <strong>{invite.role ?? "Viewer"}</strong>.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {accepted ? (
            <p className="text-sm text-muted-foreground">Redirecting you in…</p>
          ) : !user ? (
            <div className="flex gap-2">
              <Button render={<Link to="/login" search={{ inviteId: id }} />} nativeButton={false}>
                Log in
              </Button>
              <Button
                variant="outline"
                render={<Link to="/signup" search={{ inviteId: id }} />}
              >
                Create account
              </Button>
            </div>
          ) : emailMismatch ? (
            <p className="text-sm text-muted-foreground">
              You&rsquo;re signed in as {user.email}, but this invite was sent
              to {invite.email}. Log out and use the right account to accept it.
            </p>
          ) : (
            <Button
              disabled={acceptMutation.isPending}
              onClick={() => acceptMutation.mutate()}
            >
              {acceptMutation.isPending
                ? "Joining…"
                : `Accept and join ${invite.organizationName}`}
            </Button>
          )}
        </EmptyContent>
      </Empty>
    </CenterCard>
  )
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  )
}
