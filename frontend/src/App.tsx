import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { api } from "./api/client";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Catalog } from "./pages/Catalog";
import { Settings } from "./pages/Settings";
import { Disassemble } from "./pages/Disassemble";
import { NewAppliance } from "./pages/NewAppliance";
import { AddPartPage } from "./pages/AddPartPage";
import { ImportDocument } from "./pages/ImportDocument";

function AppRoutes() {
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) return;
    api<{ darkMode: boolean }>("/api/settings").then((data) => {
      document.documentElement.classList.toggle("dark", data.darkMode);
    }).catch(() => {});
  }, [isAuthenticated]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-gray-950">
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) return <Login />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Catalog />} />
        <Route path="/disassemble" element={<Disassemble />} />
        <Route path="/disassemble/new" element={<NewAppliance />} />
        <Route path="/disassemble/:id" element={<Disassemble />} />
        <Route path="/add" element={<AddPartPage />} />
        <Route path="/import" element={<ImportDocument />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
