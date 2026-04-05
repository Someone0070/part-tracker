import { Outlet } from "react-router-dom";
import { BottomNav } from "./BottomNav";

export function Layout() {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <main className="pb-20 max-w-lg mx-auto px-4">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}
