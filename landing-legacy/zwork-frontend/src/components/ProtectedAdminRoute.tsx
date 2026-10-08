import { useAdminAuth } from "../hooks/useAdminAuth";
import { Navigate } from "react-router-dom";

interface ProtectedAdminRouteProps {
  element: React.ReactElement;
}

export default function ProtectedAdminRoute({ element }: ProtectedAdminRouteProps) {
  const { loading, isAdmin, error } = useAdminAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-400">Checking authentication...</p>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return <Navigate to="/admin/login" replace />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900">
        <div className="text-center">
          <p className="text-red-500 mb-4">{error}</p>
          <a href="/admin/login" className="text-blue-500 hover:text-blue-400">
            Go to login
          </a>
        </div>
      </div>
    );
  }

  return element;
}
