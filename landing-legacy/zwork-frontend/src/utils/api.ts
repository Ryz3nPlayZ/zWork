import axios from "axios";

const API_BASE = (import.meta as any).env.VITE_API_URL || "https://api.tryzwork.app";

export const adminAPI = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
});

// Add response interceptor to handle auth errors
adminAPI.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 || error.response?.status === 403) {
      // User is not authenticated or not authorized
      window.location.href = "/admin/login";
    }
    return Promise.reject(error);
  }
);

export default adminAPI;
