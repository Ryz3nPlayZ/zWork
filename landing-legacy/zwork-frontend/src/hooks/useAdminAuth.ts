import { useState, useEffect } from "react";
import { adminAPI } from "../utils/api";

interface AdminUser {
  email: string;
  name: string;
  tier: string;
}

export function useAdminAuth() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [adminUser, setAdminUser] = useState<AdminUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkAdminAuth();
  }, []);

  const checkAdminAuth = async () => {
    try {
      // Check if token exists in localStorage
      const token = localStorage.getItem("admin_token");
      const email = localStorage.getItem("admin_email");

      if (!token || !email) {
        setIsAdmin(false);
        setError("Not authenticated");
        setLoading(false);
        return;
      }

      // Verify token is valid by calling an admin endpoint
      try {
        await adminAPI.get("/api/admin/metrics/overview");
        setIsAdmin(true);
        setAdminUser({
          email: email,
          name: email.split("@")[0],
          tier: "admin",
        });
      } catch (err: any) {
        // Token invalid or expired
        localStorage.removeItem("admin_token");
        localStorage.removeItem("admin_email");
        setIsAdmin(false);
        setError("Session expired");
      }
    } catch (err: any) {
      setIsAdmin(false);
      setError("Auth check failed");
    } finally {
      setLoading(false);
    }
  };

  return { isAdmin, loading, adminUser, error, checkAdminAuth };
}
