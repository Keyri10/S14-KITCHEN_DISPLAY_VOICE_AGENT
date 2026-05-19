import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { createAgent, AIMessage, ToolMessage } from "langchain";
import path from "node:path";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext } from "hono/ws";
import type WebSocket from "ws";
import { iife, writableIterator } from "./utils";
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { CARTESIA_TTS_SYSTEM_PROMPT, CartesiaTTS } from "./cartesia";
import { AssemblyAISTT } from "./assemblyai/index";
import type { VoiceAgentEvent } from "./types";
import {
  addToCart,
  confirmOrder as confirmKitchenOrder,
  getActiveVoiceSessionId,
  listActiveKitchenOrders,
  listKitchenOrders,
  setActiveVoiceSessionId,
  updateOrderStatus,
} from "./kitchen/store";
import { kitchenHub } from "./kitchen/hub";
import type { KitchenOrderStatus } from "./kitchen/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const STATIC_DIR = path.join(__dirname, "../../web/dist");
const INDEX_HTML_PATH = path.join(STATIC_DIR, "index.html");
const PORT = parseInt(process.env.PORT ?? "8000");

/** SPA routes (e.g. /kitchen) — serveStatic alone returns 404 for non-file paths. */
const spaIndexHtml = readFileSync(INDEX_HTML_PATH, "utf-8");
function serveSpa(c: Context) {
  return c.html(spaIndexHtml);
}

// .env lives at project root (next to .env.example); also allow components/typescript/.env
config({ path: path.join(PROJECT_ROOT, ".env") });
config({ path: path.join(__dirname, "../.env") });

const REQUIRED_ENV = [
  "ASSEMBLYAI_API_KEY",
  "CARTESIA_API_KEY",
  "OPENAI_API_KEY",
] as const;

function isEnvConfigured(value: string | undefined): boolean {
  const v = value?.trim();
  if (!v) return false;
  // Reject .env.example placeholders (..., sk-..., sk-ant-...)
  if (/\.{3}$/.test(v) || v === "..." || /^sk(-ant)?-\.\.\.$/.test(v)) return false;
  return true;
}

const missingEnv = REQUIRED_ENV.filter((key) => !isEnvConfigured(process.env[key]));
if (missingEnv.length > 0) {
  console.error(
    `Missing or placeholder API keys: ${missingEnv.join(", ")}\n\n` +
      `Edit ${path.join(PROJECT_ROOT, ".env")} and set real keys from:\n` +
      `  - AssemblyAI: https://www.assemblyai.com\n` +
      `  - Cartesia:   https://cartesia.ai\n` +
      `  - OpenAI:     https://platform.openai.com\n\n` +
      `Then restart: pnpm run server`
  );
  process.exit(1);
}

if (!existsSync(STATIC_DIR)) {
  console.error(
    `Web build not found at ${STATIC_DIR}.\n` +
      "Run 'make build-web' or 'make dev-ts' from the project root."
  );
  process.exit(1);
}

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use("/*", cors());

const addToOrder = tool(
  async ({ item, quantity }) => {
    const sessionId = getActiveVoiceSessionId();
    if (!sessionId) {
      return "No hay sesión de voz activa.";
    }
    addToCart(sessionId, item, quantity);
    return `Se añadieron ${quantity} x ${item} al pedido.`;
  },
  {
    name: "add_to_order",
    description: "Añade un artículo al pedido de sándwiches del cliente.",
    schema: z.object({
      item: z.string(),
      quantity: z.number(),
    }),
  }
);

const confirmOrder = tool(
  async ({ orderSummary }) => {
    const sessionId = getActiveVoiceSessionId();
    if (!sessionId) {
      return "No hay sesión de voz activa.";
    }
    const order = confirmKitchenOrder(sessionId, orderSummary);
    if (!order) {
      return "No hay ítems en el pedido para confirmar.";
    }
    kitchenHub.notifyNewOrder(order);
    return `Pedido confirmado: ${order.summary}. Número ${order.shortId}. Enviando a cocina.`;
  },
  {
    name: "confirm_order",
    description:
      "Confirma el pedido final con el cliente y lo envía a cocina. Usar solo cuando el cliente acepte.",
    schema: z.object({
      orderSummary: z.string().describe("Resumen del pedido"),
    }),
  }
);

const systemPrompt = `
Eres un asistente amable de una sandwichería. Tu objetivo es tomar el pedido del cliente.
Responde SIEMPRE en español, con frases cortas y naturales para voz.
Cuando el cliente confirme, usa confirm_order para enviar el pedido a cocina.

Ingredientes disponibles: lechuga, tomate, cebolla, pepinillos, mayonesa, mostaza.
Carnes: pavo, jamón, roast beef.
Quesos: suizo, cheddar, provolone.

${CARTESIA_TTS_SYSTEM_PROMPT}
`;

