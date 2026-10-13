import { useCallback, useEffect, useRef, useState } from 'react';
import type { DebugSession, SeekProgress } from '../core/debugger';

/** One timer/request at a time. A replaced request never refreshes another
 * session; manual actions cancel at the last exact published cursor. */
export function useHistorySeek(session: DebugSession, callbacks: { onUpdate: () => void; onDone: (session: DebugSession) => void; onError: (message: string) => void }) {
  const listeners = useRef(callbacks); listeners.current = callbacks;
  const active = useRef<{ session: DebugSession; id: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const [progress, setProgress] = useState<SeekProgress | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const cancel = useCallback((announce = false) => {
    const task = active.current;
    active.current = null;
    if (task) {
      if (task.timer !== null) clearTimeout(task.timer);
      task.session.cancelSeek(task.id);
      if (announce) { setMessage(`Navegação cancelada no passo ${task.session.cursor}. O histórico foi preservado.`); listeners.current.onDone(task.session); }
    }
    setProgress(null); if (!announce) setMessage(null);
  }, []);
  useEffect(() => {
    if (!active.current || active.current.session !== session) cancel();
    // Cleanup belongs to this session. A fresh request may already have been
    // started on the next render; an old cleanup must not cancel that request.
    return () => { if (active.current?.session === session) cancel(); };
  }, [session, cancel]);
  const seek = (target: number) => {
    cancel();
    try {
      const start = session.beginSeek(target);
      if (start.done) { listeners.current.onDone(session); listeners.current.onUpdate(); return; }
      const task = { session, id: start.id, timer: null as ReturnType<typeof setTimeout> | null };
      active.current = task;
      const tick = () => {
        if (active.current !== task) return;
        try {
          const update = task.session.seekBatch(task.id);
          if (!update) { cancel(); return; }
          if (update.done) { active.current = null; setProgress(null); listeners.current.onDone(task.session); }
          else { setProgress(update); task.timer = setTimeout(tick, 0); }
          listeners.current.onUpdate();
        } catch (error) { cancel(); listeners.current.onError(error instanceof Error ? error.message : String(error)); listeners.current.onUpdate(); }
      };
      tick();
    } catch (error) { listeners.current.onError(error instanceof Error ? error.message : String(error)); }
  };
  return { seek, cancel, progress: active.current?.session === session ? progress : null, message };
}
