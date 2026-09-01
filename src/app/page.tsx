import { AppShell } from "@/components/AppShell";
import { Dashboard } from "@/components/Dashboard";
import { todayDateString } from "@/lib/date";

type Props = {
  searchParams: Promise<{ date?: string }>;
};

export default async function Home({ searchParams }: Props) {
  const params = await searchParams;
  const date = params.date ?? todayDateString();

  return (
    <AppShell>
      <Dashboard initialDate={date} />
    </AppShell>
  );
}
