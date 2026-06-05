'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { UserRole } from '@/lib/auth';

interface UserRecord {
  id: number;
  email: string;
  role: UserRole;
  created_at: string;
}

export default function AdminPage() {
  const router = useRouter();
  const [users, setUsers]     = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState<number | null>(null);
  const [msg, setMsg]         = useState('');

  useEffect(() => {
    fetch('/api/admin/users').then(async r => {
      if (r.status === 403) { router.replace('/'); return; }
      const data = await r.json();
      setUsers(data.users ?? []);
    }).finally(() => setLoading(false));
  }, [router]);

  async function updateRole(id: number, role: UserRole) {
    setSaving(id);
    setMsg('');
    try {
      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, role }),
      });
      if (res.ok) {
        setUsers(prev => prev.map(u => u.id === id ? { ...u, role } : u));
        setMsg('Role updated successfully');
        setTimeout(() => setMsg(''), 2500);
      }
    } finally {
      setSaving(null);
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
  }

  const roleBadge = (role: UserRole) => {
    const map: Record<UserRole, string> = {
      admin: 'bg-purple-900/60 border-purple-700 text-purple-300',
      pro:   'bg-blue-900/60 border-blue-700 text-blue-300',
      free:  'bg-gray-800 border-gray-700 text-gray-400',
    };
    return map[role] ?? map.free;
  };

  return (
    <div className="bg-gray-950 min-h-screen text-white">
      <header className="sticky top-0 z-10 border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Admin Panel</h1>
            <p className="text-gray-500 text-xs mt-0.5">User management</p>
          </div>
          <div className="flex gap-3">
            <button onClick={() => router.push('/')}
              className="px-4 py-2 rounded-lg border border-gray-700 text-gray-300 hover:border-gray-500 text-sm transition-colors">
              Dashboard
            </button>
            <button onClick={logout}
              className="px-4 py-2 rounded-lg border border-red-800 text-red-400 hover:border-red-600 text-sm transition-colors">
              Logout
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {msg && (
          <div className="mb-6 px-4 py-3 rounded-lg bg-green-950/50 border border-green-800 text-green-400 text-sm">
            {msg}
          </div>
        )}

        <div className="rounded-xl border border-gray-800 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-800 bg-gray-900/60 flex items-center justify-between">
            <h2 className="font-semibold">Users ({users.length})</h2>
            <div className="flex gap-2 text-xs text-gray-500">
              <span>{users.filter(u => u.role === 'admin').length} admin</span>
              <span>·</span>
              <span>{users.filter(u => u.role === 'pro').length} pro</span>
              <span>·</span>
              <span>{users.filter(u => u.role === 'free').length} free</span>
            </div>
          </div>

          {loading ? (
            <div className="px-6 py-12 text-center text-gray-600">Loading…</div>
          ) : users.length === 0 ? (
            <div className="px-6 py-12 text-center text-gray-600">No users yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/40">
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Email</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Role</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Joined</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {users.map(user => (
                  <tr key={user.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-6 py-4 text-gray-200">{user.email}</td>
                    <td className="px-6 py-4">
                      <span className={`px-2.5 py-1 rounded-full border text-xs font-semibold ${roleBadge(user.role)}`}>
                        {user.role}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-gray-500 text-xs whitespace-nowrap">
                      {new Date(user.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-2 justify-end">
                        {user.role !== 'pro' && user.role !== 'admin' && (
                          <button
                            onClick={() => updateRole(user.id, 'pro')}
                            disabled={saving === user.id}
                            className="px-3 py-1.5 rounded-lg bg-blue-900/50 border border-blue-700 text-blue-300 hover:bg-blue-800/60 text-xs font-semibold transition-colors disabled:opacity-50">
                            Upgrade to Pro
                          </button>
                        )}
                        {user.role === 'pro' && (
                          <button
                            onClick={() => updateRole(user.id, 'free')}
                            disabled={saving === user.id}
                            className="px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:border-gray-500 text-xs font-semibold transition-colors disabled:opacity-50">
                            Downgrade to Free
                          </button>
                        )}
                        {user.role !== 'admin' && (
                          <button
                            onClick={() => updateRole(user.id, 'admin')}
                            disabled={saving === user.id}
                            className="px-3 py-1.5 rounded-lg bg-purple-900/40 border border-purple-800 text-purple-400 hover:border-purple-600 text-xs font-semibold transition-colors disabled:opacity-50">
                            Make Admin
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