const agent = createAgent({
  model: "gpt-4o-mini",
  tools: [addToOrder, confirmOrder],
  checkpointer: new MemorySaver(),
  systemPrompt: systemPrompt,
});

/**
 * Transform stream: Audio (Uint8Array) → Voice Events (VoiceAgentEvent)
 *
 * This function takes a stream of audio chunks and sends them to AssemblyAI for STT.
 *
 * It uses a producer-consumer pattern where:
 * - Producer: Reads audio chunks from audioStream and sends them to AssemblyAI
 * - Consumer: Receives transcription events from AssemblyAI and yields them
 *
 * @param audioStream - Async iterator of PCM audio bytes (16-bit, mono, 16kHz)
 * @returns Async generator yielding STT events (stt_chunk for partials, stt_output for final transcripts)
 */
async function* sttStream(
  audioStream: AsyncIterable<Uint8Array>
): AsyncGenerator<VoiceAgentEvent> {
  const stt = new AssemblyAISTT({ sampleRate: 16000 });
  const passthrough = writableIterator<VoiceAgentEvent>();

  /**
   * Promise that pumps audio chunks to AssemblyAI.
   *
   * This runs concurrently with the consumer, continuously reading audio
   * chunks from the input stream and forwarding them to AssemblyAI.
   * This allows transcription to begin before all audio has arrived.
   */
  const producer = iife(async () => {
    try {
      // Stream each audio chunk to AssemblyAI as it arrives
      for await (const audioChunk of audioStream) {
        await stt.sendAudio(audioChunk);
      }
    } finally {
      // Signal to AssemblyAI that audio streaming is complete
      await stt.close();
    }
  });

  /**
   * Promise that receives transcription events from AssemblyAI.
   *
   * This runs concurrently with the producer, listening for STT events
   * and pushing them into the passthrough iterator for downstream stages.
   */
  const consumer = iife(async () => {
    for await (const event of stt.receiveEvents()) {
      passthrough.push(event);
    }
  });

  try {
    // Yield events as they arrive from the consumer
    yield* passthrough;
  } finally {
    // Wait for the producer and consumer to complete when cleaning up
    await Promise.all([producer, consumer]);
  }
}

/**
 * Transform stream: Voice Events → Voice Events (with Agent Responses)
 *
 * This function takes a stream of upstream voice agent events and processes them.
 * When an stt_output event arrives, it passes the transcript to the LangChain agent.
 * The agent streams back its response tokens as agent_chunk events.
 * Tool calls and results are also emitted as separate events.
 * All other upstream events are passed through unchanged.
 *
 * @param eventStream - An async iterator of upstream voice agent events
 * @returns Async generator yielding all upstream events plus agent_chunk, tool_call, and tool_result events
 */
async function* agentStream(
  eventStream: AsyncIterable<VoiceAgentEvent>,
  threadId: string
): AsyncGenerator<VoiceAgentEvent> {

  for await (const event of eventStream) {
    yield event;
    if (event.type === "stt_output") {
      let stream;
      try {
        stream = await agent.stream(
          { messages: [new HumanMessage(event.transcript)] },
          {
            configurable: { thread_id: threadId },
            streamMode: "messages",
          }
        );
      } catch (err) {
        console.error("Agent stream failed:", err);
        yield { type: "agent_end", ts: Date.now() };
        continue;
      }

      let spokenBuffer = "";
      for await (const [message] of stream) {
        if (AIMessage.isInstance(message)) {
          // Preserve leading spaces on streaming tokens (" un", " sándwich").
          const text = message.text ?? "";
          if (text) {
            spokenBuffer += text;
            yield { type: "agent_chunk", text, ts: Date.now() };
          }
          if (message.tool_calls?.length) {
            for (const toolCall of message.tool_calls) {
              yield {
                type: "tool_call",
                id: toolCall.id ?? uuidv4(),
                name: toolCall.name,
                args: toolCall.args,
                ts: Date.now(),
              };
            }
          }
        }
        if (ToolMessage.isInstance(message)) {
          yield {
            type: "tool_result",
            toolCallId: message.tool_call_id ?? "",
            name: message.name ?? "unknown",
            result:
              typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content),
            ts: Date.now(),
          };
        }
      }

      yield { type: "agent_end", ts: Date.now(), text: spokenBuffer };
    }
  }
}

/**
 * Transform stream: Voice Events → Voice Events (with Audio)
 *
 * This function takes a stream of upstream voice agent events and processes them.
 * When agent_chunk events arrive, it sends the text to ElevenLabs for TTS synthesis.
 * Audio is streamed back as tts_chunk events as it's generated.
 * All upstream events are passed through unchanged.
 *
 * It uses a producer-consumer pattern where:
 * - Producer: Reads events from eventStream, passes them through, and sends agent text to ElevenLabs
 * - Consumer: Receives audio chunks from ElevenLabs and yields them as tts_chunk events
 *
 * @param eventStream - An async iterator of upstream voice agent events
 * @returns Async generator yielding all upstream events plus tts_chunk events for synthesized audio
 */
