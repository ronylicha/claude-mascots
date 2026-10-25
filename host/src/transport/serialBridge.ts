import { execFile } from "node:child_process";
import { open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { ReadStream as TtyReadStream } from "node:tty";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Une carte qui n'a pas consommé la trame précédente depuis ce délai est considérée comme bloquée. */
const WRITE_STALL_MS = 5_000;
const STTY_TIMEOUT_MS = 3_000;
/** La carte n'envoie que de courtes lignes de statut : au-delà, c'est du bruit (mauvais débit, autre appareil). */
const MAX_INCOMING_LINE = 4_096;

export interface SerialBridgeOptions {
  baudRate: number;
  candidates: readonly string[];
  scanIntervalMs: number;
  log: (message: string) => void;
}

interface Connection {
  handle: FileHandle;
  stream: Readable;
  path: string;
  writeStartedAt: number | null;
  hello: string | null;
}

/**
 * Pont vers la carte : détecte le premier port série disponible, le configure via `stty`
 * (aucune dépendance native) et y écrit les trames. Se reconnecte seul si on débranche.
 *
 * Les écritures sur le tty passent par le pool de threads de libuv : rien ici n'attend leur fin dans le
 * chemin critique, sinon une carte figée gèlerait tout le démon. Les lectures, elles, ne doivent PAS y
 * passer (voir `openReadStream`).
 */
export class SerialBridge {
  private readonly options: SerialBridgeOptions;
  private connection: Connection | null = null;
  private connecting = false;
  private scanTimer: NodeJS.Timeout | null = null;

  constructor(options: SerialBridgeOptions) {
    this.options = options;
  }

  get status(): { connected: boolean; path: string | null } {
    return { connected: this.connection !== null, path: this.connection?.path ?? null };
  }

  get hello(): string | null {
    return this.connection?.hello ?? null;
  }

  start(): void {
    void this.scan();
    this.scanTimer = setInterval(() => void this.scan(), this.options.scanIntervalMs);
  }

  stop(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.disconnect("arrêt");
  }

  /** Envoi « au mieux » : une trame est abandonnée si la précédente n'est pas encore partie. */
  send(line: string, now: number = Date.now()): void {
    const connection = this.connection;
    if (!connection) return;
    if (connection.writeStartedAt !== null) {
      if (now - connection.writeStartedAt > WRITE_STALL_MS) this.disconnect("la carte ne lit plus", connection);
      return;
    }
    connection.writeStartedAt = now;
    connection.handle.write(line).then(
      () => {
        connection.writeStartedAt = null;
      },
      (error: Error) => this.disconnect(`écriture impossible (${error.message})`, connection),
    );
  }

  private async scan(): Promise<void> {
    if (this.connection || this.connecting) return;
    this.connecting = true;
    try {
      const path = await findSerialPort(this.options.candidates);
      if (path) await this.connect(path);
    } finally {
      this.connecting = false;
    }
  }

  private async connect(path: string): Promise<void> {
    let handle: FileHandle | null = null;
    try {
      // raw : pas de traduction de fin de ligne ; -hupcl : ne pas réinitialiser la carte à la fermeture.
      await execFileAsync("stty", ["-F", path, String(this.options.baudRate), "raw", "-echo", "-hupcl", "clocal"], {
        timeout: STTY_TIMEOUT_MS,
      });
      handle = await open(path, "r+");
      const stream = openReadStream(handle);
      const connection: Connection = { handle, stream, path, writeStartedAt: null, hello: null };
      this.connection = connection;
      this.listen(connection);
      this.options.log(`carte connectée sur ${path}`);
    } catch (error) {
      this.options.log(`port ${path} inutilisable : ${(error as Error).message}`);
      if (handle) void handle.close().catch(() => undefined);
    }
  }

  /** La carte s'annonce par une ligne `HELLO ...` (modèle, résolution) ; le reste est journalisé. */
  private listen(connection: Connection): void {
    let buffer = "";
    connection.stream.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > MAX_INCOMING_LINE) buffer = buffer.slice(-MAX_INCOMING_LINE);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines.filter((value) => value.trim().length > 0)) {
        if (line.startsWith("HELLO")) connection.hello = line.slice(6).trim();
        this.options.log(`carte> ${line.slice(0, 200)}`);
      }
    });
    const lost = (): void => this.disconnect("lecture interrompue (carte débranchée ?)", connection);
    connection.stream.on("error", lost);
    connection.stream.on("end", lost);
  }

  /** `expected` évite qu'un événement tardif de l'ancienne connexion ferme la nouvelle. */
  private disconnect(reason: string, expected?: Connection): void {
    const connection = this.connection;
    if (!connection || (expected && expected !== connection)) return;
    this.connection = null;
    this.options.log(`carte déconnectée de ${connection.path} : ${reason}`);
    connection.stream.destroy();
    // Pas d'await : close() attend la fin d'une lecture bloquée, qui peut ne jamais venir.
    void connection.handle.close().catch(() => undefined);
  }
}

/**
 * Lecture sans fil bloqué : un `fs.read` sur un tty occupe un fil du pool jusqu'à la prochaine donnée, et Node
 * attend ce fil à la sortie du processus — `process.exit` ne rendait jamais la main et systemd tuait le démon
 * au bout de 90 s (vu le 2026-10-25, carte branchée et silencieuse). `tty.ReadStream` rouvre le port en
 * non bloquant et lit par epoll. Un périphérique qui n'est pas un tty garde l'ancienne lecture.
 */
function openReadStream(handle: FileHandle): Readable {
  try {
    return new TtyReadStream(handle.fd);
  } catch {
    return handle.createReadStream({ encoding: "utf8", autoClose: false });
  }
}

/** Parcourt les emplacements candidats ; `/dev/serial/by-id` est un dossier de liens, les autres des préfixes. */
export async function findSerialPort(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (candidate.endsWith("by-id")) {
      const link = await firstEntry(candidate);
      if (link) return realpath(join(candidate, link)).catch(() => null);
      continue;
    }
    const directory = candidate.slice(0, candidate.lastIndexOf("/"));
    const prefix = candidate.slice(candidate.lastIndexOf("/") + 1);
    const match = await firstEntry(directory, (name) => name.startsWith(prefix));
    if (match) return join(directory, match);
  }
  return null;
}

async function firstEntry(directory: string, accept: (name: string) => boolean = () => true): Promise<string | null> {
  try {
    const names = (await readdir(directory)).filter(accept).toSorted();
    return names[0] ?? null;
  } catch {
    return null;
  }
}
