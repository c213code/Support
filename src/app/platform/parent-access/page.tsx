import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { ParentAccessTool } from "@/components/ParentAccessTool";
import { SupportUnavailable } from "@/components/SupportPageHeader";
import { getCurrentIdentity } from "@/lib/auth";
import { platformEnabled } from "@/lib/platform";

export default async function ParentAccessPage() {
  if (!await getCurrentIdentity()) redirect("/login");
  return <AppShell>{platformEnabled() ? <ParentAccessTool /> : <SupportUnavailable title="Доступ родителя" />}</AppShell>;
}
