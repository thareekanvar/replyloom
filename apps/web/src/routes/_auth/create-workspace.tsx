import { createFileRoute, redirect } from "@tanstack/react-router"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import { getCurrentUser } from "@/lib/auth"
import { createWorkspace } from "@/features/workspaces/hooks/use-workspaces"
import { createWorkspaceSchema } from "@/lib/schemas"
import type { CreateWorkspaceInput } from "@/lib/schemas"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@workspace/ui/components/form"

// Reached when someone is signed in but isn't a member of any workspace --
// e.g. they were removed from their last one, or their membership just
// doesn't exist in whichever D1 this request is reading from (see the
// comment on resolveActiveWorkspaceId in lib/auth.ts). Signup always
// creates a workspace up front, so in practice this route is a landing
// spot for that edge case rather than part of the normal signup flow.
export const Route = createFileRoute("/_auth/create-workspace")({
  beforeLoad: async () => {
    const result = await getCurrentUser()
    if (!result) throw redirect({ to: "/login" })
    if (result.workspaceId) throw redirect({ to: "/inbox" })
  },
  component: CreateWorkspacePage,
})

function CreateWorkspacePage() {

  const form = useForm<CreateWorkspaceInput>({
    resolver: zodResolver(createWorkspaceSchema),
    defaultValues: { name: "" },
  })

  async function onSubmit(data: CreateWorkspaceInput) {
    try {
      await createWorkspace({ data: { name: data.name } })
      toast.success("Workspace created")
      // Full navigation (not the router) so the whole app re-reads the
      // session's now-set activeOrganizationId from scratch, same as the
      // workspace switcher does after creating one.
      window.location.href = "/inbox"
    } catch (err: any) {
      toast.error(err?.message ?? "Couldn't create the workspace.")
    }
  }

  return (
    <div>
      <div className="mb-6 text-center">
        <h1 className="mb-1 text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          Create your workspace
        </h1>
        <p className="text-sm text-muted-foreground">
          You&rsquo;re signed in, but not part of a workspace yet. Create one
          to get started -- you&rsquo;ll be its owner.
        </p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Workspace name</FormLabel>
                <FormControl>
                  <Input
                    id="workspace-name"
                    placeholder="e.g. Acme Support"
                    autoFocus
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <Button
            type="submit"
            disabled={form.formState.isSubmitting}
            className="mt-1 w-full rounded-full bg-gradient-to-b from-primary to-primary/80 py-3.5 shadow-sm hover:opacity-90 active:scale-[0.98]"
          >
            {form.formState.isSubmitting ? "Creating…" : "Create workspace"}
          </Button>
        </form>
      </Form>
    </div>
  )
}
