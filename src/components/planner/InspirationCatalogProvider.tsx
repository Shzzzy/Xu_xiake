import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useServerFn } from "@tanstack/react-start";
import { getSharedInspirations } from "@/lib/discovered-places.functions";
import {
  inspirationDestinations,
  mergeInspirationCatalog,
  type InspirationDestination,
} from "@/lib/inspiration";

type InspirationCatalogContextValue = {
  items: InspirationDestination[];
  refresh: () => Promise<void>;
};

const InspirationCatalogContext = createContext<InspirationCatalogContextValue>({
  items: inspirationDestinations,
  refresh: async () => undefined,
});

export function useInspirationCatalog() {
  return useContext(InspirationCatalogContext).items;
}

export function useInspirationCatalogRefresh() {
  return useContext(InspirationCatalogContext).refresh;
}

export function InspirationCatalogProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<InspirationDestination[]>(inspirationDestinations);
  const getSharedInspirationsFn = useServerFn(getSharedInspirations);
  const warnedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const dynamicItems = await getSharedInspirationsFn();
      setItems((current) => mergeInspirationCatalog(current, dynamicItems));
    } catch {
      if (warnedRef.current) return;
      warnedRef.current = true;
      console.warn("共享灵感目录暂时不可用，继续使用内置精选目录。");
    }
  }, [getSharedInspirationsFn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ items, refresh }), [items, refresh]);

  return (
    <InspirationCatalogContext.Provider value={value}>
      {children}
    </InspirationCatalogContext.Provider>
  );
}
