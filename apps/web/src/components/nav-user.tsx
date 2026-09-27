import { Link, useNavigate } from "@tanstack/react-router"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@workspace/ui/components/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@workspace/ui/components/sidebar"
import {
  EllipsisVerticalIcon,
  CircleUserRoundIcon,
  BellIcon,
  LogOutIcon,
} from "lucide-react"
import { toast } from "sonner"
import { logout } from "@/lib/auth"
import type { AuthUser } from "@/lib/auth"

export function NavUser({ user }: { user: AuthUser }) {
  const { isMobile } = useSidebar()
  const navigate = useNavigate()

  // `user` is typed as always-present because _app.tsx's beforeLoad
  // redirects to /login whenever getCurrentUser() can't resolve one --
  // but that guard runs against a live D1 query, and a transient
  // auth/DB hiccup during a client-side navigation (a route context
  // revalidation racing a redirect, for example) can still let this
  // render before the redirect lands. Degrading to nothing here for one
  // frame beats crashing the whole sidebar into the root error boundary.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!user) return null

  async function handleLogout() {
    try {
      await logout()
    } catch (err: any) {
      toast.error(err?.message ?? "Couldn't sign you out. Please try again.")
      return
    }
    navigate({ to: "/login" })
  }

  const initials = (user.name ?? user.email)
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="aria-expanded:bg-sidebar-accent aria-expanded:text-sidebar-accent-foreground"
              />
            }
          >
            <Avatar className="size-8 rounded-lg grayscale">
              <AvatarImage
                src={user.avatarUrl ?? undefined}
                alt={user.name ?? ""}
              />
              <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-start text-sm leading-tight">
              <span className="truncate font-medium">
                {user.name ?? "User"}
              </span>
              <span className="truncate text-xs text-sidebar-foreground">
                {user.email}
              </span>
            </div>
            <EllipsisVerticalIcon className="ms-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-start text-sm">
                  <Avatar className="size-8">
                    <AvatarImage
                      src={user.avatarUrl ?? undefined}
                      alt={user.name ?? ""}
                    />
                    <AvatarFallback className="rounded-lg">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-start text-sm leading-tight">
                    <span className="truncate font-medium text-popover-foreground">
                      {user.name ?? "User"}
                    </span>
                    <span className="truncate text-xs text-popover-foreground">
                      {user.email}
                    </span>
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                render={<Link to="/account" search={{ tab: "profile" }} />}
              >
                <CircleUserRoundIcon />
                Account
              </DropdownMenuItem>
              <DropdownMenuItem
                render={
                  <Link to="/account" search={{ tab: "notifications" }} />
                }
              >
                <BellIcon />
                Notifications
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout}>
              <LogOutIcon />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
