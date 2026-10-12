// macOS LaunchAgent: start the local worker at login, restart after errors.
// Run with an env file connected to the same Support database as the site.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import pg from "pg";

const LABEL = "kz.juz40.support-feature-agent";
const ROOT = resolve(import.meta.dirname, "..");
const PLIST = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const LOG = join(ROOT, ".local-feature-agent/worker.log");
const DOMAIN = `gui/${process.getuid?.() ?? 0}`;

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function launchctl(...args: string[]) {
  execFileSync("launchctl", args, { stdio: "inherit" });
}

async function main() {
  const command = process.argv[2];
  if (command === "status") {
    launchctl("print", `${DOMAIN}/${LABEL}`);
    return;
  }
  if (command === "stop") {
    if (existsSync(PLIST)) launchctl("bootout", DOMAIN, PLIST);
    return;
  }
  if (command !== "install") throw new Error("Использование: feature-agent-service.ts install <env-file> | status | stop");
  const envFile = resolve(process.argv[3] || "");
  if (!process.argv[3] || !existsSync(envFile)) throw new Error("Укажите существующий env-файл Support");
  const loaded = loadEnv({ path: envFile, override: true, quiet: true });
  if (loaded.error) throw loaded.error;
  if (!loaded.parsed?.DATABASE_URL) throw new Error("В env-файле нет DATABASE_URL");
  const connection = new pg.Client({ connectionString: loaded.parsed.DATABASE_URL,
    connectionTimeoutMillis: 5000 });
  try {
    await connection.connect();
    const check = await connection.query("SELECT to_regclass('public.\"FeatureAgentDraft\"') AS draft_table, to_regclass('public.\"LocalFeatureAgentControl\"') AS control_table");
    if (!check.rows[0]?.draft_table) throw new Error("В базе Support нет миграции FeatureAgentDraft");
    if (!check.rows[0]?.control_table) throw new Error("В базе Support нет миграции LocalFeatureAgentControl");
  } finally {
    await connection.end().catch(() => undefined);
  }
  await mkdir(dirname(PLIST), { recursive: true });
  await mkdir(dirname(LOG), { recursive: true, mode: 0o700 });
  const args = [process.execPath, `--env-file=${envFile}`, "--import", "tsx",
    join(ROOT, "scripts/local-feature-agent.ts"), "watch"];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(ROOT)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(LOG)}</string>
<key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict></plist>\n`;
  if (existsSync(PLIST)) {
    try { launchctl("bootout", DOMAIN, PLIST); } catch { /* not loaded */ }
  }
  await writeFile(PLIST, plist, { mode: 0o600 });
  launchctl("bootstrap", DOMAIN, PLIST);
  process.stdout.write(`Агент запущен. Лог: ${LOG}\n`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
