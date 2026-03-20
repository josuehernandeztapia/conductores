import { useState, useRef, useCallback } from "react";
import { Car, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiLogin, initStore } from "@/lib/api";

type PinLoginProps = {
  onLogin: (promoter: { id: number; name: string }) => void;
};

export function PinLogin({ onLogin }: PinLoginProps) {
  const { toast } = useToast();
  const [pin, setPin] = useState<string[]>(["", "", "", "", "", ""]);
  const [isLoading, setIsLoading] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const handleInput = useCallback((index: number, value: string) => {
    if (!/^\d?$/.test(value)) return;
    const newPin = [...pin];
    newPin[index] = value;
    setPin(newPin);

    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  }, [pin]);

  const handleKeyDown = useCallback((index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !pin[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }, [pin]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    const newPin = [...pin];
    for (let i = 0; i < pasted.length; i++) {
      newPin[i] = pasted[i];
    }
    setPin(newPin);
    if (pasted.length > 0) {
      const focusIdx = Math.min(pasted.length, 5);
      inputRefs.current[focusIdx]?.focus();
    }
  }, [pin]);

  const handleSubmit = useCallback(async () => {
    const pinStr = pin.join("");
    if (pinStr.length !== 6) {
      toast({ title: "PIN incompleto", description: "Ingresa los 6 dígitos", variant: "destructive" });
      return;
    }

    setIsLoading(true);
    try {
      // Initialize store (seeds data if first time)
      initStore();

      // Login via API (falls back to in-memory storage automatically)
      const promoter = await apiLogin(pinStr);

      if (promoter) {
        onLogin({ id: promoter.id, name: promoter.name });
      } else {
        toast({ title: "PIN incorrecto", description: "Verifica tu PIN e intenta de nuevo", variant: "destructive" });
        setPin(["", "", "", "", "", ""]);
        inputRefs.current[0]?.focus();
      }
    } catch {
      toast({ title: "Error", description: "No se pudo verificar el PIN", variant: "destructive" });
      setPin(["", "", "", "", "", ""]);
      inputRefs.current[0]?.focus();
    } finally {
      setIsLoading(false);
    }
  }, [pin, onLogin, toast]);

  const isPinComplete = pin.every((d) => d !== "");

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center">
            <Car className="w-7 h-7 text-primary-foreground" />
          </div>
          <div className="text-center">
            <h1 className="text-lg font-semibold">CMU Plataforma</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Conductores del Mundo, S.A.P.I. de C.V.
            </p>
          </div>
        </div>

        <Card>
          <CardContent className="p-6 space-y-5">
            <div className="text-center">
              <h2 className="text-sm font-medium">Ingresa tu PIN</h2>
              <p className="text-xs text-muted-foreground mt-1">
                Introduce tu PIN de 6 dígitos para acceder
              </p>
            </div>

            {/* PIN Input */}
            <div className="flex justify-center gap-2" onPaste={handlePaste}>
              {pin.map((digit, i) => (
                <input
                  key={i}
                  ref={(el) => { inputRefs.current[i] = el; }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => handleInput(i, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(i, e)}
                  className="w-11 h-13 text-center text-lg font-semibold rounded-lg border border-input bg-background
                    focus:outline-none focus:ring-2 focus:ring-ring focus:border-primary
                    transition-all"
                  data-testid={`input-pin-${i}`}
                />
              ))}
            </div>

            <Button
              className="w-full gap-2"
              onClick={handleSubmit}
              disabled={!isPinComplete || isLoading}
              data-testid="button-login"
            >
              {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
              {isLoading ? "Verificando..." : "Acceder"}
            </Button>

            <p className="text-[10px] text-muted-foreground text-center">
              Acceso exclusivo para promotoras CMU
            </p>
          </CardContent>
        </Card>

        <p className="text-[10px] text-muted-foreground text-center">
          Aguascalientes, México
        </p>
      </div>
    </div>
  );
}
