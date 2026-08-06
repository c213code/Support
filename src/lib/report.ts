import { STATUS_META, type IssueStatus } from "@/lib/status";

export type ReportIssue = {
  groupName: string;
  groupEmoji: string | null;
  position: number;
  description: string;
  telegramLink: string | null;
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
  const orderedGroups = groupIssues(issues, presets);

  const blocks = orderedGroups.map(({ name, emoji, items }) => {
    const header = `${name}${emoji ?? ""}`;
    const lines: string[] = [header, ""];

    items.forEach((issue, idx) => {
      lines.push(`${idx + 1}. ${issue.description}`);
      if (issue.telegramLink) {
        lines.push(issue.telegramLink);
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
