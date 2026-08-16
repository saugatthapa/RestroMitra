export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="text-xl font-semibold tracking-tight text-neutral-900">
            Dhanki<span className="text-orange-600">POS</span>
          </span>
          <p className="mt-1 text-sm text-neutral-500">
            Built for restaurants in Itahari &amp; Sunsari
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
