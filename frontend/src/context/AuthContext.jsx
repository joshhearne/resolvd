import React, { createContext, useContext, useState, useEffect } from "react";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [pendingMfa, setPendingMfa] = useState(false);
  const [methods, setMethods] = useState({
    entra: false,
    google: false,
    local: false,
    bootstrap: false,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/auth/me", { credentials: "include" }).then((r) =>
        r.ok
          ? r.json()
          : r.status === 401
            ? r
                .json()
                .then((d) => {
                  if (d?.pendingMfa) setPendingMfa(true);
                  return null;
                })
                .catch(() => null)
            : null,
      ),
      fetch("/auth/methods", { credentials: "include" }).then((r) =>
        r.ok ? r.json() : null,
      ),
    ])
      .then(([u, m]) => {
        setUser(u);
        if (m) setMethods(m);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const loginEntra = () => {
    window.location.href = "/auth/login";
  };
  const loginGoogle = () => {
    window.location.href = "/auth/google/login";
  };
  const logout = () => {
    window.location.href = "/auth/logout";
  };

  async function loginLocal(email, password, { honeypot = "", formDwellMs = null } = {}) {
    const res = await fetch("/auth/local/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      // honeypot + form_dwell_ms are bot-detection signals. Real form
      // never fills the honeypot field; dwell tracks render-to-submit
      // delay so sub-800ms bot submits get refused server-side.
      body: JSON.stringify({ email, password, website: honeypot, form_dwell_ms: formDwellMs }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.pendingMfa) {
      setPendingMfa(true);
      return { pendingMfa: true };
    }
    setUser(data.user);
    setPendingMfa(false);
    return { user: data.user };
  }

  async function bootstrapLocal({ email, password, displayName }) {
    const res = await fetch("/auth/local/bootstrap", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, displayName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setUser(data.user);
    setMethods((m) => ({ ...m, bootstrap: false }));
    return data.user;
  }

  async function submitMfa({ token, recoveryCode }) {
    const res = await fetch("/auth/mfa/challenge", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, recoveryCode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setUser(data.user);
    setPendingMfa(false);
    return data.user;
  }

  async function updatePrefs(patch) {
    const res = await fetch("/api/users/me/prefs", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error("Failed to save preference");
    const merged = await res.json();
    const { default_project_id, ...prefs } = merged;
    setUser((u) =>
      u ? { ...u, preferences: prefs, defaultProjectId: default_project_id ?? null } : u
    );
    return merged;
  }

  async function setDefaultProject(projectId) {
    return updatePrefs({ default_project_id: projectId || null });
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        pendingMfa,
        methods,
        loginEntra,
        loginGoogle,
        loginLocal,
        bootstrapLocal,
        submitMfa,
        logout,
        setUser,
        setDefaultProject,
        updatePrefs,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
