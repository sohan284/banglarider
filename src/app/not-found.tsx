import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-full place-items-center p-6 text-center">
      <div>
        <p className="text-5xl font-bold text-[var(--brand)]">404</p>
        <p className="mt-2">Page not found · পৃষ্ঠাটি পাওয়া যায়নি</p>
        <Link href="/" className="mt-4 inline-block rounded-lg bg-[var(--brand)] px-4 py-2 font-semibold text-white">
          Back to the map · মানচিত্রে ফিরুন
        </Link>
      </div>
    </main>
  );
}
