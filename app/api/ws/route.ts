import { experimental_upgradeWebSocket, type WebSocketData } from "@vercel/functions";
import { register, handleMessage, unregister } from "@/lib/quiz-realtime";

export const maxDuration = 300;

export function GET() {
  return experimental_upgradeWebSocket((ws: any) => {
    register(ws);
    ws.on("message", (data: WebSocketData) => void handleMessage(ws, data.toString()));
    const close = () => void unregister(ws);
    ws.on("close", close);
    ws.on("error", close);
  });
}