async function* ttsStream(
  eventStream: AsyncIterable<VoiceAgentEvent>
): AsyncGenerator<VoiceAgentEvent> {
  const tts = new CartesiaTTS();
  const passthrough = writableIterator<VoiceAgentEvent>();

  /**
   * Promise that reads events from the upstream stream and sends text to Cartesia.
   *
   * This runs concurrently with the consumer, continuously reading events
   * from the upstream stream and forwarding agent text to Cartesia for synthesis.
   * All events are passed through to the downstream via the passthrough iterator.
   * This allows audio generation to begin before the agent has finished generating.
   */
  const producer = iife(async () => {
    try {
      for await (const event of eventStream) {
        passthrough.push(event);
        if (event.type === "agent_end") {
          const toSpeak =
            event.text?.trim() ||
            "";
          if (toSpeak) {
            await tts.sendText(toSpeak);
          }
        }
      }
    } finally {
      // Signal to Cartesia that text sending is complete
      await tts.close();
    }
  });

  /**
   * Promise that receives audio events from Cartesia.
   *
   * This runs concurrently with the producer, listening for TTS audio chunks
   * and pushing them into the passthrough iterator for downstream stages.
   */
  const consumer = iife(async () => {
    for await (const event of tts.receiveEvents()) {
      passthrough.push(event);
    }
  });

  try {
    // Yield events as they arrive from both producer (upstream) and consumer (TTS)
    yield* passthrough;
  } finally {
    // Wait for the producer and consumer to complete when cleaning up
    await Promise.all([producer, consumer]);
  }
}

const KITCHEN_STATUSES: KitchenOrderStatus[] = ["nuevo", "en_preparacion", "listo"];

app.get("/api/kitchen/orders", (c) => {
  const activeOnly = c.req.query("active") !== "false";
  return c.json(activeOnly ? listActiveKitchenOrders() : listKitchenOrders());
});

app.patch("/api/kitchen/orders/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ status?: KitchenOrderStatus }>();
  if (!body.status || !KITCHEN_STATUSES.includes(body.status)) {
    return c.json({ error: "status must be nuevo | en_preparacion | listo" }, 400);
  }
  const order = updateOrderStatus(id, body.status);
  if (!order) {
    return c.json({ error: "Order not found" }, 404);
  }
  kitchenHub.notifyOrderUpdated(order);
  return c.json(order);
});

app.get(
  "/ws/kitchen",
  upgradeWebSocket(() => {
    let socket: import("./kitchen/hub").KitchenSocket | undefined;

    return {
      onOpen(_event, ws) {
        socket = {
          send: (data) => ws.send(data),
          get readyState() {
            return ws.readyState;
          },
        };
        kitchenHub.add(socket);
      },
      onClose() {
        if (socket) kitchenHub.remove(socket);
      },
    };
  })
);

app.get("/kitchen", serveSpa);
app.get("/kitchen/", serveSpa);

app.get("/*", serveStatic({ root: STATIC_DIR }));

app.notFound((c) => {
  const pathname = new URL(c.req.url).pathname;
  if (pathname.startsWith("/api") || pathname.startsWith("/ws")) {
    return c.text("Not Found", 404);
  }
  if (c.req.method === "GET" && existsSync(INDEX_HTML_PATH)) {
    return c.html(readFileSync(INDEX_HTML_PATH, "utf-8"));
  }
  return c.text("Not Found", 404);
});

app.get(
  "/ws",
  upgradeWebSocket(async () => {
    let currentSocket: WSContext<WebSocket> | undefined;
    const sessionId = uuidv4();

    const inputStream = writableIterator<Uint8Array>();

    const transcriptEventStream = sttStream(inputStream);
    const agentEventStream = agentStream(transcriptEventStream, sessionId);
    const outputEventStream = ttsStream(agentEventStream);

    const flushPromise = iife(async () => {
      for await (const event of outputEventStream) {
        currentSocket?.send(JSON.stringify(event));
      }
    });

    return {
      onOpen(_, ws) {
        currentSocket = ws;
        setActiveVoiceSessionId(sessionId);
      },
      onMessage(event) {
        const data = event.data;
        if (Buffer.isBuffer(data)) {
          inputStream.push(new Uint8Array(data));
        } else if (data instanceof ArrayBuffer) {
          inputStream.push(new Uint8Array(data));
        }
      },
      async onClose() {
        inputStream.cancel();
        setActiveVoiceSessionId(null);
        await flushPromise;
      },
    };
  })
);

const server = serve({
  fetch: app.fetch,
  port: PORT,
});

injectWebSocket(server);

console.log(`Server is running on port ${PORT}`);
console.log(`Kitchen display: http://localhost:${PORT}/kitchen`);
