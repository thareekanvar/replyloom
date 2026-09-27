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
import { Checkbox } from "@workspace/ui/components/checkbox"
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
import { createWebhookSchema  } from "@/lib/schemas"
import type {CreateWebhookInput} from "@/lib/schemas";

export type { CreateWebhookInput } from "@/lib/schemas"

const AVAILABLE_EVENTS = [
  { value: "message.received", label: "Message received" },
  { value: "message.sent", label: "Message sent" },
]

export function CreateWebhookDialog({
  onCreate,
}: {
  onCreate: (data: CreateWebhookInput) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const form = useForm<CreateWebhookInput>({
    resolver: zodResolver(createWebhookSchema),
    defaultValues: {
      url: "",
      events: ["message.received"],
    },
  })

  async function onSubmit(data: CreateWebhookInput) {
    setSubmitting(true)
    try {
      await onCreate(data)
      form.reset()
      setOpen(false)
    } catch {
      // Global mutation handler toasts the error
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={(next) => {
      setOpen(next)
      if (!next) form.reset()
    }}>
      <SheetTrigger render={<Button />}>
        <PlusIcon />
        New Webhook
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Create Webhook</SheetTitle>
          <SheetDescription>
            We'll POST a signed JSON payload to this URL for each event you
            subscribe to.
          </SheetDescription>
        </SheetHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 px-6 py-4">
            <FormField
              control={form.control}
              name="url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Endpoint URL</FormLabel>
                  <FormControl>
                    <Input
                      id="webhook-url"
                      type="url"
                      placeholder="https://your-server.com/webhooks/whatsapp"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="events"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Events</FormLabel>
                  <div className="flex flex-col gap-1 rounded-md border p-2">
                    {AVAILABLE_EVENTS.map((e) => (
                      <label
                        key={e.value}
                        className="flex items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-muted/50"
                      >
                        <Checkbox
                          checked={field.value.includes(e.value)}
                          onCheckedChange={(checked) => {
                            const next = checked
                              ? [...field.value, e.value]
                              : field.value.filter((v) => v !== e.value)
                            field.onChange(next)
                          }}
                        />
                        {e.label}
                      </label>
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <SheetFooter>
              <Button
                type="submit"
                disabled={submitting || form.watch("events").length === 0}
              >
                {submitting && <Loader2Icon className="animate-spin" />}
                {submitting ? "Creating…" : "Create webhook"}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}
