// Управление отдельным сервисом juz40-vpn-logs (держит корпоративный
// WireGuard-туннель и отдаёт логи из Elasticsearch — см. соседний репозиторий
// juz40-vpn-logs) прямо из Support: старт/стоп трёх контейнеров на VM по SSH.
//
// Зачем это Support-у: WireGuard пускает только ОДИН активный пир на конфиг.
// Пока сервис держит туннель, тот же .conf нельзя одновременно поднять на
// личной машине агента — конфликт роняет соединение до Elasticsearch то тут,
// то там (см. README у juz40-vpn-logs). Кнопка "выключить" временно
// освобождает пира, "включить" — возвращает сервис в строй.
//
// Ходим по SSH (пакет ssh2), а не через HTTP-эндпоинт на самом сервисе: это
// не публичный API уровня приложения, а операция уровня хоста (docker compose
// stop/start), и она должна остаться доступной даже если сам API-контейнер
// сейчас не поднят.

import { Client } from "ssh2";

const CONNECT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;
const REMOTE_DIR = "~/juz40-vpn-logs";
const CONTAINERS = ["juz40-wg", "juz40-vpn-logs-api", "juz40-vpn-logs-caddy"] as const;

export class VpnServiceError extends Error {
  constructor(
    message: string,
    readonly code: "not_configured" | "connect_failed" | "command_failed"
  ) {
    super(message);
    this.name = "VpnServiceError";
  }
}

export function vpnServiceConfigured(): boolean {
  return Boolean(
    process.env.VPN_VM_HOST &&
      process.env.VPN_VM_USER &&
      process.env.VPN_VM_SSH_KEY_B64
  );
}

function privateKey(): string {
  const b64 = process.env.VPN_VM_SSH_KEY_B64;
  if (!b64) throw new VpnServiceError("VPN_VM_SSH_KEY_B64 не задан", "not_configured");
  return Buffer.from(b64, "base64").toString("utf8");
}

type ExecResult = { stdout: string; stderr: string; code: number | null };

function execRemote(command: string): Promise<ExecResult> {
  if (!vpnServiceConfigured()) {
    return Promise.reject(
      new VpnServiceError(
        "VPN_VM_HOST/VPN_VM_USER/VPN_VM_SSH_KEY_B64 не заданы в env",
        "not_configured"
      )
    );
  }

  return new Promise<ExecResult>((resolve, reject) => {
    const conn = new Client();
    const timeout = setTimeout(() => {
      conn.destroy();
      reject(new VpnServiceError("Команда на VM выполнялась слишком долго", "command_failed"));
    }, COMMAND_TIMEOUT_MS);

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timeout);
            conn.end();
            reject(new VpnServiceError(`Не удалось запустить команду: ${err.message}`, "command_failed"));
            return;
          }
          let stdout = "";
          let stderr = "";
          stream
            .on("close", (code: number | null) => {
              clearTimeout(timeout);
              conn.end();
              resolve({ stdout, stderr, code });
            })
            .on("data", (chunk: Buffer) => {
              stdout += chunk.toString("utf8");
            })
            .stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString("utf8");
            });
        });
      })
      .on("error", (err) => {
        clearTimeout(timeout);
        reject(new VpnServiceError(`SSH-подключение к VM не удалось: ${err.message}`, "connect_failed"));
      })
      .connect({
        host: process.env.VPN_VM_HOST,
        username: process.env.VPN_VM_USER,
        privateKey: privateKey(),
        readyTimeout: CONNECT_TIMEOUT_MS,
      });
  });
}

export type VpnServiceStatus = "running" | "stopped" | "partial";

// "partial" — часть контейнеров поднята, часть нет. На практике это
// переходное состояние (сразу после старта/стопа), но лучше показать его
// честно, чем соврать "включено"/"выключено".
export async function getVpnServiceStatus(): Promise<VpnServiceStatus> {
  const { stdout } = await execRemote(
    `docker inspect -f '{{.Name}}={{.State.Running}}' ${CONTAINERS.join(" ")} 2>/dev/null`
  );
  const running = CONTAINERS.filter((name) => stdout.includes(`/${name}=true`)).length;
  if (running === CONTAINERS.length) return "running";
  if (running === 0) return "stopped";
  return "partial";
}

export async function startVpnService(): Promise<void> {
  const { code, stderr } = await execRemote(`cd ${REMOTE_DIR} && docker compose start`);
  if (code !== 0) {
    throw new VpnServiceError(`docker compose start завершился с кодом ${code}: ${stderr.slice(0, 300)}`, "command_failed");
  }
}

export async function stopVpnService(): Promise<void> {
  const { code, stderr } = await execRemote(`cd ${REMOTE_DIR} && docker compose stop`);
  if (code !== 0) {
    throw new VpnServiceError(`docker compose stop завершился с кодом ${code}: ${stderr.slice(0, 300)}`, "command_failed");
  }
}
