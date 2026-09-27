import { useRef, useState } from "react"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@workspace/ui/components/avatar"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Panel } from "@workspace/ui/components/panel"
import { LoaderCircleIcon, TrashIcon, UploadIcon } from "lucide-react"
import { toast } from "sonner"
import type { AuthUser } from "@/lib/auth"

function getInitials(name: string | null, email: string): string {
  const source = name?.trim() || email
  return source
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

export function AccountForm({
  user,
  pending,
  onSave,
  onUpload,
}: {
  user: AuthUser
  pending: boolean
  onSave: (data: { name: string; image: string | null }) => void
  onUpload: (file: File) => Promise<string>
}) {
  const [name, setName] = useState(user.name ?? "")
  const [image, setImage] = useState(user.avatarUrl ?? "")
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const dirty =
    name.trim() !== (user.name ?? "").trim() ||
    image.trim() !== (user.avatarUrl ?? "")
  const initials = getInitials(name || user.name, user.email)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    onSave({ name: name.trim(), image: image.trim() || null })
  }

  async function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose an image file (JPG, PNG, WebP…).")
      return
    }
    setUploading(true)
    try {
      const url = await onUpload(file)
      setImage(url)
    } catch (err: any) {
      toast.error(err?.message ?? "Couldn't upload that image.")
    } finally {
      setUploading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Panel className="flex flex-col gap-6 p-5">
        <div className="flex items-center gap-4">
          <Avatar className="size-14">
            <AvatarImage src={image || undefined} alt={name || ""} />
            <AvatarFallback className="text-base">{initials}</AvatarFallback>
          </Avatar>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Profile photo</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? (
                  <LoaderCircleIcon className="animate-spin" />
                ) : (
                  <UploadIcon />
                )}
                {uploading ? "Uploading…" : "Upload photo"}
              </Button>
              {image && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setImage("")}
                >
                  <TrashIcon />
                  Remove
                </Button>
              )}
            </div>
            <span className="text-xs text-muted-foreground">
              JPG, PNG or WebP, up to 5 MB.
            </span>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFilePicked}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="account-name">Name</Label>
            <Input
              id="account-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="account-email">Email</Label>
            <Input id="account-email" value={user.email} disabled readOnly />
          </div>
        </div>
      </Panel>

      <div className="flex justify-end">
        <Button
          type="submit"
          disabled={!dirty || pending || uploading || !name.trim()}
        >
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  )
}
