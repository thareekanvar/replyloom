import { useState } from "react"
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
import { Loader2Icon, MailPlusIcon } from "lucide-react"
import { inviteMemberSchema  } from "@/lib/schemas"
import type {InviteMemberInput} from "@/lib/schemas";

interface RoleOption {
  id: string
  name: string
}

export function InviteMemberDialog({
  roles,
  onInvite,
}: {
  roles: RoleOption[]
  onInvite: (email: string, role: string) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // `roles[0]` can be undefined if the workspace has no custom roles yet
  // -- plain indexing doesn't say so in `roles`' type, but an empty array
  // genuinely happens here.
  const defaultRole =
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    roles.find((r) => r.name === "Agent")?.name ?? roles[0]?.name ?? ""

  const form = useForm<InviteMemberInput>({
    resolver: zodResolver(inviteMemberSchema),
    defaultValues: { email: "", role: defaultRole },
  })

  async function onSubmit(data: InviteMemberInput) {
    setSubmitting(true)
    try {
      await onInvite(data.email.trim(), data.role)
      form.reset()
      setOpen(false)
    } catch {
      // Global mutation handler toasts the error
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button size="sm" />}>
        <MailPlusIcon />
        Invite member
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Invite a teammate</SheetTitle>
          <SheetDescription>
            They&rsquo;ll get an email with a link to join — the role you pick
            decides what they can do here.
          </SheetDescription>
        </SheetHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 px-6 py-4">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      id="invite-email"
                      type="email"
                      placeholder="teammate@company.com"
                      autoFocus
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Role</FormLabel>
                  <Select value={field.value} onValueChange={(v) => field.onChange(v ?? "")}>
                    <FormControl>
                      <SelectTrigger id="invite-role" className="w-full">
                        <SelectValue placeholder="Choose a role" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {roles.map((r) => (
                        <SelectItem key={r.id} value={r.name}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <SheetFooter>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2Icon className="animate-spin" />}
                {submitting ? "Sending…" : "Send invite"}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}
