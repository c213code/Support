import { getFileDownloadUrl } from "@/lib/telegram";
import type { JiraPriority } from "@/lib/ai";

// Баг в Jira из тикета поддержки (кнопка «🐞 Баг в Jira» в окне «Передать»).
//
// Шаблон — тот, которым баги заводят руками (DV-7648): заголовок
// «[BUG][BACK] …», в описании «Описание проблемы», «Фактический результат»,
// «Ожидаемый результат» и ссылка на сообщение в Telegram; скриншоты
// куратора — вложениями. Баг без родителя (на доске — дорожка «No
// Sub-task», «остальное») и сразу в активный спринт: в бэклоге его на доске
// не увидят.
//
// Доступ — API-токен человека, от чьего имени заводятся баги (он же
// Reporter): JIRA_EMAIL + JIRA_API_TOKEN. JIRA_BASE_URL — для тестов на
// локальной заглушке, в проде не задаётся.

const DEFAULT_BASE = "https://juz.atlassian.net";
const DEFAULT_PROJECT = "DV";
const JIRA_TIMEOUT_MS = 15_000;
const FILE_TIMEOUT_MS = 10_000;

function base(): string {
  return (process.env.JIRA_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
}

export function jiraProject(): string {
  return process.env.JIRA_PROJECT_KEY?.trim() || DEFAULT_PROJECT;
}

export function jiraConfigured(): boolean {
  return Boolean(process.env.JIRA_EMAIL?.trim() && process.env.JIRA_API_TOKEN?.trim());
}

export function jiraIssueUrl(key: string): string {
  return `${base()}/browse/${key}`;
}

function authHeader(): string {
  const raw = `${process.env.JIRA_EMAIL?.trim()}:${process.env.JIRA_API_TOKEN?.trim()}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

export class JiraError extends Error {}

// Ответ Jira об ошибке — человеку на экран: «Field 'assignee' cannot be set»
// понятнее, чем «не получилось». Токен в ошибки не попадает: он только в
// заголовке запроса.
async function jiraFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      ...init,
      headers: {
        Authorization: authHeader(),
        Accept: "application/json",
        ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
    });
  } catch (err) {
    throw new JiraError(`Jira не ответила: ${err instanceof Error ? err.name : "ошибка сети"}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const body = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
      detail = [...(body.errorMessages ?? []), ...Object.entries(body.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join("; ") || detail;
    } catch {}
    throw new JiraError(`Jira ответила ${res.status}: ${detail}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export type JiraUser = { accountId: string; displayName: string };

// Кому в проекте можно назначить задачу — список для выбора исполнителя.
export async function assignableUsers(): Promise<JiraUser[]> {
  const users = await jiraFetch<Array<{ accountId: string; displayName: string; active?: boolean; accountType?: string }>>(
    `/rest/api/3/user/assignable/search?project=${encodeURIComponent(jiraProject())}&maxResults=200`
  );
  return users
    .filter((u) => u.active !== false && u.accountType !== "app")
    .map(({ accountId, displayName }) => ({ accountId, displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// Активный спринт доски проекта. Досок может быть несколько — берём первую
// scrum-доску с активным спринтом; JIRA_BOARD_ID — если угадывать не надо.
async function activeSprint(): Promise<{ id: number; name: string } | null> {
  const boardId = process.env.JIRA_BOARD_ID?.trim();
  const boards = boardId
    ? [{ id: Number(boardId) }]
    : (
        await jiraFetch<{ values: Array<{ id: number; type: string }> }>(
          `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(jiraProject())}&type=scrum`
        )
      ).values;
  for (const board of boards) {
    const sprints = await jiraFetch<{ values: Array<{ id: number; name: string }> }>(
      `/rest/agile/1.0/board/${board.id}/sprint?state=active`
    );
    if (sprints.values[0]) return sprints.values[0];
  }
  return null;
}

type AdfNode = Record<string, unknown>;
const textNode = (text: string, strong = false): AdfNode =>
  strong ? { type: "text", text, marks: [{ type: "strong" }] } : { type: "text", text };
const paragraph = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });

// Секция «Заголовок: текст». Многострочный текст — абзацами, иначе Jira
// склеит строки в одну.
function section(title: string, body: string): AdfNode[] {
  const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  return [
    paragraph(textNode(`${title} `, true), textNode(lines[0])),
    ...lines.slice(1).map((l) => paragraph(textNode(l))),
  ];
}

export type JiraBugFields = {
  summary: string;
  component: string;
  problem: string;
  steps: string[];
  actual: string;
  expected: string;
  priority: JiraPriority;
  telegramLink: string | null;
};

// Названия приоритетов в Jira (стандартная схема). Не та схема в проекте —
// баг всё равно заведётся, с Medium (см. createJiraBug).
const PRIORITY_NAME: Record<JiraPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Highest",
};

function stepsList(steps: string[]): AdfNode[] {
  const items = steps.map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return [];
  return [
    paragraph(textNode("Шаги воспроизведения:", true)),
    {
      type: "orderedList",
      content: items.map((item) => ({ type: "listItem", content: [paragraph(textNode(item))] })),
    },
  ];
}

export function bugDescription(f: JiraBugFields): AdfNode {
  const content: AdfNode[] = [
    ...section("Компонент:", f.component),
    ...section("Описание проблемы:", f.problem),
    ...stepsList(f.steps),
    ...section("Фактический результат:", f.actual),
    ...section("Ожидаемый результат:", f.expected),
  ];
  if (f.telegramLink) {
    content.push(
      paragraph({ type: "text", text: f.telegramLink, marks: [{ type: "link", attrs: { href: f.telegramLink } }] })
    );
  }
  return { version: 1, type: "doc", content };
}

async function attachTelegramPhoto(key: string, fileId: string, index: number): Promise<boolean> {
  const url = await getFileDownloadUrl(fileId);
  if (!url) return false;
  try {
    const file = await fetch(url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
    if (!file.ok) return false;
    const form = new FormData();
    form.append("file", new Blob([await file.arrayBuffer()], { type: "image/jpeg" }), `screenshot-${index + 1}.jpg`);
    await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, {
      method: "POST",
      body: form,
      headers: { "X-Atlassian-Token": "no-check" },
    });
    return true;
  } catch (err) {
    console.warn(`[jira] скриншот ${index + 1} не приложился к ${key}: ${String(err).slice(0, 200)}`);
    return false;
  }
}

export type CreatedBug = {
  key: string;
  url: string;
  sprint: string | null;
  attached: number;
  // Что не вышло, но баг уже создан: спринт, часть скриншотов.
  warnings: string[];
};

export async function createJiraBug(params: {
  fields: JiraBugFields;
  assigneeAccountId: string | null;
  photoFileIds: string[];
}): Promise<CreatedBug> {
  const create = (priority: string) =>
    jiraFetch<{ key: string }>("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({
        fields: {
          project: { key: jiraProject() },
          issuetype: { name: "Bug" },
          summary: params.fields.summary.slice(0, 250),
          description: bugDescription(params.fields),
          priority: { name: priority },
          ...(params.assigneeAccountId ? { assignee: { accountId: params.assigneeAccountId } } : {}),
        },
      }),
    });

  const warnings: string[] = [];
  const wanted = PRIORITY_NAME[params.fields.priority] ?? "Medium";
  let created: { key: string };
  try {
    created = await create(wanted);
  } catch (err) {
    // В проекте своя схема приоритетов — заводим с Medium, как раньше, и
    // говорим об этом, а не теряем баг.
    if (wanted === "Medium" || !(err instanceof JiraError) || !/priority/i.test(err.message)) throw err;
    created = await create("Medium");
    warnings.push(`приоритет «${wanted}» Jira не приняла — поставлен Medium`);
  }

  let sprint: string | null = null;
  try {
    const active = await activeSprint();
    if (active) {
      await jiraFetch(`/rest/agile/1.0/sprint/${active.id}/issue`, {
        method: "POST",
        body: JSON.stringify({ issues: [created.key] }),
      });
      sprint = active.name;
    } else {
      warnings.push("активного спринта нет — баг в бэклоге");
    }
  } catch (err) {
    warnings.push(`в спринт не добавился: ${err instanceof Error ? err.message : "ошибка"}`);
  }

  let attached = 0;
  for (const [index, fileId] of params.photoFileIds.entries()) {
    if (await attachTelegramPhoto(created.key, fileId, index)) attached++;
  }
  if (attached < params.photoFileIds.length) {
    warnings.push(`приложено скриншотов ${attached} из ${params.photoFileIds.length}`);
  }

  return { key: created.key, url: jiraIssueUrl(created.key), sprint, attached, warnings };
}
