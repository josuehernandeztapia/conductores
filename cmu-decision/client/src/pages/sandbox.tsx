/**
 * Agent Sandbox — Simulate WhatsApp conversations
 * 
 * Director: sees chat only
 * Dev: sees chat + debug panel (state machine, latency, context)
 */

import { useState, useRef, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Send,
  Bot,
  User,
  RefreshCw,
  Bug,
  Clock,
  Activity,
  ChevronRight,
  Loader2,
  Mic,
} from "lucide-react";

const API_BASE = "";

interface Message {
  role: "user" | "agent";
  text: string;
  timestamp: string;
  debug?: any;
}

export default function SandboxPage({ showDebug = false }: { showDebug?: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [simulateRole, setSimulateRole] = useState("prospecto");
  const [sessionId] = useState(() => `s${Date.now()}`);
  const [isLoading, setIsLoading] = useState(false);
  const [lastDebug, setLastDebug] = useState<any>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;
    const userMsg = input.trim();
    setInput("");

    setMessages(prev => [...prev, {
      role: "user",
      text: userMsg,
      timestamp: new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }),
    }]);

    setIsLoading(true);
    try {
      const resp = await fetch(`${API_BASE}/api/agent/sandbox`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMsg,
          simulateRole,
          sessionId: `${sessionId}_${simulateRole}`,
        }),
      });
      const data = await resp.json();

      if (data.success) {
        setMessages(prev => [...prev, {
          role: "agent",
          text: data.reply,
          timestamp: new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }),
          debug: data.debug,
        }]);
        setLastDebug(data.debug);
      } else {
        setMessages(prev => [...prev, {
          role: "agent",
          text: `Error: ${data.error}`,
          timestamp: new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }),
        }]);
      }
    } catch (err: any) {
      setMessages(prev => [...prev, {
        role: "agent",
        text: `Error de conexión: ${err.message}`,
        timestamp: new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }),
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const resetSession = () => {
    setMessages([]);
    setLastDebug(null);
  };

  return (
    <div className={`flex h-[calc(100vh-3rem)] ${showDebug ? "gap-3 p-3" : "p-3"}`}>
      {/* Chat Panel */}
      <div className={`flex flex-col ${showDebug ? "w-1/2" : "max-w-lg mx-auto w-full"}`}>
        {/* Header */}
        <div className="flex items-center gap-2 mb-3">
          <Bot className="w-5 h-5 text-primary" />
          <h1 className="text-sm font-semibold flex-1">Sandbox del Agente</h1>
          <Select value={simulateRole} onValueChange={(v) => { setSimulateRole(v); resetSession(); }}>
            <SelectTrigger className="w-[140px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="prospecto">Prospecto</SelectItem>
              <SelectItem value="cliente">Cliente</SelectItem>
              <SelectItem value="promotora">Promotora</SelectItem>
              <SelectItem value="director">Director</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={resetSession} data-testid="button-reset-sandbox">
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>

        {/* Role indicator */}
        <Badge variant="outline" className="text-[10px] w-fit mb-2">
          Simulando: {simulateRole} · Session: {sessionId.slice(-6)}
        </Badge>

        {/* Chat area */}
        <Card className="flex-1 overflow-hidden flex flex-col">
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {messages.length === 0 && (
              <div className="text-center text-muted-foreground text-xs py-8">
                <Bot className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p>Escribe un mensaje para simular una conversación.</p>
                <p className="mt-1">Prueba: "Hola, vi el cartel en ACATAXI"</p>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-lg px-3 py-2 ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted"
                }`}>
                  <div className="flex items-center gap-1.5 mb-0.5">
                    {msg.role === "user" ? <User className="w-3 h-3" /> : <Bot className="w-3 h-3" />}
                    <span className="text-[9px] opacity-70">{msg.timestamp}</span>
                    {msg.debug?.latencyMs && (
                      <span className="text-[9px] opacity-50">{msg.debug.latencyMs}ms</span>
                    )}
                  </div>
                  <p className="text-xs whitespace-pre-wrap">{msg.text}</p>
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-muted rounded-lg px-3 py-2">
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Input */}
          <div className="border-t p-2 flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder="Escribe un mensaje..."
              className="text-xs h-9"
              disabled={isLoading}
              data-testid="input-sandbox-message"
            />
            <Button
              size="sm"
              onClick={sendMessage}
              disabled={!input.trim() || isLoading}
              data-testid="button-sandbox-send"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </Card>
      </div>

      {/* Debug Panel (dev only) */}
      {showDebug && (
        <div className="w-1/2 flex flex-col">
          <div className="flex items-center gap-2 mb-3">
            <Bug className="w-5 h-5 text-amber-500" />
            <h2 className="text-sm font-semibold">Debug Panel</h2>
          </div>

          <Card className="flex-1 overflow-y-auto">
            <CardContent className="p-3 space-y-3">
              {!lastDebug ? (
                <div className="text-center text-muted-foreground text-xs py-8">
                  <Activity className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p>El debug aparece después del primer mensaje.</p>
                </div>
              ) : (
                <>
                  {/* State Machine */}
                  <div className="space-y-1">
                    <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">State Machine</h3>
                    <div className="flex items-center gap-2 text-xs">
                      <Badge variant="outline" className="text-[10px] font-mono">{lastDebug.stateBefore}</Badge>
                      <ChevronRight className="w-3 h-3 text-muted-foreground" />
                      <Badge className="text-[10px] font-mono bg-primary/10 text-primary">{lastDebug.stateAfter}</Badge>
                    </div>
                  </div>

                  {/* Latency */}
                  <div className="space-y-1">
                    <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Performance</h3>
                    <div className="flex items-center gap-2 text-xs">
                      <Clock className="w-3 h-3 text-muted-foreground" />
                      <span className={`font-mono font-bold ${lastDebug.latencyMs > 5000 ? "text-red-500" : lastDebug.latencyMs > 2000 ? "text-amber-500" : "text-emerald-500"}`}>
                        {lastDebug.latencyMs}ms
                      </span>
                    </div>
                  </div>

                  {/* Context */}
                  <div className="space-y-1">
                    <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Context</h3>
                    <pre className="text-[10px] font-mono bg-muted/50 p-2 rounded overflow-x-auto max-h-40 whitespace-pre-wrap">
                      {JSON.stringify(lastDebug.context, null, 2)}
                    </pre>
                  </div>

                  {/* Metadata */}
                  <div className="space-y-1">
                    <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Metadata</h3>
                    <div className="text-[10px] space-y-0.5">
                      <p><span className="text-muted-foreground">Role:</span> {lastDebug.role}</p>
                      <p><span className="text-muted-foreground">Phone:</span> <span className="font-mono">{lastDebug.phone}</span></p>
                      {lastDebug.documentSaved && <p><span className="text-muted-foreground">Doc saved:</span> {lastDebug.documentSaved}</p>}
                      {lastDebug.newOriginationId && <p><span className="text-muted-foreground">Origination:</span> {lastDebug.newOriginationId}</p>}
                    </div>
                  </div>

                  {/* Logs */}
                  <div className="space-y-1">
                    <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Logs</h3>
                    <div className="text-[10px] font-mono bg-slate-900 text-slate-300 p-2 rounded space-y-0.5 max-h-40 overflow-y-auto">
                      {lastDebug.logs?.map((log: string, i: number) => (
                        <p key={i}>{log}</p>
                      ))}
                    </div>
                  </div>

                  {/* Full message history with debug */}
                  <div className="space-y-1">
                    <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">State History</h3>
                    <div className="space-y-1">
                      {messages.filter(m => m.debug).map((m, i) => (
                        <div key={i} className="text-[9px] flex items-center gap-1">
                          <Badge variant="outline" className="text-[8px] font-mono px-1">{m.debug.stateBefore}</Badge>
                          <ChevronRight className="w-2.5 h-2.5" />
                          <Badge variant="outline" className="text-[8px] font-mono px-1">{m.debug.stateAfter}</Badge>
                          <span className="text-muted-foreground ml-1">{m.debug.latencyMs}ms</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
