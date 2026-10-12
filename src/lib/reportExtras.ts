import { prisma } from "@/lib/prisma";
import { generateReportText } from "@/lib/report";
import { appUrl, ticketShortCode, ticketUrl } from "@/lib/miniapp";

// Репорт боссам целиком — с тем, что знает только сервер: ссылки «#4JQ9PW» на
// тикеты на доске, отметка про авто-репорт и подвал «сделано с помощью».
// Один на отправку ботом (HTML) и на превью/копирование на сайте (оба
// варианта), чтобы скопированное руками не отличалось от отправленного.

function pluralDecisions(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "решение";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "решения";
  return "решений";
}

export async function reportFooter(reportDate: string): Promise<string[]> {
  const lines: string[] = [];

  // Авто-репорт сам ничего не меняет — статус ставит человек, нажав
  // «Применить». Отмечаем, только если на этот день его решения применяли.
  const applied = await prisma.reconcileVerdict.count({
    where: { appliedAt: { not: null }, run: { reportDate } },
  });
  if (applied > 0) {
    lines.push(
      `🤖 Статусы сверены авто-репортом: ИИ разобрал переписку дня, ${applied} ${pluralDecisions(applied)} проверено и применено вручную.`
    );
  }

  const site = appUrl("/");
  if (site) lines.push(`Сделано с помощью Support Reports — ${site}`);
  // Вход — отдельной переменной, а не паролем агента напрямую: сменили
  // пароль после утечки — новый не должен сам уйти в репорт.
  const login = process.env.REPORT_LOGIN?.trim();
  if (login) lines.push(`Вход: имя и пароль — ${login}`);
  return lines;
}

export async function buildReport(reportDate: string): Promise<{ text: string; html: string }> {
  const [issues, presets, footer] = await Promise.all([
    prisma.issue.findMany({ where: { reportDate }, orderBy: [{ position: "asc" }] }),
    prisma.groupPreset.findMany({ orderBy: { order: "asc" } }),
    reportFooter(reportDate),
  ]);
  const common = { ticketUrl, ticketCode: ticketShortCode, footer };
  return {
    text: generateReportText(issues, presets, { ...common, format: "plain" }),
    html: generateReportText(issues, presets, { ...common, format: "html" }),
  };
}
