import { AppHeader } from "@/components/AppHeader";
import { Inbox } from "@/components/Inbox";

export default function InboxPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <AppHeader />
      <Inbox />
    </div>
  );
}
