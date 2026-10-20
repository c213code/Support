import { STATUS_META, type IssueStatus } from "@/lib/status";
import { isWeekendDate } from "@/lib/date";

export type ReportIssue = {
  // Нужен для ссылки «#4JQ9PW» на тикет на доске (см. ReportOptions).
  id?: string;
  groupName: string;
  groupEmoji: string | null;
  position: number;
  description: string;
  telegramLink: string | null;
  // Дополнительные сообщения, приклеенные к тому же тикету (см.
  // POST /api/issues/[id]/attach-message). В репорте идут отдельными
  // строками следом за основной ссылкой.
  extraLinks?: string[];
  status: IssueStatus;
  note: string | null;
  ticketLink: string | null;
};

export type ReportGroupPreset = {
  name: string;
  emoji: string | null;
  order: number;
};

export function isReportableIssue(issue: Pick<ReportIssue, "status" | "groupName">): boolean {
  return issue.status !== "SENT" && !/^ielts(?:\s*🎓)?$/i.test(issue.groupName.trim());
}

const SEPARATOR = "—".repeat(30);

// Как выводить репорт. По умолчанию — простой текст, как раньше (разбор в
// личке, превью). Боссам бот шлёт HTML: номер тикета «#4JQ9PW» перед
// описанием — ссылка на сам тикет на доске, как «Өтініш #…» в постах
// мини-аппа. Ссылки собирает вызывающий (на сервере, по адресу сайта):
// этот файл работает и в браузере, где адреса сайта нет.
export type ReportOptions = {
  format?: "plain" | "html";
  compact?: boolean;
  reportDate?: string;
  dutyName?: string | null;
  ticketUrl?: (issueId: string) => string | null;
  ticketCode?: (issueId: string) => string;
  // Строки в конец репорта: авто-репорт, «сделано с помощью», вход.
  footer?: string[];
};

function escapeReportHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Ссылки в подвале — тоже кликабельные в HTML, остальное экранируем.
function footerLineHtml(line: string): string {
  return escapeReportHtml(line).replace(
    /https?:\/\/[^\s<]+/g,
    (url) => `<a href="${url}">${url}</a>`
  );
}

// Все Telegram-ссылки тикета одним списком: исходное сообщение плюс те,
// что приклеили к нему потом. Дубли отсеиваем — исходная ссылка могла
// попасть и в extraLinks, если тикет пересобирали руками.
export function issueLinks(issue: {
  telegramLink: string | null;
  extraLinks?: string[];
}): string[] {
  const links = [issue.telegramLink, ...(issue.extraLinks ?? [])].filter(
    (link): link is string => Boolean(link)
  );
  return Array.from(new Set(links));
}

export type GroupedIssues<T extends ReportIssue = ReportIssue> = {
  name: string;
  emoji: string | null;
  items: T[];
};

export function groupIssues<T extends ReportIssue>(
  issues: T[],
  presets: ReportGroupPreset[]
): GroupedIssues<T>[] {
  type GroupAcc = {
    emoji: string | null;
    order: number;
    items: T[];
  };

  const groups = new Map<string, GroupAcc>();
  let customIndex = 0;

  for (const issue of issues) {
    let group = groups.get(issue.groupName);
    if (!group) {
      const preset = presets.find((p) => p.name === issue.groupName);
      group = {
        emoji: issue.groupEmoji ?? preset?.emoji ?? null,
        order: preset ? preset.order : 1000 + customIndex++,
        items: [],
      };
      groups.set(issue.groupName, group);
    }
    group.items.push(issue);
  }

  return Array.from(groups.entries())
    .sort((a, b) => a[1].order - b[1].order)
    .map(([name, group]) => ({
      name,
      emoji: group.emoji,
      items: [...group.items].sort((a, b) => a.position - b.position),
    }));
}

