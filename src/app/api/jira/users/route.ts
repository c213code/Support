import { NextResponse } from "next/server";
import { assignableUsers, jiraConfigured, JiraError } from "@/lib/jira";

// Кому в проекте Jira можно назначить баг — список для выбора исполнителя.
// configured: false — токена нет, кнопку «Баг в Jira» не показываем.
export async function GET() {
  if (!jiraConfigured()) return NextResponse.json({ configured: false, users: [] });
  try {
    return NextResponse.json({ configured: true, users: await assignableUsers() });
  } catch (err) {
    const message = err instanceof JiraError ? err.message : "Jira недоступна";
    return NextResponse.json({ configured: true, users: [], error: message }, { status: 502 });
  }
}
