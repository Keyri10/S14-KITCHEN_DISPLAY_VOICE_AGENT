import asyncio
import contextlib
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator, Literal
from uuid import uuid4

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from langchain.agents import create_agent
from langchain.messages import AIMessage, HumanMessage, ToolMessage
from langchain.tools import ToolRuntime, tool
from langchain_core.runnables import RunnableGenerator
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import BaseModel, Field
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnect

import restaurant_db
import kitchen_hub
from assemblyai_stt import AssemblyAISTT
from cartesia_prompts import CARTESIA_TTS_SYSTEM_PROMPT
from cartesia_tts import CartesiaTTS
from events import (
    AgentChunkEvent,
    AgentEndEvent,
    ToolCallEvent,
    ToolResultEvent,
    VoiceAgentEvent,
    event_to_dict,
)
from utils import merge_async_iters

load_dotenv()

# Static files are served from the shared web build output
STATIC_DIR = Path(__file__).parent.parent.parent / "web" / "dist"

if not STATIC_DIR.exists():
    raise RuntimeError(
        f"Web build not found at {STATIC_DIR}. "
        "Run 'make build-web' or 'make dev-py' from the project root."
    )


_main_loop: asyncio.AbstractEventLoop | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _main_loop
    restaurant_db.bootstrap_db()
    _main_loop = asyncio.get_running_loop()
    yield
    _main_loop = None


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@dataclass
class VoiceSessionContext:
    """Per-WebSocket session id; matches LangGraph checkpointer thread_id."""

    thread_id: str


@tool
def get_menu_stock(runtime: ToolRuntime[VoiceSessionContext]) -> str:
    """Lista productos en stock (id y nombre). Usa antes de add_to_cart."""
    with restaurant_db.db_session() as conn:
        items = restaurant_db.list_available_products(conn)
        if not items:
            return restaurant_db.format_error_tool_result(
                "No hay productos disponibles en este momento."
            )
        preview = ", ".join(f"{p['name']} ({p['id']})" for p in items[:10])
        msg = f"Hay {len(items)} artículos en menú. Algunos: {preview}."
        return restaurant_db.format_menu_tool_result(conn, msg)


@tool
def add_to_cart(
    product_id: str,
    quantity: int,
    runtime: ToolRuntime[VoiceSessionContext],
) -> str:
    """Añade al carrito; product_id debe coincidir con get_menu_stock."""
    with restaurant_db.db_session() as conn:
        sid = runtime.context.thread_id
        res = restaurant_db.add_cart_line(conn, sid, product_id, quantity)
        if not res["ok"]:
            return restaurant_db.format_error_tool_result(res["error"])
        msg = f"Listo, agregué {quantity} al pedido."
        return restaurant_db.format_cart_tool_result(conn, sid, msg)


@tool
def get_cart(runtime: ToolRuntime[VoiceSessionContext]) -> str:
    """Devuelve el carrito actual con cantidades y total."""
    with restaurant_db.db_session() as conn:
        sid = runtime.context.thread_id
        view = restaurant_db.get_cart_view(conn, sid)
        if not view["lines"]:
            msg = "El carrito está vacío."
            return restaurant_db.format_cart_tool_result(conn, sid, msg)
        parts = [
            f"{line['quantity']} x {line['name']}" for line in view["lines"]
        ]
        euros = view["total_cents"] / 100
        msg = (
            f"Carrito: {', '.join(parts)}. "
            f"Total aproximado {euros:.2f} euros."
        )
        return restaurant_db.format_cart_tool_result(conn, sid, msg)


@tool
def confirm_order(runtime: ToolRuntime[VoiceSessionContext]) -> str:
    """Confirma pedido y descuenta stock; solo si el cliente aceptó."""
    with restaurant_db.db_session() as conn:
        sid = runtime.context.thread_id
        res = restaurant_db.confirm_order_transaction(conn, sid)
        if not res["ok"]:
            return restaurant_db.format_error_tool_result(res["error"])
        oid = res["order_id"]
        order = restaurant_db._order_to_kitchen(conn, oid)
        if order and _main_loop is not None:
            asyncio.run_coroutine_threadsafe(
                kitchen_hub.notify_new_order(order), _main_loop
            )
        msg = (
            f"Pedido confirmado. Número de orden <spell>{oid}</spell>. "
            f"Resumen: {res['summary']}."
        )
        return restaurant_db.format_order_tool_result(
            oid, res["summary"], res["total_cents"], msg
        )


