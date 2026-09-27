import { create } from 'zustand'

const SHOW_SCORES_STORAGE_KEY = 'sparkclip.clips.showScores'

function readShowScores(): boolean {
  try {
    return localStorage.getItem(SHOW_SCORES_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function saveShowScores(show: boolean): void {
  try {
    localStorage.setItem(SHOW_SCORES_STORAGE_KEY, show ? '1' : '0')
  } catch {
    // Only a convenience; scores start hidden next time.
  }
}

interface ClipViewState {
  /** Show each clip's per-criterion scores under its card. Remembered across launches. */
  showScores: boolean
  toggleScores: () => void
}

export const useClipViewStore = create<ClipViewState>((set, get) => ({
  showScores: readShowScores(),
  toggleScores: () => {
    const showScores = !get().showScores
    saveShowScores(showScores)
    set({ showScores })
  }
}))
