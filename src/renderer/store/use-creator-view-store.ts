import { create } from 'zustand'

/** Which creator's profile is open on the Creators page (also set by a clicked notification). */
interface CreatorViewState {
  openId: string | null
  open: (id: string | null) => void
}

export const useCreatorViewStore = create<CreatorViewState>((set) => ({
  openId: null,
  open: (openId) => set({ openId })
}))