system_prompt = f"""
Tu eres el asistente de voz de un restaurante de sandwiches.
Objetivo: tomar el pedido y confirmarlo.
Sé muy breve y natural en español.

Reglas del menú y herramientas:
- No inventes productos. Usa get_menu_stock si no sabes qué hay o antes de agregar.
- add_to_cart necesita el product_id exacto del menú (ej. meat-turkey), sin punto final.
- Usa get_cart antes de confirmar.
- confirm_order solo si el cliente confirma enviar el pedido.

Español para síntesis de voz (TTS):
- Habla como en una conversación real: usa artículos correctos delante del nombre.
  Di "un pan con pollo" o "una porción de pavo", no "uno pan" ni "una pan".
- Evita empezar la frase con el dígito cuando suene raro (mal "1 pan"); di "un pan",
  "dos sandwiches", "tres ingredientes".
- Para cantidades pequeñas prefiero palabras ("dos", "tres") antes que "2", "3"
  en la respuesta al cliente.
- Resume el pedido con nombres de producto del menú, no solo códigos internos.

{CARTESIA_TTS_SYSTEM_PROMPT}
"""

agent = create_agent(
    model="openai:gpt-5.2",
    tools=[get_menu_stock, add_to_cart, get_cart, confirm_order],
    system_prompt=system_prompt,
    checkpointer=InMemorySaver(),
    context_schema=VoiceSessionContext,
)


async def _stt_stream(
    audio_stream: AsyncIterator[bytes],
) -> AsyncIterator[VoiceAgentEvent]:
    """
    Transform stream: Audio (Bytes) → Voice Events (VoiceAgentEvent)

    This function takes a stream of audio chunks and sends them to AssemblyAI for STT.

    It uses a producer-consumer pattern where:
    - Producer: A background task reads audio chunks from audio_stream and sends
      them to AssemblyAI via WebSocket. This runs concurrently with the consumer,
      allowing transcription to begin before all audio has arrived.
    - Consumer: The main coroutine receives transcription events from AssemblyAI
      and yields them downstream. Events include both partial results (stt_chunk)
      and final transcripts (stt_output).

    Args:
        audio_stream: Async iterator of PCM audio bytes (16-bit, mono, 16kHz)

    Yields:
        STT events (stt_chunk for partials, stt_output for final transcripts)
    """
    stt = AssemblyAISTT(sample_rate=16000)

    async def send_audio():
        """
        Background task that pumps audio chunks to AssemblyAI.

        This runs concurrently with the main coroutine, continuously reading
        audio chunks from the input stream and forwarding them to AssemblyAI.
        When the input stream ends, it signals completion by closing the
        WebSocket connection.
        """
        try:
            # Stream each audio chunk to AssemblyAI as it arrives
            async for audio_chunk in audio_stream:
                await stt.send_audio(audio_chunk)
        finally:
            # Signal to AssemblyAI that audio streaming is complete
            await stt.close()

    # Launch the audio sending task in the background
    # This allows us to simultaneously receive transcripts in the main coroutine
    send_task = asyncio.create_task(send_audio())

    try:
        # Consumer loop: receive and yield transcription events as they arrive
        # from AssemblyAI. The receive_events() method listens on the WebSocket
        # for transcript events and yields them as they become available.
        async for event in stt.receive_events():
            yield event
    finally:
        # Cleanup: ensure the background task is cancelled and awaited
        with contextlib.suppress(asyncio.CancelledError):
            send_task.cancel()
            await send_task
        # Ensure the WebSocket connection is closed
        await stt.close()


