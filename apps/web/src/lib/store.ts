import { create } from "zustand"

// Client-only UI state that has no business round-tripping to the server —
// selection, panel toggles, the active workspace/session picker. Server
// data (contacts, messages, etc.) lives in React Query, never here.
interface UiState {
  activeWorkspaceId: string | null
  activeSessionId: string | null
  selectedConversationId: string | null
  sidebarCollapsed: boolean
  setActiveWorkspace: (id: string | null) => void
  setActiveSession: (id: string | null) => void
  selectConversation: (id: string | null) => void
  toggleSidebar: () => void
}

export const useUiStore = create<UiState>((set) => ({
  activeWorkspaceId: null,
  activeSessionId: null,
  selectedConversationId: null,
  sidebarCollapsed: false,
  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
  setActiveSession: (id) => set({ activeSessionId: id }),
  selectConversation: (id) => set({ selectedConversationId: id }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}))
