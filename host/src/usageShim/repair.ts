import { serializeSseBlock, SseSplitter } from "./sse.ts";

/**
 * Réparation du champ `usage` des réponses Anthropic quand le serveur amont (proxy) le renseigne mal.
 * Mesuré sur ghostcli.cloud le 2026-10-25 : en streaming, `message_start` annonce `input_tokens: 0`
 * et `message_delta` un `output_tokens` ≈ 10 fois trop petit (653 tokens réels pour 66 annoncés),
 * alors que `/v1/messages/count_tokens` du même proxy compte juste. Claude Code en déduit un
 * contexte à 0 %, un coût faux, ne compacte jamais — et les mascottes affichent des zéros.
 *
 * Règles, volontairement minimales (on ne touche qu'à ce qui est prouvé faux) :
 * - entrée : la valeur annoncée est gardée si elle est > 0, sinon remplacée par le comptage ;
 * - sortie : le maximum de la valeur annoncée et du comptage (le comptage inclut quelques tokens
 *   d'enrobage de message, il ne peut donc pas être inférieur au vrai total).
 */

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [key: string]: unknown;
}

/** Compte les tokens d'une requête (corps au format `count_tokens`) ; null = comptage indisponible. */
export type TokenCounter = (body: Record<string, unknown>) => Promise<number | null>;

/** Champs d'une requête `/v1/messages` que `count_tokens` accepte ; le reste (stream, max_tokens…) est écarté. */
export const COUNTED_REQUEST_FIELDS = ["model", "system", "messages", "tools", "tool_choice", "thinking"] as const;

export function buildCountRequest(request: Record<string, unknown>): Record<string, unknown> {
  const counted: Record<string, unknown> = {};
  for (const field of COUNTED_REQUEST_FIELDS) {
    if (request[field] !== undefined) counted[field] = request[field];
  }
  return counted;
}

/** Bloc de contenu reconstitué à partir des événements `content_block_*` du flux. */
export interface AssembledBlock {
  type: string;
  name?: string;
  id?: string;
  text: string;
}

/**
 * Message assistant à soumettre à `count_tokens` pour mesurer la sortie. La réflexion devient du
 * texte (un bloc `thinking` exige une signature que l'on n'a pas) : même nombre de tokens à l'enrobage près.
 * Un JSON d'outil tronqué (flux interrompu) est compté comme texte plutôt que de faire échouer le comptage.
 */
export function assistantContentForCount(blocks: readonly AssembledBlock[]): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (block.type === "tool_use") {
      const input = parseJsonObject(block.text);
      content.push(input ? { type: "tool_use", id: block.id ?? "toolu_shim", name: block.name ?? "tool", input } : { type: "text", text: block.text });
    } else if (block.text.length > 0) {
      content.push({ type: "text", text: block.text });
    }
  }
  return content;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  // Un `input` vide est sérialisé comme "" dans le flux : c'est l'objet vide.
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Message « témoin » : le comptage de la sortie se fait par différence avec ce seul message. */
export const COUNT_PROBE_MESSAGE = { role: "user", content: "x" } as const;

export function buildOutputCountRequest(model: unknown, blocks: readonly AssembledBlock[]): Record<string, unknown> {
  return { model, messages: [COUNT_PROBE_MESSAGE, { role: "assistant", content: assistantContentForCount(blocks) }] };
}

export function buildBaselineCountRequest(model: unknown): Record<string, unknown> {
  return { model, messages: [COUNT_PROBE_MESSAGE] };
}

export function repairedInput(reported: number | undefined, counted: number | null): number | undefined {
  if (typeof reported === "number" && reported > 0) return reported;
  return counted ?? reported;
}

export function repairedOutput(reported: number | undefined, counted: number | null): number | undefined {
  if (counted === null) return reported;
  return Math.max(reported ?? 0, counted);
}

export interface UsageCounts {
  input: number | null;
  output: number | null;
}

/** Applique les deux règles à un `usage` complet (réponse non streamée ou `message_delta`). */
export function repairUsage(usage: Usage, counts: UsageCounts): Usage {
  const repaired: Usage = { ...usage };
  const input = repairedInput(usage.input_tokens, counts.input);
  if (input !== undefined) repaired.input_tokens = input;
  const output = repairedOutput(usage.output_tokens, counts.output);
  if (output !== undefined) repaired.output_tokens = output;
  return repaired;
}

