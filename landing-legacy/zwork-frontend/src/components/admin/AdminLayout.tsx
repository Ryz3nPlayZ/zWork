import { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { BarChart3, Users, TrendingUp, DollarSign, Menu, X } from "lucide-react";
import { useState } from "react";

interface AdminLayoutProps {
  children: ReactNode;
}

export default function AdminLayout({ children }: AdminLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const location = useLocation();

  const navItems = [
    { path: "/admin", label: "Metrics", icon: BarChart3 },
    { path: "/admin/users", label: "Users", icon: Users },
    { path: "/admin/usage", label: "Usage", icon: TrendingUp },
    { path: "/admin/billing", label: "Billing", icon: DollarSign },
  ];

  const isActive = (path: string) =>
    location.pathname === path || (path !== "/admin" && location.pathname.startsWith(path));

  return (
    <div className="flex h-screen bg-gray-900 text-gray-100">
      {/* Sidebar */}
      <aside
        className={`${
          sidebarOpen ? "w-64" : "w-20"
        } bg-gray-800 border-r border-gray-700 transition-all duration-300 overflow-hidden flex flex-col`}
      >
        <div className="p-4 border-b border-gray-700">
          <h1 className={`${sidebarOpen ? "text-xl" : "text-sm"} font-bold truncate`}>
            {sidebarOpen ? "zWork Admin" : "ZW"}
          </h1>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          {navItems.map(({ path, label, icon: Icon }) => (
            <Link
              key={path}
              to={path}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                isActive(path)
                  ? "bg-blue-600 text-white"
                  : "hover:bg-gray-700 text-gray-300"
              }`}
              title={label}
            >
              <Icon size={20} className="flex-shrink-0" />
              {sidebarOpen && <span>{label}</span>}
            </Link>
          ))}
        </nav>

        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="m-4 p-2 hover:bg-gray-700 rounded-lg"
          title="Toggle sidebar"
        >
          {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <div className="p-8">{children}</div>
      </main>
    </div>
  );
}
