import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
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
import {
  PlusIcon,
  PencilIcon,
  TrashIcon,
  ShieldIcon,
  LockIcon,
} from "lucide-react"
import { Panel } from "@workspace/ui/components/panel"
import { roleFormSchema  } from "@/lib/schemas"
import type {RoleFormInput} from "@/lib/schemas";

export interface Role {
  id: string
  name: string
  description: string | null
  permissions: string[]
  isDefault: boolean
}

interface PermissionDef {
  key: string
  label: string
  description: string
}

function RoleForm({
  permissions,
  initial,
  onSubmit,
  submitLabel,
}: {
  permissions: PermissionDef[]
  initial?: RoleFormInput
  onSubmit: (values: RoleFormInput) => void
  submitLabel: string
}) {
  const form = useForm<RoleFormInput>({
    resolver: zodResolver(roleFormSchema),
    defaultValues: {
      name: initial?.name ?? "",
      description: initial?.description ?? "",
      permissions: initial?.permissions ?? [],
    },
  })

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-4"
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input
                  id="role-name"
                  placeholder="e.g. Support Lead"
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
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description (optional)</FormLabel>
              <FormControl>
                <Input
                  id="role-description"
                  placeholder="What is this role for?"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="permissions"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Permissions</FormLabel>
              <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
                {permissions.map((p) => (
                  <label
                    key={p.key}
                    className="flex cursor-pointer items-start gap-2.5"
                  >
                    <Checkbox
                      checked={field.value.includes(p.key)}
                      onCheckedChange={(checked) => {
                        const next = checked
                          ? [...field.value, p.key]
                          : field.value.filter((k) => k !== p.key)
                        field.onChange(next)
                      }}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="block text-sm font-medium">{p.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {p.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <FormMessage />
            </FormItem>
          )}
        />
        <SheetFooter className="px-0">
          <Button type="submit">{submitLabel}</Button>
        </SheetFooter>
      </form>
    </Form>
  )
}

export function RolesList({
  roles,
  permissions,
  onCreate,
  onUpdate,
  onDelete,
}: {
  roles: Role[]
  permissions: PermissionDef[]
  onCreate: (values: RoleFormInput) => void
  onUpdate: (roleId: string, values: RoleFormInput) => void
  onDelete: (roleId: string) => void
}) {
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<Role | null>(null)
  const [deleting, setDeleting] = useState<Role | null>(null)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end">
        <Sheet open={createOpen} onOpenChange={setCreateOpen}>
          <SheetTrigger render={<Button size="sm" variant="outline" />}>
            <PlusIcon />
            New role
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>Create a role</SheetTitle>
              <SheetDescription>
                Pick exactly what this role should be able to do.
              </SheetDescription>
            </SheetHeader>
            <RoleForm
              permissions={permissions}
              submitLabel="Create role"
              onSubmit={(values) => {
                onCreate(values)
                setCreateOpen(false)
              }}
            />
          </SheetContent>
        </Sheet>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {roles.map((r) => (
          <Panel key={r.id} className="flex flex-col gap-2 p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                {r.isDefault ? (
                  <LockIcon className="size-4 text-muted-foreground" />
                ) : (
                  <ShieldIcon className="size-4 text-primary" />
                )}
                <span className="text-sm font-medium">{r.name}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setEditing(r)}
                >
                  <PencilIcon />
                </Button>
                {!r.isDefault && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setDeleting(r)}
                  >
                    <TrashIcon />
                  </Button>
                )}
              </div>
            </div>
            {r.description && (
              <p className="text-xs text-muted-foreground">{r.description}</p>
            )}
            <div className="flex flex-wrap gap-1">
              {r.permissions.length === 0 ? (
                <span className="text-xs text-muted-foreground">
                  No permissions granted
                </span>
              ) : (
                r.permissions.slice(0, 4).map((key) => {
                  const def = permissions.find((p) => p.key === key)
                  return (
                    <Badge
                      key={key}
                      variant="secondary"
                      className="text-[10px]"
                    >
                      {def?.label ?? key}
                    </Badge>
                  )
                })
              )}
              {r.permissions.length > 4 && (
                <Badge variant="outline" className="text-[10px]">
                  +{r.permissions.length - 4} more
                </Badge>
              )}
            </div>
          </Panel>
        ))}
      </div>

      <Sheet
        open={!!editing}
        onOpenChange={(open) => !open && setEditing(null)}
      >
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>Edit {editing?.name}</SheetTitle>
            <SheetDescription>
              {editing?.isDefault
                ? "This is a built-in role — you can still adjust its permissions."
                : "Update this role's name, description or permissions."}
            </SheetDescription>
          </SheetHeader>
          {editing && (
            <RoleForm
              permissions={permissions}
              initial={{
                name: editing.name,
                description: editing.description ?? "",
                permissions: editing.permissions,
              }}
              submitLabel="Save changes"
              onSubmit={(values) => {
                onUpdate(editing.id, values)
                setEditing(null)
              }}
            />
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete the {deleting?.name} role?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This can&rsquo;t be undone. You can only delete a role that no one
              currently has.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) onDelete(deleting.id)
                setDeleting(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
