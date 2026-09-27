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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"
import { PlusIcon } from "lucide-react"
import { createSessionSchema  } from "@/lib/schemas"
import type {CreateSessionInput} from "@/lib/schemas";

export function CreateSessionDialog({
  onCreate,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: {
  onCreate: (label: string, phoneNumber?: string) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = controlledOnOpenChange ?? setInternalOpen

  const form = useForm<CreateSessionInput>({
    resolver: zodResolver(createSessionSchema),
    defaultValues: { label: "", phoneNumber: "" },
  })

  function onSubmit(data: CreateSessionInput) {
    onCreate(data.label, data.phoneNumber?.trim() || undefined)
    form.reset()
    setOpen(false)
  }

  return (
    <Sheet open={open} onOpenChange={(next) => {
      setOpen(next)
      if (!next) form.reset()
    }}>
      <SheetTrigger render={<Button />}>
        <PlusIcon />
        Add Number
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Connect a WhatsApp Number</SheetTitle>
          <SheetDescription>
            Give it a name your team will recognize — you'll scan a QR code to
            link it next.
          </SheetDescription>
        </SheetHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 px-6 py-4">
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input
                      id="session-label"
                      placeholder="e.g. Sales Team, Support Line"
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
              name="phoneNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone number (optional)</FormLabel>
                  <FormControl>
                    <Input
                      id="session-phone"
                      placeholder="e.g. +1 234 567 890"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <SheetFooter>
              <Button type="submit">Continue</Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}
