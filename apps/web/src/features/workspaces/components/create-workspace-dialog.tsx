import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { createWorkspaceSchema  } from "@/lib/schemas"
import type {CreateWorkspaceInput} from "@/lib/schemas";

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreate,
  pending,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (name: string) => void
  pending?: boolean
}) {
  const form = useForm<CreateWorkspaceInput>({
    resolver: zodResolver(createWorkspaceSchema),
    defaultValues: { name: "" },
  })

  function onSubmit(data: CreateWorkspaceInput) {
    onCreate(data.name)
    form.reset()
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) form.reset()
      }}
    >
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Create a new workspace</SheetTitle>
          <SheetDescription>
            A fresh workspace with its own sessions, contacts and team —
            you&rsquo;ll be its owner and it becomes your active workspace right
            away.
          </SheetDescription>
        </SheetHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 px-6 py-4">
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
            <SheetFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Creating…" : "Create workspace"}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}
