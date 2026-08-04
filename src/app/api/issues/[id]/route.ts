import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (typeof body.description === "string") data.description = body.description;
  if (typeof body.telegramLink === "string" || body.telegramLink === null)
    data.telegramLink = body.telegramLink || null;
  if (body.status === "RESOLVED" || body.status === "PENDING")
    data.status = body.status;
  if (typeof body.note === "string" || body.note === null)
    data.note = body.note || null;
  if (typeof body.ticketLink === "string" || body.ticketLink === null)
    data.ticketLink = body.ticketLink || null;
  if (typeof body.position === "number") data.position = body.position;
  if (typeof body.groupName === "string") data.groupName = body.groupName;
  if (typeof body.groupEmoji === "string" || body.groupEmoji === null)
    data.groupEmoji = body.groupEmoji || null;

  const issue = await prisma.issue.update({ where: { id }, data });
  return NextResponse.json({ issue });
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  await prisma.issue.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
