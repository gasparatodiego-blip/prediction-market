'use client';
import { useState } from 'react';
import Link from 'next/link';

export default function ForgotPage() {
  const [email,   setEmail]   = useState('');
  const [sent,    setSent]    = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    // Placeholder — real implementation would send a reset email
    await new Promise(r => setTimeout(r, 800));
    setSent(true); setLoading(false);
  }

  return (
    <main className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white mb-1">Reset Password</h1>
          <p className="text-gray-500 text-sm">Enter your email to receive a reset link</p>
        </div>

        {sent ? (
          <div className="rounded-xl border border-green-700 bg-green-950/30 p-5 text-center">
            <div className="text-3xl mb-2">📧</div>
            <p className="text-green-300 font-semibold">Check your email</p>
            <p className="text-gray-500 text-xs mt-1">If an account exists for {email}, a reset link has been sent.</p>
            <Link href="/auth/login" className="mt-4 inline-block text-blue-400 text-sm hover:text-blue-300">← Back to login</Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">Email</label>
              <input type="email" required value={email} onChange={e => setEmail(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
                placeholder="you@example.com" />
            </div>
            <button type="submit" disabled={loading}
              className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors disabled:opacity-50">
              {loading ? 'Sending…' : 'Send Reset Link'}
            </button>
            <p className="text-center text-xs text-gray-600">
              <Link href="/auth/login" className="hover:text-gray-400">← Back to login</Link>
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
