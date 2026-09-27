import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
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
import { PlusIcon } from "lucide-react"
import { toast } from "sonner"
import { getSessions } from "@/features/integrations/hooks/use-sessions"
import { createContact } from "../hooks/use-contacts"
import { addContactSchema  } from "@/lib/schemas"
import type {AddContactInput} from "@/lib/schemas";

export function AddContactDialog({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()

  const form = useForm<AddContactInput>({
    resolver: zodResolver(addContactSchema),
    defaultValues: {
      waSessionId: "",
      name: "",
      phoneNumber: "",
      defaultCountryCode: "",
    },
  })

  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions", workspaceId],
    queryFn: () => getSessions({ data: { workspaceId } }),
    enabled: open,
    staleTime: 10_000,
  })

  const createMutation = useMutation({
    mutationFn: (data: AddContactInput) =>
      createContact({
        data: {
          workspaceId,
          waSessionId: data.waSessionId,
          name: data.name?.trim() || undefined,
          phoneNumber: data.phoneNumber,
          defaultCountryCode: data.defaultCountryCode || undefined,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contacts", workspaceId] })
      toast.success("Contact added")
      form.reset()
      setOpen(false)
    },
  })

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) form.reset()
      }}
    >
      <SheetTrigger render={<Button variant="outline" size="sm" />}>
        <PlusIcon />
        <span className="hidden lg:inline">Add Contact</span>
      </SheetTrigger>
      <SheetContent side="right" className="sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>Add contact</SheetTitle>
          <SheetDescription>
            Create a single contact under one of your WhatsApp integrations.
          </SheetDescription>
        </SheetHeader>

        <Form {...form}>
          <form
            id="add-contact-form"
            className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-4"
            onSubmit={form.handleSubmit((data) => createMutation.mutate(data))}
          >
            <FormField
              control={form.control}
              name="waSessionId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>WhatsApp integration</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(v) => field.onChange(v ?? "")}
                  >
                    <FormControl>
                      <SelectTrigger id="add-contact-session" className="w-full">
                        <SelectValue>
                          {(v) =>
                            v
                              ? (sessions.find((s) => s.id === v)?.label ?? "")
                              : "Which number does this contact belong to?"
                          }
                        </SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {sessions.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name (optional)</FormLabel>
                  <FormControl>
                    <Input
                      id="add-contact-name"
                      placeholder="e.g. Priya Sharma"
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
                  <FormLabel>Phone number</FormLabel>
                  <FormControl>
                    <Input
                      id="add-contact-phone"
                      placeholder="+1 234 567 8901"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="defaultCountryCode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Default country code (optional)</FormLabel>
                  <FormControl>
                    <Input
                      id="add-contact-cc"
                      placeholder="e.g. 1 or 44 -- used if the number has none"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>

        <SheetFooter>
          <Button
            type="submit"
            form="add-contact-form"
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? "Adding…" : "Add contact"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