async def _agent_stream(
    event_stream: AsyncIterator[VoiceAgentEvent],
) -> AsyncIterator[VoiceAgentEvent]:
    """
    Transform stream: Voice Events → Voice Events (with Agent Responses)

    This function takes a stream of upstream voice agent events and processes them.
    When an stt_output event arrives, it passes the transcript to the LangChain agent.
    The agent streams back its response tokens as agent_chunk events.
    Tool calls and results are also emitted as separate events.
    All other upstream events are passed through unchanged.

    The passthrough pattern ensures downstream stages (like TTS) can observe all
    events in the pipeline, not just the ones this stage produces. This enables
    features like displaying partial transcripts while the agent is thinking.

    Args:
        event_stream: An async iterator of upstream voice agent events

    Yields:
        All upstream events plus agent_chunk, tool_call, and tool_result events
    """
    # Generate a unique thread ID for this conversation session
    # This allows the agent to maintain conversation context across multiple turns
    # using the checkpointer (InMemorySaver) configured in the agent
    thread_id = str(uuid4())
    voice_ctx = VoiceSessionContext(thread_id=thread_id)

    # Process each event as it arrives from the upstream STT stage
    async for event in event_stream:
        # Pass through all events to downstream consumers
        yield event

        # When we receive a final transcript, invoke the agent
        if event.type == "stt_output":
            # Stream the agent's response using LangChain's astream method.
            # stream_mode="messages" yields message chunks as they're generated.
            stream = agent.astream(
                {"messages": [HumanMessage(content=event.transcript)]},
                {"configurable": {"thread_id": thread_id}},
                stream_mode="messages",
                context=voice_ctx,
            )

            # Iterate through the agent's streaming response. The stream yields
            # tuples of (message, metadata), but we only need the message.
            async for message, metadata in stream:
                # Emit agent chunks (AI messages)
                if isinstance(message, AIMessage):
                    # Extract and yield the text content from each message chunk
                    yield AgentChunkEvent.create(message.text)
                    # Emit tool calls if present
                    if hasattr(message, "tool_calls") and message.tool_calls:
                        for tool_call in message.tool_calls:
                            yield ToolCallEvent.create(
                                id=tool_call.get("id", str(uuid4())),
                                name=tool_call.get("name", "unknown"),
                                args=tool_call.get("args", {}),
                            )

                # Emit tool results (tool messages)
                if isinstance(message, ToolMessage):
                    content = message.content
                    if isinstance(content, list):
                        text = "".join(
                            str(b.get("text", b)) if isinstance(b, dict) else str(b)
                            for b in content
                        )
                    else:
                        text = str(content) if content else ""
                    yield ToolResultEvent.create(
                        tool_call_id=getattr(message, "tool_call_id", ""),
                        name=getattr(message, "name", "unknown"),
                        result=text,
                    )

            # Signal that the agent has finished responding for this turn
            yield AgentEndEvent.create()


async def _tts_stream(
    event_stream: AsyncIterator[VoiceAgentEvent],
) -> AsyncIterator[VoiceAgentEvent]:
    """
    Transform stream: Voice Events → Voice Events (with Audio)

    This function takes a stream of upstream voice agent events and processes them.
    When agent_chunk events arrive, it sends the text to Cartesia for TTS synthesis.
    Audio is streamed back as tts_chunk events as it's generated.
    All upstream events are passed through unchanged.

    It uses merge_async_iters to combine two concurrent streams:
    - process_upstream(): Iterates through incoming events, yields them for
      passthrough, and sends agent text chunks to Cartesia for synthesis.
    - tts.receive_events(): Yields audio chunks from Cartesia as they are
      synthesized.

    The merge utility runs both iterators concurrently, yielding items from
    either stream as they become available. This allows audio generation to
    begin before the agent has finished generating all text, minimizing latency.

    Args:
        event_stream: An async iterator of upstream voice agent events

    Yields:
        All upstream events plus tts_chunk events for synthesized audio
    """
    tts = CartesiaTTS()

    async def process_upstream() -> AsyncIterator[VoiceAgentEvent]:
        """
        Process upstream events, yielding them while sending text to Cartesia.

        This async generator serves two purposes:
        1. Pass through all upstream events (stt_chunk, stt_output, agent_chunk)
           so downstream consumers can observe the full event stream.
        2. Buffer agent_chunk text and send to Cartesia when agent_end arrives.
           This ensures the full response is sent at once for better TTS quality.
        """
        buffer: list[str] = []
        async for event in event_stream:
            # Pass through all events to downstream consumers
            yield event
            # Buffer agent text chunks
            if event.type == "agent_chunk":
                buffer.append(event.text)
            # Send all buffered text to Cartesia when agent finishes
            if event.type == "agent_end":
                await tts.send_text("".join(buffer))
                buffer = []

    try:
        # Open Cartesia before TaskGroup merge so the handshake is not racing sibling
        # task cancellation (e.g. client disconnect) and can use a longer open_timeout.
        await tts.prepare()
        # Merge the processed upstream events with TTS audio events
        # Both streams run concurrently, yielding events as they arrive
        async for event in merge_async_iters(process_upstream(), tts.receive_events()):
            yield event
    finally:
        # Cleanup: close the WebSocket connection to Cartesia
        await tts.close()


