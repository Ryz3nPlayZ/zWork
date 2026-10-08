import { useState } from "react";
import AdminLayout from "../../components/admin/AdminLayout";
import { DollarSign, TrendingUp, Users } from "lucide-react";

export default function AdminBillingPage() {
  const [billingSummary] = useState({
    mrr: 1250.50,
    arr: 15006.00,
    total_revenue: 15006.00,
    active_subscriptions: 5,
    churned_this_month: 1,
    churn_revenue: 99.99,
  });

  const recentTransactions = [
    { id: "sub_123", customer: "john@example.com", amount: 99.99, type: "subscription", status: "active", date: "2026-05-09" },
    { id: "sub_124", customer: "jane@example.com", amount: 199.99, type: "subscription", status: "active", date: "2026-05-08" },
    { id: "sub_125", customer: "bob@example.com", amount: 99.99, type: "cancellation", status: "cancelled", date: "2026-05-07" },
  ];

  const cards = [
    { label: "Monthly Recurring Revenue", value: `$${billingSummary.mrr.toFixed(2)}`, icon: DollarSign, color: "bg-green-600" },
    { label: "Annual Recurring Revenue", value: `$${billingSummary.arr.toFixed(2)}`, icon: TrendingUp, color: "bg-blue-600" },
    { label: "Active Subscriptions", value: billingSummary.active_subscriptions.toString(), icon: Users, color: "bg-purple-600" },
    { label: "Churn This Month", value: billingSummary.churned_this_month.toString(), icon: Users, color: "bg-orange-600" },
  ];

  return (
    <AdminLayout>
      <div>
        <h1 className="text-3xl font-bold mb-8">Billing & Revenue</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
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
        <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
          <table className="w-full">
            <thead><tr className="border-b border-gray-700 bg-gray-900"><th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Customer</th><th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Type</th><th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Amount</th><th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Status</th><th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Date</th></tr></thead>
            <tbody className="divide-y divide-gray-700">
              {recentTransactions.map((tx) => (<tr key={tx.id} className="hover:bg-gray-700/50"><td className="px-6 py-4 text-sm">{tx.customer}</td><td className="px-6 py-4 text-sm capitalize">{tx.type}</td><td className="px-6 py-4 text-sm font-medium">${tx.amount.toFixed(2)}</td><td className="px-6 py-4 text-sm"><span className={`px-2 py-1 rounded text-xs font-semibold ${tx.status === "active" ? "bg-green-700 text-green-200" : "bg-red-700 text-red-200"}`}>{tx.status.toUpperCase()}</span></td><td className="px-6 py-4 text-sm text-gray-400">{tx.date}</td></tr>))}
            </tbody>
          </table>
        </div>
      </div>
    </AdminLayout>
  );
}
