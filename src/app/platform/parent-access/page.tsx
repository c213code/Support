import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { ParentAccessTool } from "@/components/ParentAccessTool";
import { SupportUnavailable } from "@/components/SupportPageHeader";
import { getCurrentIdentity } from "@/lib/auth";
import { platformEnabled } from "@/lib/platform";
import { isParentAccessBotEnabled } from "@/lib/settings";
import { parentAccessBotReady } from "@/lib/parentAccessBot";

export default async function ParentAccessPage() {
  if (!await getCurrentIdentity()) redirect("/login");
  return <AppShell>{platformEnabled() ? <ParentAccessTool initialBotEnabled={await isParentAccessBotEnabled()}
    botReady={parentAccessBotReady()} /> : <SupportUnavailable title="Доступ родителя" />}</AppShell>;
}
