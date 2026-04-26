import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { BrandingProvider } from "./context/BrandingContext";
import { StatusesProvider } from "./context/StatusesContext";
import { ThemeProvider } from "./context/ThemeContext";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import TicketList from "./pages/TicketList";
import NewTicket from "./pages/NewTicket";
import TicketDetail from "./pages/TicketDetail";
import Admin from "./pages/Admin";
import AdminUsers from "./pages/AdminUsers";
import AdminAuth from "./pages/AdminAuth";
import AdminBranding from "./pages/AdminBranding";
import AdminExport from "./pages/AdminExport";
import AdminStatuses from "./pages/AdminStatuses";
import AdminCompanies from "./pages/AdminCompanies";
import AdminEmailTemplates from "./pages/AdminEmailTemplates";
import AdminInbound from "./pages/AdminInbound";
import AdminSupport from "./pages/AdminSupport";
import AdminEncryption from "./pages/AdminEncryption";
import PrintExport from "./pages/PrintExport";
import Projects from "./pages/Projects";
import ProjectDetail from "./pages/ProjectDetail";
import Login from "./pages/Login";
import MfaChallenge from "./pages/MfaChallenge";
import MfaSetup from "./pages/MfaSetup";
import AccountSettings from "./pages/AccountSettings";
import AccountProfile from "./pages/account/AccountProfile";
import AccountPassword from "./pages/account/AccountPassword";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import AcceptInvite from "./pages/AcceptInvite";

function ProtectedRoute({ children, adminOnly = false }) {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div className="flex items-center justify-center h-screen text-fg-muted">
        Loading...
      </div>
    );
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && !["Admin", "Manager"].includes(user.role))
    return <Navigate to="/" replace />;
  return children;
}

function AppRoutes() {
  const { user, loading, pendingMfa } = useAuth();
  if (loading)
    return (
      <div className="flex items-center justify-center h-screen text-fg-muted">
        Loading...
      </div>
    );

  return (
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/" replace /> : <Login />}
      />
      <Route
        path="/mfa-challenge"
        element={
          pendingMfa ? <MfaChallenge /> : <Navigate to="/login" replace />
        }
      />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password/:token" element={<ResetPassword />} />
      <Route path="/accept-invite/:token" element={<AcceptInvite />} />
      <Route
        path="/print-export"
        element={
          <ProtectedRoute adminOnly>
            <PrintExport />
          </ProtectedRoute>
        }
      />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="tickets" element={<TicketList />} />
        <Route
          path="tickets/new"
          element={
            <ProtectedRoute>
              <NewTicket />
            </ProtectedRoute>
          }
        />
        <Route path="tickets/:id" element={<TicketDetail />} />
        <Route
          path="account/mfa"
          element={<Navigate to="/account/settings/mfa" replace />}
        />
        <Route path="account/settings" element={<AccountSettings />}>
          <Route index element={<Navigate to="profile" replace />} />
          <Route path="profile" element={<AccountProfile />} />
          <Route path="password" element={<AccountPassword />} />
          <Route path="mfa" element={<MfaSetup />} />
        </Route>
        <Route
          path="projects"
          element={
            <ProtectedRoute adminOnly>
              <Projects />
            </ProtectedRoute>
          }
        />
        <Route
          path="projects/:id"
          element={
            <ProtectedRoute adminOnly>
              <ProjectDetail />
            </ProtectedRoute>
          }
        />
        <Route
          path="admin"
          element={
            <ProtectedRoute adminOnly>
              <Admin />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="users" replace />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="auth" element={<AdminAuth />} />
          <Route path="statuses" element={<AdminStatuses />} />
          <Route path="branding" element={<AdminBranding />} />
          <Route path="export" element={<AdminExport />} />
          <Route path="companies" element={<AdminCompanies />} />
          <Route path="email-templates" element={<AdminEmailTemplates />} />
          <Route path="inbound" element={<AdminInbound />} />
          <Route path="support" element={<AdminSupport />} />
          <Route path="encryption" element={<AdminEncryption />} />
        </Route>
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <BrandingProvider>
        <AuthProvider>
          <StatusesProvider>
            <BrowserRouter>
              <Toaster position="top-right" toastOptions={{ duration: 4000 }} />
              <AppRoutes />
            </BrowserRouter>
          </StatusesProvider>
        </AuthProvider>
      </BrandingProvider>
    </ThemeProvider>
  );
}
