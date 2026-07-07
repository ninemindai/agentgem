import { createContext, useContext, useCallback, useRef, useState, type ReactElement, type ReactNode } from "react";

interface ToastItem { id: number; message: string }
interface ToastApi { push: (message: string) => void }

const ToastCtx = createContext<ToastApi>({ push: () => {} });
export const useToast = (): ToastApi => useContext(ToastCtx);

const TTL_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const remove = useCallback((id: number) => setItems((xs) => xs.filter((t) => t.id !== id)), []);
  const push = useCallback((message: string) => {
    const id = nextId.current++;
    setItems((xs) => [...xs, { id, message }]);
    setTimeout(() => remove(id), TTL_MS);
  }, [remove]);

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