function reportSummary(reportable: ReportIssue[], options: ReportOptions): string {
  const html = options.format === "html";
  const esc = (text: string) => html ? escapeReportHtml(text) : text;
  const counts = (items: ReportIssue[]) =>
    (["RESOLVED", "PENDING", "IN_PROGRESS", "NEXT_DAY", "ESCALATED"] as const)
      .map((status) => `${STATUS_META[status].label}: ${items.filter((i) => i.status === status).length}`)
      .join(" · ");
  const title = `📋 Репорт${options.reportDate ? ` за ${options.reportDate}` : ""}`;
  const duty = options.reportDate && !isWeekendDate(options.reportDate)
    ? "Дежурные: Ерош, Алпа"
    : `Дежурный (по активности): ${options.dutyName || "не определён"}`;
  return [
    html ? `<b>${esc(title)}</b>` : title,
    esc(duty),
    esc(`Всего в репорте: ${reportable.length}`),
    esc(counts(reportable)),
  ].join("\n");
}

function renderReportIssue(issue: ReportIssue, index: number, options: ReportOptions): string {
  const html = options.format === "html";
  const esc = (text: string) => html ? escapeReportHtml(text) : text;
  const lines: string[] = [];
  const code = issue.id && options.ticketCode ? `#${options.ticketCode(issue.id)}` : null;
  const url = issue.id && options.ticketUrl ? options.ticketUrl(issue.id) : null;
  const prefix = !code
    ? ""
    : html && url
      ? `<a href="${escapeReportHtml(url)}">${code}</a> `
      : `${code} `;
  lines.push(`${index + 1}. ${prefix}${esc(issue.description)}`);
  for (const link of issueLinks(issue)) {
    lines.push(esc(link));
  }
  const meta = STATUS_META[issue.status];
  const statusEmoji = meta.reportEmoji;
  // Заметка могла остаться от предыдущего статуса; для перенесённого
  // обращения в отчёте за вчера нужна именно формулировка на сегодня.
  const noteText = issue.status === "NEXT_DAY"
    ? meta.defaultNote
    : issue.note?.trim() || meta.defaultNote;
  const ticketPart = issue.ticketLink ? ` ${esc(issue.ticketLink)}` : "";
  lines.push(`Статус: ${esc(noteText)}${ticketPart}${statusEmoji}`);
  return lines.join("\n");
}

export function generateReportText(
  issues: ReportIssue[],
  presets: ReportGroupPreset[],
  options: ReportOptions = {}
): string {
  const html = options.format === "html";
  const esc = (text: string) => (html ? escapeReportHtml(text) : text);
  // "Отправлено" — тикет только что заведён, по нему ещё ничего не
  // происходило, в репорт его выносить рано (иначе там будет пусто "Тикет
  // ашылды" по каждому свежему сообщению). Показываем в репорте только то,
  // что уже реально в работе, пендинге или решено.
  const reportable = issues.filter(isReportableIssue);
  const orderedGroups = groupIssues(reportable, presets);

  const blocks = orderedGroups.map(({ name, emoji, items }) => {
    const header = esc(`${name}${emoji ?? ""}`);
    const lines: string[] = [header, ""];

    items.forEach((issue, idx) => {
      lines.push(renderReportIssue(issue, idx, options), "");
    });

    while (lines[lines.length - 1] === "") {
      lines.pop();
    }

    return lines.join("\n");
  });

  let body = blocks.join(`\n\n${SEPARATOR}\n`);
  if (body && options.compact) {
    const summary = reportSummary(reportable, options);
    body = `${summary}\n\n${html ? `<blockquote expandable>Подробности\n${body}</blockquote>` : `Подробности\n${body}`}`;
  }
  // Пустой репорт подвалом не заполняем — «нечего отправлять» должно
  // оставаться пустым.
  const footer = (options.footer ?? []).filter(Boolean);
  if (!body || footer.length === 0) return body;
  return `${body}\n\n${SEPARATOR}\n${footer.map((l) => (html ? footerLineHtml(l) : l)).join("\n")}`;
}

