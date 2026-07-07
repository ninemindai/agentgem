import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

interface ToastItem { id: number; message: string }
interface ToastApi { push: (message: string) => void }

const ToastCtx = createContext<ToastApi>({ push: () => {} });
export const useToast = (): ToastApi => useContext(ToastCtx);

const TTL_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const remove = useCallback((id: number) => {
    const h = timers.current.get(id);
    if (h) {
      clearTimeout(h);
      timers.current.delete(id);
    }
    setItems((xs) => xs.filter((t) => t.id !== id));
  }, []);
  const push = useCallback((message: string) => {
    const id = nextId.current++;
    setItems((xs) => [...xs, { id, message }]);
    timers.current.set(id, setTimeout(() => remove(id), TTL_MS));
  }, [remove]);

  useEffect(() => () => {
    for (const h of timers.current.values()) clearTimeout(h);
    timers.current.clear();
  }, []);

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className="toast">
            <span className="toast-msg">{t.message}</span>
            <button className="toast-close" aria-label="Dismiss" onClick={() => remove(t.id)}>×</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
