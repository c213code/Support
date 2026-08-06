import { AppHeader } from "@/components/AppHeader";
import { Dashboard } from "@/components/Dashboard";
import { todayDateString } from "@/lib/date";

type Props = {
  searchParams: Promise<{ date?: string }>;
};

export default async function Home({ searchParams }: Props) {
  const params = await searchParams;
  const date = params.date ?? todayDateString();

  return (
    <div className="min-h-screen">
      <AppHeader />
      <Dashboard initialDate={date} />
    </div>
  );
}
