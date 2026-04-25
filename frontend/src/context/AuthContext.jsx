import React, { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/auth/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => { setUser(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const login = () => { window.location.href = '/auth/login'; };
  const logout = () => { window.location.href = '/auth/logout'; };

  async function setDefaultProject(projectId) {
    await fetch('/api/users/me/preferences', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ default_project_id: projectId }),
    });
    setUser(u => ({ ...u, defaultProjectId: projectId || null }));
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, setUser, setDefaultProject }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
