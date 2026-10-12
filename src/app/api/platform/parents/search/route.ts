import { NextResponse, type NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findParentAccounts, platformEnabled, PlatformError } from "@/lib/platform";
import { parentContacts, ParentAccessError, type ParentLookup } from "@/lib/parentAccess";

export async function POST(request: NextRequest) {
  if (!await getCurrentIdentity()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!platformEnabled()) return NextResponse.json({ error: "Инструмент не настроен" }, { status: 503 });
  const body = await request.json().catch(() => null);
  const issueId = typeof body?.issueId === "string" ? body.issueId.trim() : "";
  let query = typeof body?.query === "string" ? body.query.trim() : "";
  if (query.length > 6000 || issueId.length > 64) return NextResponse.json({ error: "Слишком длинный запрос" }, { status: 400 });
  if (!query && issueId) {
    const issue = await prisma.issue.findUnique({ where: { id: issueId }, select: {
      description: true, telegramLink: true, extraLinks: true,
      sourceMessages: { select: { text: true }, orderBy: { receivedAt: "desc" }, take: 20 },
      submissions: { select: { rawText: true, studentContact: true }, orderBy: { createdAt: "desc" }, take: 3 },
    } });
    if (!issue) return NextResponse.json({ error: "Тикет не найден" }, { status: 404 });
    const links = [...new Set([issue.telegramLink, ...issue.extraLinks].filter((link): link is string => Boolean(link)))];
    const referenced = links.length ? await prisma.telegramMessage.findMany({
      where: { messageLink: { in: links } }, select: { text: true }, take: 20,
    }) : [];
    query = [issue.description, ...issue.sourceMessages.map((message) => message.text || ""),
      ...referenced.map((message) => message.text || ""),
      ...issue.submissions.flatMap((submission) => [submission.rawText || "", submission.studentContact])].join("\n");
  }
  const contacts = parentContacts(query, !issueId);
  if (!contacts.length) return NextResponse.json({ error: "Добавьте номер/почту родителя или ученика. Можно вставить список из обращения." }, { status: 400 });
  if (contacts.length > 10) return NextResponse.json({ error: "За один поиск можно проверить до 10 контактов. Разделите список." }, { status: 400 });
  const lookups: ParentLookup[] = [];
  for (let start = 0; start < contacts.length; start += 3) {
    lookups.push(...await Promise.all(contacts.slice(start, start + 3).map(async (contact) => {
      try { return await findParentAccounts(contact); }
      catch (error) {
        if (error instanceof PlatformError || error instanceof ParentAccessError) {
          return { query: contact, parents: [], notes: [error.message] };
        }
        throw error;
      }
    })));
  }
  return NextResponse.json({ lookups }, { headers: { "Cache-Control": "no-store" } });
}
