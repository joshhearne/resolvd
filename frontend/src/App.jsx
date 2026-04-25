import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
import { BrandingProvider } from './context/BrandingContext';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import TicketList from './pages/TicketList';
import NewTicket from './pages/NewTicket';
import TicketDetail from './pages/TicketDetail';
import AdminUsers from './pages/AdminUsers';
import AdminBranding from './pages/AdminBranding';
import AdminExport from './pages/AdminExport';
import PrintExport from './pages/PrintExport';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import Login from './pages/Login';

function ProtectedRoute({ children, adminOnly = false }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen text-gray-500">Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && user.role !== 'Admin') return <Navigate to="/" replace />;
  return children;
}

function AppRoutes() {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen text-gray-500">Loading...</div>;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/print-export" element={<ProtectedRoute adminOnly><PrintExport /></ProtectedRoute>} />
      <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="tickets" element={<TicketList />} />
        <Route path="tickets/new" element={<ProtectedRoute><NewTicket /></ProtectedRoute>} />
        <Route path="tickets/:id" element={<TicketDetail />} />
        <Route path="admin/users" element={<ProtectedRoute adminOnly><AdminUsers /></ProtectedRoute>} />
        <Route path="projects" element={<ProtectedRoute adminOnly><Projects /></ProtectedRoute>} />
        <Route path="projects/:id" element={<ProtectedRoute adminOnly><ProjectDetail /></ProtectedRoute>} />
        <Route path="admin/branding" element={<ProtectedRoute adminOnly><AdminBranding /></ProtectedRoute>} />
        <Route path="admin/export" element={<ProtectedRoute adminOnly><AdminExport /></ProtectedRoute>} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrandingProvider>
      <AuthProvider>
        <BrowserRouter>
          <Toaster position="top-right" toastOptions={{ duration: 4000 }} />
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </BrandingProvider>
  );
}
