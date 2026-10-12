import { STATUS_META, type IssueStatus } from "@/lib/status";

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

const SEPARATOR = "—".repeat(30);

// Как выводить репорт. По умолчанию — простой текст, как раньше (разбор в
// личке, превью). Боссам бот шлёт HTML: номер тикета «#4JQ9PW» перед
// описанием — ссылка на сам тикет на доске, как «Өтініш #…» в постах
// мини-аппа. Ссылки собирает вызывающий (на сервере, по адресу сайта):
// этот файл работает и в браузере, где адреса сайта нет.
export type ReportOptions = {
  format?: "plain" | "html";
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
  const reportable = issues.filter((issue) => issue.status !== "SENT");
  const orderedGroups = groupIssues(reportable, presets);

  const blocks = orderedGroups.map(({ name, emoji, items }) => {
    const header = esc(`${name}${emoji ?? ""}`);
    const lines: string[] = [header, ""];

    items.forEach((issue, idx) => {
      const code = issue.id && options.ticketCode ? `#${options.ticketCode(issue.id)}` : null;
      const url = issue.id && options.ticketUrl ? options.ticketUrl(issue.id) : null;
      const prefix = !code
        ? ""
        : html && url
          ? `<a href="${escapeReportHtml(url)}">${code}</a> `
          : `${code} `;
      lines.push(`${idx + 1}. ${prefix}${esc(issue.description)}`);
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
      lines.push("");
    });

    while (lines[lines.length - 1] === "") {
      lines.pop();
    }

    return lines.join("\n");
  });

  const body = blocks.join(`\n\n${SEPARATOR}\n`);
  // Пустой репорт подвалом не заполняем — «нечего отправлять» должно
  // оставаться пустым.
  const footer = (options.footer ?? []).filter(Boolean);
  if (!body || footer.length === 0) return body;
  return `${body}\n\n${SEPARATOR}\n${footer.map((l) => (html ? footerLineHtml(l) : l)).join("\n")}`;
}