pipeline = (
    RunnableGenerator(_stt_stream)  # Audio -> STT events
    | RunnableGenerator(_agent_stream)  # STT events -> STT + Agent events
    | RunnableGenerator(_tts_stream)  # STT + Agent events -> All events
)

ADMIN_HTML_PATH = Path(__file__).resolve().parent / "admin.html"


class StockAdjustBody(BaseModel):
    action: Literal["increment", "decrement", "zero"]
    amount: int = Field(default=1, ge=1, le=999)


class KitchenStatusBody(BaseModel):
    status: Literal["nuevo", "en_preparacion", "listo"]


@app.get("/admin", response_class=HTMLResponse)
async def admin_page():
    if not ADMIN_HTML_PATH.is_file():
        raise HTTPException(status_code=500, detail="admin.html missing")
    return HTMLResponse(content=ADMIN_HTML_PATH.read_text(encoding="utf-8"))


@app.get("/api/admin/products")
def api_admin_list_products():
    with restaurant_db.db_session() as conn:
        return restaurant_db.list_all_products(conn)


@app.post("/api/admin/products/{product_id}/stock")
def api_admin_adjust_stock(product_id: str, body: StockAdjustBody):
    with restaurant_db.db_session() as conn:
        res = restaurant_db.adjust_product_stock(
            conn, product_id, body.action, body.amount
        )
        if not res["ok"]:
            code = 404 if str(res["error"]).startswith("Unknown") else 400
            raise HTTPException(status_code=code, detail=res["error"])
        return res


@app.get("/api/kitchen/orders")
def api_kitchen_list_orders(active: bool = True):
    with restaurant_db.db_session() as conn:
        return restaurant_db.list_kitchen_orders(
            conn, include_ready=not active
        )


@app.patch("/api/kitchen/orders/{order_id}")
async def api_kitchen_update_order(order_id: str, body: KitchenStatusBody):
    with restaurant_db.db_session() as conn:
        order = restaurant_db.update_kitchen_order_status(
            conn, order_id, body.status
        )
        if not order:
            raise HTTPException(status_code=404, detail="Order not found")
    await kitchen_hub.notify_order_updated(order)
    return order


@app.websocket("/ws/kitchen")
async def kitchen_websocket(websocket: WebSocket):
    await websocket.accept()
    kitchen_hub.add_client(websocket)
    with restaurant_db.db_session() as conn:
        snapshot = restaurant_db.list_kitchen_orders(conn, include_ready=False)
    await websocket.send_json({"type": "snapshot", "orders": snapshot})
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        kitchen_hub.remove_client(websocket)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    async def websocket_audio_stream() -> AsyncIterator[bytes]:
        """Async generator that yields audio bytes from the websocket."""
        try:
            while True:
                data = await websocket.receive_bytes()
                yield data
        except WebSocketDisconnect:
            # Client closed the tab or connection; end the stream without error.
            return

    output_stream = pipeline.atransform(websocket_audio_stream())

    try:
        async for event in output_stream:
            await websocket.send_json(event_to_dict(event))
    except WebSocketDisconnect:
        # Client disconnected while we were sending events.
        pass


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    uvicorn.run("main:app", port=8000, reload=True)
