import { createContext, useContext, useState, useCallback } from 'react';

/**
 * Replaces window.alert and window.confirm.
 *
 * Native browser dialogs are the fastest way to make a product look unfinished,
 * and confirm() blocks the whole tab. These are inline, dismissible and styled.
 */
const Ctx = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [ask, setAsk] = useState(null);

  const notify = useCallback((message, tone = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const confirm = useCallback((message, confirmLabel = 'Confirm') =>
    new Promise((resolve) => setAsk({ message, confirmLabel, resolve })), []);

  const settle = (value) => { ask?.resolve(value); setAsk(null); };

  return (
    <Ctx.Provider value={{ notify, confirm }}>
      {children}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}
               onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
            {t.message}
          </div>
        ))}
      </div>

      {ask && (
        <div className="scrim" onClick={() => settle(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <p>{ask.message}</p>
            <div className="dialog-actions">
              <button className="link" onClick={() => settle(false)}>Cancel</button>
              <button onClick={() => settle(true)}>{ask.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
