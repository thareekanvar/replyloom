import {
  ImagesIcon,
  FileTextIcon,
  ReplyIcon,
  SparklesIcon,
  SlidersHorizontalIcon,
  BookOpenIcon,
  PlugIcon,
  UserRoundCheckIcon,
} from "lucide-react"
import { cn } from "@workspace/ui/lib/utils"

export type AgentSubView = "setup" | "knowledge" | "tools" | "escalations"

export type AutomationView =
  | { kind: "gallery" }
  | { kind: "templates" }
  | { kind: "auto-reply" }
  | { kind: "agent"; tab: AgentSubView }

const AGENT_ITEMS: { tab: AgentSubView; title: string; icon: React.ReactNode }[] =
  [
    { tab: "setup", title: "Setup", icon: <SlidersHorizontalIcon /> },
    { tab: "knowledge", title: "Knowledge", icon: <BookOpenIcon /> },
    { tab: "tools", title: "Tools", icon: <PlugIcon /> },
    { tab: "escalations", title: "Escalations", icon: <UserRoundCheckIcon /> },
  ]

function NavItem({
  active,
  onClick,
  icon,
  children,
  className,
}: {
  active: boolean
  onClick: () => void
  icon?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-active={active || undefined}
      className={cn(
        "group/nav-item flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm text-muted-foreground transition-colors outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
        "data-active:bg-accent data-active:font-medium data-active:text-accent-foreground",
        className
      )}
    >
      {icon && (
        <span className="[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-foreground/60 group-data-[active]/nav-item:[&_svg]:text-accent-foreground">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}

export function AutomationNav({
  view,
  onSelect,
}: {
  view: AutomationView
  onSelect: (view: AutomationView) => void
}) {
  const isAgent = view.kind === "agent"
  const agentTab = isAgent ? view.tab : "setup"

  return (
    <nav className="flex w-full shrink-0 flex-col gap-3 rounded-2xl border border-border bg-background p-2 lg:sticky lg:top-0 lg:w-52 lg:gap-5">
      <div className="flex flex-col gap-1">
        <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">
          Library
        </p>
        <NavItem
          active={view.kind === "gallery"}
          icon={<ImagesIcon />}
          onClick={() => onSelect({ kind: "gallery" })}
        >
          Gallery
        </NavItem>
        <NavItem
          active={view.kind === "templates"}
          icon={<FileTextIcon />}
          onClick={() => onSelect({ kind: "templates" })}
        >
          Templates
        </NavItem>
      </div>

      <div className="flex flex-col gap-1">
        <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">
          Automation
        </p>
        <NavItem
          active={view.kind === "auto-reply"}
          icon={<ReplyIcon />}
          onClick={() => onSelect({ kind: "auto-reply" })}
        >
          Auto-Reply
        </NavItem>

        <NavItem
          active={isAgent}
          icon={<SparklesIcon />}
          onClick={() => onSelect({ kind: "agent", tab: agentTab })}
        >
          AI Agent
        </NavItem>

        <div className="ms-4 flex flex-col gap-0.5 border-s border-border ps-2 pb-1">
          {AGENT_ITEMS.map((item) => (
            <NavItem
              key={item.tab}
              active={isAgent && view.tab === item.tab}
              icon={item.icon}
              className="py-1"
              onClick={() => onSelect({ kind: "agent", tab: item.tab })}
            >
              {item.title}
            </NavItem>
          ))}
        </div>
      </div>
    </nav>
  )
}
