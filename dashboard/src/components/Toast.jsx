import { createContext, useCallback, useContext, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';

const ToastContext = createContext(() => {});

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);

  const push = useCallback((text, tone = 'ok', title = '') => {
    const id = Math.random().toString(36).slice(2);
    const resolvedTitle = title || (tone === 'ok' ? 'Success' : tone === 'bad' ? 'Error' : 'Notice');
    setItems((list) => [...list, { id, text, tone, title: resolvedTitle }]);
    setTimeout(() => setItems((list) => list.filter((i) => i.id !== id)), 4000);
  }, []);

  const remove = useCallback((id) => {
    setItems((list) => list.filter((i) => i.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.div
              key={t.id}
              className={`toast ${t.tone}`}
              layout
              initial={{ opacity: 0, y: -28, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -20, scale: 0.92 }}
              transition={{ type: 'spring', damping: 24, stiffness: 320 }}
            >
              <div className={`toast-badge ${t.tone}`}>
                {t.tone === 'ok' ? '✓' : t.tone === 'bad' ? '✕' : 'ℹ'}
              </div>
              <div className="toast-content">
                {t.title && <div className="toast-title">{t.title}</div>}
                <div className="toast-msg">{t.text}</div>
              </div>
              <button
                type="button"
                className="toast-close"
                onClick={() => remove(t.id)}
                aria-label="Dismiss notification"
              >
                ×
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
