import { create } from "zustand";

type AppState = {
  night: boolean;
  liked: Record<string, boolean>;
  saved: Record<string, boolean>;
  likeDelta: Record<string, number>;
  toast: string | null;
  toggleNight: () => void;
  toggleLike: (id: string) => void;
  toggleSave: (id: string) => void;
  showToast: (msg: string) => void;
};

const SAVED_KEY = "xuxiake-prototype:saved";

function readSaved(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(SAVED_KEY) ?? "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return {};
  }
}

function writeSaved(saved: Record<string, boolean>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useAppStore = create<AppState>((set, get) => ({
  night: false,
  liked: {},
  saved: readSaved(),
  likeDelta: {},
  toast: null,
  toggleNight: () => set({ night: !get().night }),
  toggleLike: (id) => {
    const liked = { ...get().liked, [id]: !get().liked[id] };
    const likeDelta = {
      ...get().likeDelta,
      [id]: (get().likeDelta[id] ?? 0) + (liked[id] ? 1 : -1),
    };
    set({ liked, likeDelta });
    get().showToast(liked[id] ? "已点赞" : "已取消点赞");
  },
  toggleSave: (id) => {
    const saved = { ...get().saved, [id]: !get().saved[id] };
    set({ saved });
    writeSaved(saved);
    get().showToast(saved[id] ? "已收藏到我的路线" : "已取消收藏");
  },
  showToast: (msg) => {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: msg });
    toastTimer = setTimeout(() => set({ toast: null }), 2200);
  },
}));
