import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAuth } from './AuthContext';

const StatusesContext = createContext(null);

export function StatusesProvider({ children }) {
  const { user } = useAuth();
  const [statuses, setStatuses] = useState({ internal: [], external: [], transitions: [], mappings: [] });
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/statuses', { credentials: 'include' });
      if (!res.ok) return;
      const d = await res.json();
      setStatuses(d);
      setLoaded(true);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (user) refresh();
    else setLoaded(false);
  }, [user, refresh]);

  return (
    <StatusesContext.Provider value={{ ...statuses, loaded, refresh }}>
      {children}
    </StatusesContext.Provider>
  );
}

export function useStatuses() {
  return useContext(StatusesContext) || { internal: [], external: [], transitions: [], mappings: [], loaded: false, refresh: () => {} };
}

// Helpers — tolerate missing/loading state.
export function statusByName(list, name) {
  return list.find(s => s.name === name) || null;
}

export function nextAllowedStatusIds(transitions, fromId) {
  return transitions.filter(t => t.from_status_id === fromId).map(t => t.to_status_id);
}

export function suggestedExternalForInternal(mappings, internalStatusId) {
  return mappings.filter(m => m.internal_status_id === internalStatusId);
}