export interface StreamRepairOptions {
  /** Comptage des tokens d'entrée, lancé dès la réception de la requête. */
  inputCount: Promise<number | null>;
  /** Comptage des tokens de sortie à partir des blocs reconstitués. */
  countOutput: (blocks: readonly AssembledBlock[]) => Promise<number | null>;
  /** Au-delà, l'événement retenu part sans réparation : le flux ne doit jamais rester suspendu. */
  holdMs: number;
}

interface StreamEvent {
  type?: string;
  index?: number;
  message?: { usage?: Usage; [key: string]: unknown };
  content_block?: { type?: string; name?: string; id?: string; text?: string; thinking?: string };
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string };
  usage?: Usage;
  [key: string]: unknown;
}

function withTimeout<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Rejoue un flux SSE en réparant `message_start` et `message_delta` ; tout le reste passe octet pour octet.
 * `message_start` est retenu le temps du comptage d'entrée (en pratique moins que le premier token du
 * modèle), `message_delta` le temps de compter la sortie reconstituée. Les événements suivants
 * gardent leur ordre : on ne produit rien tant qu'un événement est retenu.
 */
export async function* repairSseStream(source: AsyncIterable<string>, options: StreamRepairOptions): AsyncGenerator<string> {
  const splitter = new SseSplitter();
  const blocks = new Map<number, AssembledBlock>();
  // Une promesse non consommée qui rejette ferait tomber le processus : on la neutralise d'emblée.
  const inputCount = options.inputCount.catch(() => null);
  /** Entrée annoncée par `message_start` : si elle est > 0 elle fait foi jusqu'au bout du message. */
  let reportedInput: number | undefined;

  for await (const chunk of source) {
    for (const block of splitter.push(chunk)) {
      const event = parseEvent(block.data);
      if (!event) {
        yield block.raw;
        continue;
      }
      switch (event.type) {
        case "message_start": {
          const usage = event.message?.usage;
          reportedInput = usage?.input_tokens;
          const input = repairedInput(reportedInput, await withTimeout(inputCount, options.holdMs));
          if (event.message && input !== undefined && input !== usage?.input_tokens) {
            event.message.usage = { ...usage, input_tokens: input };
            yield serializeSseBlock("message_start", event);
          } else {
            yield block.raw;
          }
          break;
        }
        case "content_block_start":
          if (typeof event.index === "number" && event.content_block) {
            blocks.set(event.index, {
              type: event.content_block.type ?? "text",
              name: event.content_block.name,
              id: event.content_block.id,
              text: event.content_block.text ?? event.content_block.thinking ?? "",
            });
          }
          yield block.raw;
          break;
        case "content_block_delta": {
          const assembled = typeof event.index === "number" ? blocks.get(event.index) : undefined;
          if (assembled && event.delta) assembled.text += event.delta.text ?? event.delta.partial_json ?? event.delta.thinking ?? "";
          yield block.raw;
          break;
        }
        case "message_delta": {
          const ordered = [...blocks.entries()].toSorted(([a], [b]) => a - b).map(([, value]) => value);
          const [output, countedInput] = await Promise.all([
            withTimeout(options.countOutput(ordered).catch(() => null), options.holdMs),
            withTimeout(inputCount, options.holdMs),
          ]);
          const usage = repairUsage({ input_tokens: reportedInput, ...event.usage }, { input: countedInput, output });
          // L'amont n'a aucune notion de cache : les compteurs manquants valent 0 pour que les clients
          // qui additionnent entrée + cache obtiennent la taille réelle du contexte.
          usage.cache_read_input_tokens ??= 0;
          usage.cache_creation_input_tokens ??= 0;
          yield serializeSseBlock("message_delta", { ...event, usage });
          break;
        }
        default:
          yield block.raw;
      }
    }
  }
  const rest = splitter.flush();
  if (rest.length > 0) yield rest;
}

function parseEvent(data: string | null): StreamEvent | null {
  if (data === null) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as StreamEvent) : null;
  } catch {
    return null;
  }
}

/** Réponse non streamée : même réparation sur l'objet message complet. */
export function repairMessageJson(message: Record<string, unknown>, counts: UsageCounts): Record<string, unknown> {
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null) return message;
  return { ...message, usage: repairUsage(usage as Usage, counts) };
}

/** Blocs d'une réponse non streamée, dans la forme attendue par `assistantContentForCount`. */
export function blocksFromMessageContent(content: unknown): AssembledBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: AssembledBlock[] = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as { type?: string; name?: string; id?: string; text?: string; thinking?: string; input?: unknown };
    const type = block.type ?? "text";
    const text = type === "tool_use" ? JSON.stringify(block.input ?? {}) : (block.text ?? block.thinking ?? "");
    blocks.push({ type, name: block.name, id: block.id, text });
  }
  return blocks;
}
