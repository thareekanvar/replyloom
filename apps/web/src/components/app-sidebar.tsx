import * as React from "react"

import { WorkspaceSwitcher } from "@/features/workspaces/components/workspace-switcher"
import { NavMain } from "@/components/nav-main"
import { NavSecondary } from "@/components/nav-secondary"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@workspace/ui/components/sidebar"
import {
  InboxIcon,
  UsersIcon,
  KanbanSquareIcon,
  SmartphoneIcon,
  MegaphoneIcon,
  SparklesIcon,
  Settings2Icon,
  CircleHelpIcon,
} from "lucide-react"
import type { AuthUser } from "@/lib/auth"

const data = {
  navMain: [
    { title: "Inbox", url: "/inbox", icon: <InboxIcon /> },
    { title: "Contacts", url: "/contacts", icon: <UsersIcon /> },
    { title: "Pipeline", url: "/pipeline", icon: <KanbanSquareIcon /> },
    { title: "Broadcasts", url: "/broadcasts", icon: <MegaphoneIcon /> },
    { title: "Automation", url: "/automation", icon: <SparklesIcon /> },
    { title: "Integrations", url: "/integrations", icon: <SmartphoneIcon /> },
  ],
  navSecondary: [
    { title: "Settings", url: "/settings", icon: <Settings2Icon /> },
    { title: "Get Help", url: "/help", icon: <CircleHelpIcon /> },
  ],
}

export function AppSidebar({
  user,
  ...props
}: React.ComponentProps<typeof Sidebar> & { user: AuthUser }) {
  return (
    // `--sidebar-*` in globals.css is its own always-dark-green palette
    // (same hue as --primary), defined directly on :root — NOT via a
    // `.dark` class here. Forcing `.dark` on this element would also flip
    // every non-sidebar-prefixed token (--foreground, --primary, --muted,
    // ...) for anything rendered inside it, which is what made nav text
    // unreadable before. `collapsible="icon"` + `variant="inset"` (set by
    // the caller, see routes/_app.tsx) gives the floating, rounded-corner
    // main-content look that goes with it.
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <WorkspaceSwitcher fallbackName="Replyloom" />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} />
        <NavSecondary items={data.navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