// Telegram limits the visible text after parsing HTML, not link/tag markup.
export function reportMessageLength(html: string): number {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '\"' };
  return html.replace(/<[^>]*>/g, "").replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot);/gi, (_, entity: string) => {
    if (!entity.startsWith("#")) return entities[entity.toLowerCase()];
    return String.fromCodePoint(entity[1].toLowerCase() === "x"
      ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
  }).length;
}

// Pack whole groups together; split oversized groups only between tickets.
export function generateReportMessages(
  issues: ReportIssue[],
  presets: ReportGroupPreset[],
  options: ReportOptions = {}
): string[] {
  const limit = 3900;
  const htmlOptions: ReportOptions = { ...options, format: "html" };
  const reportable = issues.filter(isReportableIssue);
  if (!reportable.length) return [];
  const parts: string[] = [];
  let prefix = reportSummary(reportable, htmlOptions);
  let sections: string[] = [];
  const render = (heading: string, body: string[], footer = "") => [
    heading,
    body.length ? `<blockquote expandable>${body.join(`\n\n${SEPARATOR}\n`)}</blockquote>` : "",
    footer,
  ].filter(Boolean).join("\n\n");
  const fits = (body: string[]) => reportMessageLength(render(prefix, body)) <= limit;
  const fitsAlone = (section: string) => reportMessageLength(render("", [section])) <= limit;
  const flush = () => {
    if (prefix || sections.length) parts.push(render(prefix, sections));
    prefix = "";
    sections = [];
  };
  for (const { name, emoji, items } of groupIssues(reportable, presets)) {
    const heading = escapeReportHtml(`${name}${emoji ?? ""}`);
    const section = (tickets: string[], continued = false) =>
      `${heading}${continued ? " (продолжение)" : ""}\n\n${tickets.join("\n\n")}`;
    const tickets = items.map((issue, index) => {
      const ticket = renderReportIssue(issue, index, htmlOptions);
      if (fitsAlone(section([ticket], true))) return ticket;
      // A single oversized ticket stays a card with a link to its full text.
      const url = issue.id && options.ticketUrl ? options.ticketUrl(issue.id) : issue.telegramLink;
      if (!url) throw new Error("Oversized report ticket has no full-text link");
      const code = issue.id && options.ticketCode ? `#${options.ticketCode(issue.id)}` : "Полный текст обращения";
      const card = `${index + 1}. <a href="${escapeReportHtml(url)}">${escapeReportHtml(code)}</a>\n${escapeReportHtml(Array.from(issue.description).slice(0, 400).join(""))}…\nПолный текст — по ссылке выше.\nСтатус: ${STATUS_META[issue.status].label}`;
      if (!fitsAlone(section([card], true))) throw new Error("Report ticket card exceeds message limit");
      return card;
    });
    const wholeGroup = section(tickets);
    if (fits([...sections, wholeGroup])) {
      sections.push(wholeGroup);
      continue;
    }
    if (fitsAlone(wholeGroup)) {
      flush();
      sections.push(wholeGroup);
      continue;
    }
    // Start an oversized group fresh, keeping the summary if it is all we have.
    if (sections.length) flush();
    let chunk: string[] = [];
    let continued = false;
    for (const ticket of tickets) {
      if (!fits([section([...chunk, ticket], continued)])) {
        if (chunk.length) {
          sections.push(section(chunk, continued));
          flush();
          chunk = [];
          continued = true;
        } else {
          flush(); // The summary alone left insufficient space for this ticket.
        }
      }
      chunk.push(ticket);
    }
    if (chunk.length) sections.push(section(chunk, continued));
  }
  const footer = (options.footer ?? []).filter(Boolean).map(footerLineHtml).join("\n");
  if (footer && reportMessageLength(render(prefix, sections, footer)) > limit) flush();
  if (footer && reportMessageLength(footer) > limit) throw new Error("Report footer exceeds message limit");
  if (prefix || sections.length || footer) parts.push(render(prefix, sections, footer));
  return parts;
}
