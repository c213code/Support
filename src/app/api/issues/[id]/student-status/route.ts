import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { extractTicketHints } from "@/lib/ticketHints";
import {
  findStudentByContact,
  isStudentRegistered,
  platformEnabled,
  studentStreamCount,
} from "@/lib/platform";

type Params = { params: Promise<{ id: string }> };

// Что платформа знает об ученике этого тикета — для строки «🔎 Платформа» в
// окне тикета. Раньше за этим дежурный ходил в админку руками: есть ли
// аккаунт, закончена ли регистрация, подключён ли курс.
//
// Контакт — из заявки формы, иначе первые почта/номер из сообщений тикета
// (те же зацепки, что на карточке). Пробуем не больше трёх контактов:
// платформа отвечает до нескольких секунд.
const MAX_CONTACTS = 3;

export async function GET(_request: NextRequest, { params }: Params) {
  if (!(await getCurrentIdentity())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!platformEnabled()) return NextResponse.json({ available: false });
  const { id } = await params;

  const [submissions, messages] = await Promise.all([
    prisma.issueSubmission.findMany({
      where: { issueId: id },
      select: { studentContact: true, rawText: true },
    }),
    prisma.telegramMessage.findMany({
      where: { usedForIssueId: id },
      select: { text: true },
    }),
  ]);
  const hints = extractTicketHints([
    ...submissions.flatMap((s) => [s.studentContact, s.rawText]),
    ...messages.map((m) => m.text),
  ]);
  const contacts = [
    ...submissions.map((s) => s.studentContact.trim()).filter(Boolean),
    ...hints.emails,
    ...hints.phones,
  ];
  const unique = [...new Set(contacts)].slice(0, MAX_CONTACTS);
  if (unique.length === 0) return NextResponse.json({ available: true, contact: null });

  try {
    for (const contact of unique) {
      const student = await findStudentByContact(contact);
      if (!student) continue;
      const [registered, streams] = await Promise.all([
        student.email ? isStudentRegistered(student.email).catch(() => null) : null,
        studentStreamCount(student.id),
      ]);
      return NextResponse.json({
        available: true,
        contact,
        found: true,
        name: [student.firstname, student.lastname].filter(Boolean).join(" ").trim() || null,
        email: student.email,
        phone: student.phoneNumber,
        registered,
        streams,
      });
    }
    return NextResponse.json({ available: true, contact: unique[0], found: false });
  } catch (err) {
    console.warn(`[platform] статус ученика не получен: ${String(err).slice(0, 150)}`);
    return NextResponse.json({ available: false });
  }
}
