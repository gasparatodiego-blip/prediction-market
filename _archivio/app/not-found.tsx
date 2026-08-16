import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="bg-gray-950 text-white min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="text-6xl font-bold text-gray-700 mb-4">404</div>
        <h1 className="text-xl font-semibold text-gray-300 mb-2">Page not found</h1>
        <p className="text-gray-500 text-sm mb-8">The page you&apos;re looking for doesn&apos;t exist.</p>
        <Link href="/" className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-colors">
          Back to Home
        </Link>
      </div>
    </main>
  );
}
