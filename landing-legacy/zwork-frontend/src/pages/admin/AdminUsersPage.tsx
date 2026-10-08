import { useEffect, useState } from "react";
import AdminLayout from "../../components/admin/AdminLayout";
import { adminAPI } from "../../utils/api";

interface AdminUser {
  user_id: string;
  email: string;
  name: string;
  tier: string;
  created_at: string;
  last_activity: string | null;
  total_requests: number;
  total_tokens: number;
  stripe_customer_id: string | null;
  subscription_status: string | null;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [showUpdateTier, setShowUpdateTier] = useState(false);
  const [newTier, setNewTier] = useState("");

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      const response = await adminAPI.get("/api/admin/users");
      setUsers(response.data);
    } catch (err) {
      setError("Failed to load users");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const updateUserTier = async () => {
    if (!selectedUser || !newTier) return;
    try {
      await adminAPI.put(`/api/admin/users/${selectedUser.user_id}/tier`, { tier: newTier });
      setShowUpdateTier(false);
      setSelectedUser(null);
      fetchUsers();
    } catch (err) {
      alert("Failed to update tier");
    }
  };

  const filteredUsers = users.filter((user) => {
    const matchesSearch = user.email.toLowerCase().includes(searchTerm.toLowerCase()) || user.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesTier = tierFilter === "all" || user.tier === tierFilter;
    return matchesSearch && matchesTier;
  });

  if (loading) {
    return <AdminLayout><div className="flex items-center justify-center h-96"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div></div></AdminLayout>;
  }

  return (
    <AdminLayout>
      <div>
        <h1 className="text-3xl font-bold mb-8">Users Management</h1>
        <div className="flex gap-4 mb-6">
          <input type="text" placeholder="Search by email or name..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="flex-1 px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:border-blue-500 text-white" />
          <select value={tierFilter} onChange={(e) => setTierFilter(e.target.value)} className="px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:border-blue-500 text-white">
            <option value="all">All Tiers</option>
            <option value="free">Free</option>
            <option value="pro">Pro</option>
            <option value="max">Max</option>
          </select>
        </div>
        {error && <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-200 mb-6">{error}</div>}
        <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
          <table className="w-full">
            <thead><tr className="border-b border-gray-700 bg-gray-900"><th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Email</th><th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Name</th><th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Tier</th><th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Requests</th><th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Tokens</th><th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Last Activity</th><th className="px-6 py-3 text-left text-sm font-semibold text-gray-300">Actions</th></tr></thead>
            <tbody className="divide-y divide-gray-700">
              {filteredUsers.length === 0 ? <tr><td colSpan={7} className="px-6 py-8 text-center text-gray-400">No users found</td></tr> : filteredUsers.map((user) => (<tr key={user.user_id} className="hover:bg-gray-700/50 transition-colors"><td className="px-6 py-4 text-sm">{user.email}</td><td className="px-6 py-4 text-sm">{user.name}</td><td className="px-6 py-4 text-sm"><span className={`px-2 py-1 rounded text-xs font-semibold ${user.tier === 'free' ? 'bg-gray-700 text-gray-200' : user.tier === 'pro' ? 'bg-blue-700 text-blue-200' : 'bg-purple-700 text-purple-200'}`}>{user.tier.toUpperCase()}</span></td><td className="px-6 py-4 text-sm">{user.total_requests.toLocaleString()}</td><td className="px-6 py-4 text-sm">{user.total_tokens.toLocaleString()}</td><td className="px-6 py-4 text-sm text-gray-400">{user.last_activity ? new Date(user.last_activity).toLocaleDateString() : "Never"}</td><td className="px-6 py-4 text-sm"><button onClick={() => {setSelectedUser(user); setNewTier(user.tier); setShowUpdateTier(true);}} className="px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-xs font-medium transition-colors">Update Tier</button></td></tr>))}
            </tbody>
          </table>
        </div>
      </div>
      {showUpdateTier && selectedUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-96 border border-gray-700">
            <h2 className="text-xl font-bold mb-4">Update User Tier</h2>
            <p className="text-gray-300 mb-4">Update tier for <strong>{selectedUser.email}</strong></p>
            <select value={newTier} onChange={(e) => setNewTier(e.target.value)} className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:border-blue-500 text-white mb-6">
              <option value="free">Free</option>
              <option value="pro">Pro</option>
              <option value="max">Max</option>
            </select>
            <div className="flex gap-4">
              <button onClick={() => {setShowUpdateTier(false); setSelectedUser(null);}} className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors">Cancel</button>
              <button onClick={updateUserTier} className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors font-medium">Update</button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
