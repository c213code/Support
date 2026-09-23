export const AGENTS = ["Ерош", "Алпа", "Дежурный"] as const;
export type Agent = (typeof AGENTS)[number];

// Общий аккаунт для выходных/сменных саппортов: под ним можно войти, введя
// своё имя (напр. "Тикош"), которое дальше используется как автор и в
// заметках ("Тикош шешті").
export const SHARED_AGENT: Agent = "Дежурный";

// Логин на странице входа — это имя агента, набранное руками: «ерош»,
// « Ерош », «ЕРОШ» — одно и то же. Сверяем без регистра и пробелов по краям;
// чужое имя — null, и сервер отвечает тем же «Неверный логин или пароль»,
// что и на неверный пароль, чтобы по ответу нельзя было подобрать логины.
export function resolveAgentLogin(input: string): Agent | null {
  const wanted = input.trim().toLocaleLowerCase("ru");
  if (!wanted) return null;
  return AGENTS.find((name) => name.toLocaleLowerCase("ru") === wanted) ?? null;
}
