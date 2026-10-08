import { useEffect, useState } from "react";
import { Users, TrendingUp, DollarSign, Percent } from "lucide-react";
import AdminLayout from "../../components/admin/AdminLayout";
import { adminAPI } from "../../utils/api";

interface MetricsOverview {
  total_users: number;
  active_users_30d: number;
  active_users_7d: number;
  new_users_this_week: number;
  new_users_this_month: number;
  churn_rate: number;
  paid_users: number;
  mrr: number;
  arpu: number;
  free_to_paid_conversion: number;
}

export default function AdminMetricsPage() {
  const [metrics, setMetrics] = useState<MetricsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMetrics();
  }, []);

  const fetchMetrics = async () => {
    try {
      const response = await adminAPI.get("/api/admin/metrics/overview");
      setMetrics(response.data);
    } catch (err) {
      setError("Failed to load metrics");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center h-96">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
        </div>
      </AdminLayout>
    );
  }

  if (error || !metrics) {
    return (
      <AdminLayout>
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-200">
          {error || "Failed to load metrics"}
        </div>
      </AdminLayout>
    );
  }

  const cards = [
    { label: "Total Users", value: metrics.total_users.toLocaleString(), icon: Users, color: "bg-blue-600" },
    { label: "Active (30d)", value: metrics.active_users_30d.toLocaleString(), icon: TrendingUp, color: "bg-green-600" },
    { label: "Active (7d)", value: metrics.active_users_7d.toLocaleString(), icon: TrendingUp, color: "bg-emerald-600" },
    { label: "New This Month", value: metrics.new_users_this_month.toLocaleString(), icon: Users, color: "bg-purple-600" },
    { label: "Paid Users", value: metrics.paid_users.toLocaleString(), icon: DollarSign, color: "bg-orange-600" },
    { label: "Conversion Rate", value: `${(metrics.free_to_paid_conversion * 100).toFixed(1)}%`, icon: Percent, color: "bg-cyan-600" },
    { label: "Churn Rate", value: `${(metrics.churn_rate * 100).toFixed(1)}%`, icon: Percent, color: "bg-red-600" },
    { label: "MRR", value: `$${metrics.mrr.toFixed(2)}`, icon: DollarSign, color: "bg-indigo-600" },
  ];

  return (
    <AdminLayout>
      <div>
        <h1 className="text-3xl font-bold mb-8">Dashboard Overview</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {cards.map((card, idx) => {
            const Icon = card.icon;
            return (
              <div key={idx} className="bg-gray-800 rounded-lg p-6 border border-gray-700 hover:border-gray-600 transition-colors">
                <div className="flex items-start justify-between mb-4">
                  <div className={`${card.color} p-3 rounded-lg`}>
                    <Icon size={24} className="text-white" />
                  </div>
                </div>
                <h3 className="text-gray-400 text-sm font-medium mb-1">{card.label}</h3>
                <p className="text-2xl font-bold">{card.value}</p>
              </div>
            );
          })}
        </div>
      </div>
    </AdminLayout>
  );
}
