import { homedir } from "node:os";
import { join } from "node:path";

const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const mascotsHome = process.env.MASCOTS_HOME ?? join(claudeHome, "mascots");
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");

export const config = {
  paths: {
    claudeHome,
    /** Registre maintenu par Claude Code : un fichier `<pid>.json` par session vivante. */
    sessionRegistry: join(claudeHome, "sessions"),
    /** Journaux de conversation : `projects/<slug>/<sessionId>.jsonl`. */
    projects: join(claudeHome, "projects"),
    /** Copies par session des données reçues par la barre d'état (écrites par tap/statusline-tap.sh). */
    statuslineSpool: join(mascotsHome, "spool"),
    /** Cache de quota tenu par la barre d'état existante (fallback quand le spool est vide). */
    quotaCacheFile: join(claudeHome, "scripts", "statusline", "data", "usage-limits-cache.json"),
    /** Rollouts Codex : `sessions/AAAA/MM/JJ/rollout-<date>-<uuid>.jsonl`, tenus ouverts tant que la session vit. */
    codexSessions: join(codexHome, "sessions"),
    /** Système de fichiers des processus : sert à trouver quel processus Codex tient quel rollout. */
    proc: "/proc",
    web: new URL("../../web/", import.meta.url).pathname,
    /** Source unique des sprites, partagée avec le firmware. */
    sprites: new URL("../../shared/sprites.json", import.meta.url).pathname,
  },
  http: {
    // Boucle locale uniquement : les chemins de projet et les coûts ne sortent pas de la machine.
    host: "127.0.0.1",
    port: Number(process.env.MASCOTS_PORT ?? 4747),
  },
  serial: {
    baudRate: 115_200,
    /** Motifs testés dans l'ordre ; by-id donne un nom stable quand la carte en fournit un. */
    candidates: ["/dev/serial/by-id", "/dev/ttyACM", "/dev/ttyUSB"],
    scanIntervalMs: 3_000,
    maxSessionsPerFrame: 6,
  },
  timing: {
    tickMs: 1_000,
    /** Balayage de /proc à la recherche des rollouts Codex ouverts (moins souvent que le tick : des milliers de readlink). */
    codexScanIntervalMs: 3_000,
    /** Fenêtre glissante de l'historique de tokens (une case par minute). */
    historyMinutes: 30,
    /** Au-delà, une session « idle » s'endort. */
    sleepAfterMs: 10 * 60_000,
    /** Un snapshot de barre d'état plus vieux que ça n'est plus considéré comme frais pour le quota. */
    quotaStaleMs: 15 * 60_000,
    /** Copies de barre d'état conservées pour les sessions terminées. */
    spoolRetentionMs: 24 * 60 * 60_000,
  },
} as const;
