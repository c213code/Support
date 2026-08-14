import { STATUS_META, type IssueStatus } from "@/lib/status";

export type ReportIssue = {
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
  presets: ReportGroupPreset[]
): string {
  // "Отправлено" — тикет только что заведён, по нему ещё ничего не
  // происходило, в репорт его выносить рано (иначе там будет пусто "Тикет
  // ашылды" по каждому свежему сообщению). Показываем в репорте только то,
  // что уже реально в работе, пендинге или решено.
  const reportable = issues.filter((issue) => issue.status !== "SENT");
  const orderedGroups = groupIssues(reportable, presets);

  const blocks = orderedGroups.map(({ name, emoji, items }) => {
    const header = `${name}${emoji ?? ""}`;
    const lines: string[] = [header, ""];

    items.forEach((issue, idx) => {
      lines.push(`${idx + 1}. ${issue.description}`);
      for (const link of issueLinks(issue)) {
        lines.push(link);
      }
      const meta = STATUS_META[issue.status];
      const statusEmoji = meta.reportEmoji;
      const noteText =
        issue.note && issue.note.trim().length > 0
          ? issue.note.trim()
          : meta.defaultNote;
      const ticketPart = issue.ticketLink ? ` ${issue.ticketLink}` : "";
      lines.push(`Статус: ${noteText}${ticketPart}${statusEmoji}`);
      lines.push("");
    });

    while (lines[lines.length - 1] === "") {
      lines.pop();
    }

    return lines.join("\n");
  });

  return blocks.join(`\n\n${SEPARATOR}\n`);
}

// "Исходный" репорт для команды /raw в Telegram — в отличие от
// generateReportText, не фильтрует SENT: агенту иногда нужно свериться со
// списком целиком, включая только что заведённые тикеты, а не только с
// тем, что уйдёт в готовый текст для боссов.
export function generateRawBoardText(
  issues: ReportIssue[],
  presets: ReportGroupPreset[]
): string {
  const orderedGroups = groupIssues(issues, presets);

  const blocks = orderedGroups.map(({ name, emoji, items }) => {
    const header = `${name}${emoji ?? ""}`;
    const lines: string[] = [header, ""];

    items.forEach((issue, idx) => {
      const meta = STATUS_META[issue.status];
      lines.push(`${idx + 1}. [${meta.emoji} ${meta.label}] ${issue.description}`);
      for (const link of issueLinks(issue)) {
        lines.push(link);
      }
      lines.push("");
    });

    while (lines[lines.length - 1] === "") {
      lines.pop();
    }

    return lines.join("\n");
  });

  return blocks.join(`\n\n${SEPARATOR}\n`);
}
