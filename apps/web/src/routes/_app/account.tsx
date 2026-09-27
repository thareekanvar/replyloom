import {
  createFileRoute,
  useNavigate,
  useRouteContext,
} from "@tanstack/react-router"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"
import { Panel } from "@workspace/ui/components/panel"
import { toast } from "sonner"
import {
  updateProfile,
  uploadProfileImage,
  getNotificationPreferences,
  updateNotificationPreferences,
} from "@/features/settings/hooks/use-settings"
import { AccountForm } from "@/features/settings/components/account-form"
import {
  NotificationSettings
  
} from "@/features/settings/components/notification-settings"
import type {NotificationPrefs} from "@/features/settings/components/notification-settings";
import { WorkspacesPanel } from "@/features/workspaces/components/workspaces-panel"
import { AvatarListSkeleton } from "@/components/skeletons"
import { waApi } from "@/lib/wa-api"

// Personal settings for the signed-in user -- deliberately its own route,
// separate from /settings (workspace/team/webhooks, which is about the
// *workspace*, not any one person). Reached from the user menu in the
// sidebar footer, never from the main nav.
const TABS = ["profile", "notifications", "workspaces"] as const

export const Route = createFileRoute("/_app/account")({
  staticData: { title: "Account" },
  validateSearch: (
    search: Record<string, unknown>
  ): { tab?: (typeof TABS)[number] } => ({
    tab: TABS.includes(search.tab as any)
      ? (search.tab as (typeof TABS)[number])
      : undefined,
  }),
  component: AccountPage,
})

function AccountPage() {
  const { user } = useRouteContext({ from: "/_app" })
  const { tab } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const activeTab = tab ?? "profile"
  const queryClient = useQueryClient()

  const notificationPrefsQuery = useQuery({
    queryKey: ["notification-preferences"],
    queryFn: () => getNotificationPreferences(),
    staleTime: 60_000,
  })

  const updateProfileMutation = useMutation({
    mutationFn: (data: { name: string; image: string | null }) =>
      updateProfile({ data }),
    onSuccess: () => {
      // The signed-in user's name/avatar are baked into the router's
      // beforeLoad context (see routes/_app.tsx), so a full reload is the
      // simplest way to make the sidebar/header pick up the change.
      toast.success("Profile updated", {
        description: "Refreshing to show your changes…",
      })
      setTimeout(() => window.location.reload(), 600)
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't update your profile."),
  })

  // Reads the picked image to base64, stores it in R2 via the server, and
  // resolves the new object key to a public media URL for the profile form.
  async function uploadImage(file: File) {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result ?? "")
        const comma = result.indexOf(",")
        resolve(comma >= 0 ? result.slice(comma + 1) : result)
      }
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    const res = await uploadProfileImage({ data: { base64, mime: file.type } })
    return waApi.mediaUrl(res.mediaKey)
  }

  const notificationPrefsMutation = useMutation({
    mutationFn: (patch: Partial<NotificationPrefs>) =>
      updateNotificationPreferences({ data: patch }),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({
        queryKey: ["notification-preferences"],
      })
      const previous = queryClient.getQueryData<NotificationPrefs>([
        "notification-preferences",
      ])
      queryClient.setQueryData(
        ["notification-preferences"],
        (old: NotificationPrefs | undefined) => ({
          ...(old ?? {
            desktopEnabled: false,
            soundEnabled: true,
            emailDigestEnabled: false,
          }),
          ...patch,
        })
      )
      return { previous }
    },
    onError: (err: any, _patch, context) => {
      if (context?.previous)
        queryClient.setQueryData(["notification-preferences"], context.previous)
      toast.error(
        err?.message ?? "Couldn't save your notification preferences."
      )
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["notification-preferences"] }),
  })

  return (
    <div className="flex flex-1 flex-col gap-4">
      <Tabs
        value={activeTab}
        onValueChange={(value) =>
          navigate({
            // Tabs' onValueChange gives a plain string; the cast doesn't
            // make an unexpected value impossible, so keep the fallback.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            search: { tab: (value as (typeof TABS)[number]) ?? "profile" },
          })
        }
      >
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="workspaces">Workspaces</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold">Profile</h2>
            <p className="text-sm text-muted-foreground">
              Your name and photo, as teammates see them.
            </p>
          </div>
          <AccountForm
            user={user}
            pending={updateProfileMutation.isPending}
            onUpload={uploadImage}
            onSave={(data) => updateProfileMutation.mutate(data)}
          />
        </TabsContent>

        <TabsContent value="notifications" className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold">Notifications</h2>
            <p className="text-sm text-muted-foreground">
              Choose how you're alerted about new messages.
            </p>
          </div>
          {notificationPrefsQuery.isLoading ? (
            <Panel className="p-5">
              <AvatarListSkeleton rows={3} withAvatar={false} />
            </Panel>
          ) : (
            <NotificationSettings
              prefs={
                notificationPrefsQuery.data ?? {
                  desktopEnabled: false,
                  soundEnabled: true,
                  emailDigestEnabled: false,
                }
              }
              onChange={(patch) => notificationPrefsMutation.mutate(patch)}
            />
          )}
        </TabsContent>

        <TabsContent value="workspaces">
          <WorkspacesPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}
