import { useEffect, useState } from "react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import AdminLayout from "../../components/admin/AdminLayout";
import { adminAPI } from "../../utils/api";

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];

interface UsageByTime {
  date: string;
  requests: number;
  tokens: number;
}

interface UsageByModel {
  model_id: string;
  requests: number;
  tokens: number;
  percentage: number;
}

export default function AdminUsagePage() {
  const [usageByTime, setUsageByTime] = useState<UsageByTime[]>([]);
  const [usageByModel, setUsageByModel] = useState<UsageByModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchUsageData();
  }, []);

  const fetchUsageData = async () => {
    try {
      const [timeRes, modelRes] = await Promise.all([
        adminAPI.get("/api/admin/usage/by-time"),
        adminAPI.get("/api/admin/usage/by-model"),
      ]);
      setUsageByTime(timeRes.data.reverse());
      setUsageByModel(modelRes.data);
    } catch (err) {
      setError("Failed to load usage data");
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <AdminLayout><div className="flex items-center justify-center h-96"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div></div></AdminLayout>;

  return (
    <AdminLayout>
      <div>
        <h1 className="text-3xl font-bold mb-8">Usage Analytics</h1>
        {error && <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-200 mb-6">{error}</div>}
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-6 mb-8">
          <h2 className="text-xl font-bold mb-4">API Requests Over Time (Last 90 Days)</h2>
          {usageByTime.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={usageByTime}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="date" stroke="#9ca3af" />
                <YAxis stroke="#9ca3af" />
                <Tooltip contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151" }} labelStyle={{ color: "#f3f4f6" }} />
                <Legend />
                <Line type="monotone" dataKey="requests" stroke="#3b82f6" dot={false} name="Requests" />
              </LineChart>
            </ResponsiveContainer>
          ) : <p className="text-gray-400">No data available</p>}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          <div className="bg-gray-800 rounded-lg border border-gray-700 p-6">
            <h2 className="text-xl font-bold mb-4">API Calls by Model</h2>
            {usageByModel.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={usageByModel}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="model_id" stroke="#9ca3af" angle={-45} textAnchor="end" height={80} />
                  <YAxis stroke="#9ca3af" />
                  <Tooltip contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151" }} labelStyle={{ color: "#f3f4f6" }} />
                  <Bar dataKey="requests" fill="#3b82f6" />
                </BarChart>
              </ResponsiveContainer>
            ) : <p className="text-gray-400">No data available</p>}
          </div>
          <div className="bg-gray-800 rounded-lg border border-gray-700 p-6">
            <h2 className="text-xl font-bold mb-4">Token Distribution</h2>
            {usageByModel.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={usageByModel} cx="50%" cy="50%" outerRadius={80} fill="#8884d8" dataKey="tokens">
                    {usageByModel.map((_, index) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151" }} labelStyle={{ color: "#f3f4f6" }} />
                </PieChart>
              </ResponsiveContainer>
            ) : <p className="text-gray-400">No data available</p>}
          </div>
        </div>
        <div className="mt-8 bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
          <table className="w-full">
            <thead><tr className="border-b border-gray-700 bg-gray-900"><th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Model</th><th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Requests</th><th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Tokens</th><th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">% of Total</th></tr></thead>
            <tbody className="divide-y divide-gray-700">
              {usageByModel.length === 0 ? <tr><td colSpan={4} className="px-6 py-8 text-center text-gray-400">No usage data</td></tr> : usageByModel.map((model) => (<tr key={model.model_id} className="hover:bg-gray-700/50"><td className="px-6 py-4 text-sm font-medium">{model.model_id}</td><td className="px-6 py-4 text-sm">{model.requests}</td><td className="px-6 py-4 text-sm">{model.tokens.toLocaleString()}</td><td className="px-6 py-4 text-sm"><div className="flex items-center gap-2"><div className="w-32 bg-gray-700 rounded-full h-2"><div className="bg-blue-500 h-2 rounded-full" style={{ width: `${model.percentage}%` }}></div></div><span>{model.percentage.toFixed(1)}%</span></div></td></tr>))}
            </tbody>
          </table>
        </div>
      </div>
    </AdminLayout>
  );
}
