/**
 * Prospect Flow — PWA version of WhatsApp orchestrator flow
 *
 * States: name → fuel_type → consumo → models → select → tank → corrida → confirm
 * Syncs with conversation_states table for WhatsApp continuity
 */

import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";
import {
  Car,
  Fuel,
  Calculator,
  User,
  ChevronRight,
  ChevronLeft,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Phone,
  DollarSign,
  TrendingDown,
} from "lucide-react";

// API base
// Using apiFetch from lib/api.ts which auto-injects auth token

// States mapping to orchestrator
type ProspectState =
  | "idle"
  | "prospect_name"
  | "prospect_fuel_type"
  | "prospect_consumo"
  | "prospect_show_models"
  | "prospect_select_model"
  | "prospect_tank"
  | "prospect_corrida"
  | "prospect_confirm";

interface ProspectContext {
  nombre?: string;
  fuelType?: "gnv" | "gasolina";
  consumoLeq?: number;
  gastoPesosMes?: number;
  selectedModel?: {
    marca: string;
    modelo: string;
    anio: number;
    precio: number;
  };
  reuseTank?: boolean;
  corridaResumen?: any;
  phone?: string;
  folio?: string;
}

// Vehicle models — fetched from /api/inventory at runtime
type VehicleModel = { id: number; marca: string; modelo: string; variante?: string; anio: number; precio: number };

// Calculate corrida client-side (German amortization)
function calcularCorrida(
  pv: number,
  consumoLeq: number,
  kitNuevo: boolean,
  fuelType: "gnv" | "gasolina"
): any {
  const pvFinal = kitNuevo ? pv + 9400 : pv;
  const tasaAnual = 0.299;
  const tasaMensual = tasaAnual / 12;
  const meses = 36;
  // Both profiles get GNV savings — Perfil B converts to GNV with the new vehicle
  const gnvRevenue = consumoLeq * 11; // $11/LEQ sobreprecio GNV
  const fondoGarantia = 334;

  // German amortization
  const capitalMensual = pvFinal / meses;
  let saldo = pvFinal;
  let fgAcum = 8000; // FG inicial
  const FG_TECHO = 20000;
  const rows = [];

  for (let mes = 1; mes <= meses; mes++) {
    const interes = saldo * tasaMensual;
    const cuota = capitalMensual + interes;
    const fgEste = fgAcum < FG_TECHO ? fondoGarantia : 0;
    fgAcum += fgEste;
    const diferencial = Math.max(0, cuota - gnvRevenue) + fgEste;

    rows.push({
      mes,
      cuota: Math.round(cuota),
      recaudo: gnvRevenue,
      diferencial: Math.round(diferencial),
      saldo: Math.round(saldo - capitalMensual),
    });

    saldo -= capitalMensual;
  }

  return {
    vehiculo: `${pv.toLocaleString("es-MX")}`,
    kitGnv: kitNuevo ? 9400 : 0,
    total: pvFinal,
    rows,
    tasaAnual: (tasaAnual * 100).toFixed(1),
    plazo: meses,
  };
}

export default function ProspectFlowPage() {
  const [location, setLocation] = useLocation();
  const { toast } = useToast();

  // Extract phone from URL query string
  const phoneFromUrl = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.hash.split('?')[1] || '').get('phone') || ''
    : '';
  const navigate = (path: string) => setLocation(path);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [state, setState] = useState<ProspectState>("idle");
  const [models, setModels] = useState<VehicleModel[]>([]);
  const [context, setContext] = useState<ProspectContext>({});

  // Load existing state + inventory
  useEffect(() => {
    // Always fetch inventory
    apiFetch('/api/inventory').then(async r => {
      if (r.ok) {
        const inv = await r.json();
        setModels(inv.map((v: any) => ({
          id: v.id, marca: v.brand, modelo: v.model,
          variante: v.variant, anio: v.year, precio: Number(v.cmu),
        })));
      }
    }).catch(() => {});

    if (!phoneFromUrl) {
      setState("prospect_name");
      setLoading(false);
      return;
    }

    async function loadState() {
      try {
        const res = await apiFetch(`/api/conversation-state/${phoneFromUrl}`);
        if (res.ok) {
          const data = await res.json();
          setState(data.state || "prospect_name");
          setContext({ ...data.context, phone: phoneFromUrl });
        } else {
          setState("prospect_name");
          setContext({ phone: phoneFromUrl });
        }
      } catch (error) {
        console.error("Failed to load state:", error);
        setState("prospect_name");
      } finally {
        setLoading(false);
      }
    }

    loadState();
  }, [phoneFromUrl]);

  // Save state to conversation_states
  const saveState = useCallback(async (newState: ProspectState, newContext: ProspectContext) => {
    if (!context.phone) return; // Can't save without phone

    setSaving(true);
    try {
      const res = await apiFetch(`/api/conversation-state/${context.phone}`, {
        method: "PATCH",
        body: JSON.stringify({
          state: newState,
          context: newContext,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to save state");
      }

      setState(newState);
      setContext(newContext);
    } catch (error: any) {
      toast({
        title: "Error al guardar",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }, [context.phone, toast]);

  // State handlers
  const handleName = () => {
    const name = (document.getElementById("nombre") as HTMLInputElement)?.value;
    const phone = (document.getElementById("phone") as HTMLInputElement)?.value?.replace(/\D/g, "");
    if (!name) {
      toast({ title: "Ingresa el nombre", variant: "destructive" });
      return;
    }
    if (!phone || phone.length !== 10) {
      toast({ title: "Teléfono de 10 dígitos", variant: "destructive" });
      return;
    }
    const fullPhone = `521${phone}`; // MX mobile format
    const newContext = { ...context, nombre: name, phone: fullPhone };
    // Save locally first (phone wasn't set before)
    setContext(newContext);
    setState("prospect_fuel_type");
    // Then persist async
    apiFetch(`/api/conversation-state/${fullPhone}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "prospect_fuel_type", context: newContext }),
    }).catch(() => {});
  };

  const handleFuelType = (fuel: "gnv" | "gasolina") => {
    const newContext = { ...context, fuelType: fuel };
    saveState("prospect_consumo", newContext);
  };

  const handleConsumo = () => {
    const input = (document.getElementById("consumo") as HTMLInputElement)?.value;
    if (!input) {
      toast({ title: "Por favor ingresa tu consumo mensual", variant: "destructive" });
      return;
    }

    const value = parseInt(input);
    if (isNaN(value) || value <= 0) {
      toast({ title: "Ingresa un número válido", variant: "destructive" });
      return;
    }

    const newContext = { ...context };

    if (context.fuelType === "gnv") {
      if (value < 400) {
        toast({ title: "Mínimo 400 LEQ/mes para Perfil A", variant: "destructive" });
        return;
      }
      newContext.consumoLeq = value;
    } else {
      if (value < 9600) {
        toast({ title: "Mínimo $9,600/mes para Perfil B", variant: "destructive" });
        return;
      }
      newContext.gastoPesosMes = value;
      // Gasolina: pesos → LEQ equivalente (pesos / precio_gasolina_litro)
      // $9,600 / $24 = 400 litros ≈ 400 LEQ equivalente
      newContext.consumoLeq = Math.round(value / 24);
    }

    saveState("prospect_show_models", newContext);
  };

  const handleSelectModel = (model: VehicleModel) => {
    const newContext = {
      ...context,
      selectedModel: {
        marca: model.marca,
        modelo: model.modelo,
        anio: model.anio,
        precio: model.precio,
      },
    };

    // If GNV, ask about tank
    if (context.fuelType === "gnv") {
      saveState("prospect_tank", newContext);
    } else {
      // Skip tank question for gasoline
      saveState("prospect_corrida", newContext);
    }
  };

  const handleTank = (reuse: boolean) => {
    const newContext = { ...context, reuseTank: reuse };
    saveState("prospect_corrida", newContext);
  };

  const generateCorrida = () => {
    if (!context.selectedModel || !context.consumoLeq) return;

    const corrida = calcularCorrida(
      context.selectedModel.precio,
      context.consumoLeq,
      context.fuelType === "gnv" && !context.reuseTank,
      context.fuelType!
    );

    const newContext = { ...context, corridaResumen: corrida };
    setState("prospect_corrida");
    setContext(newContext);
  };

  const handleConfirm = async () => {
    setSaving(true);
    try {
      // Create origination with all the data
      // Split name into parts (MX convention: nombre apellidoPaterno apellidoMaterno)
      const nameParts = (context.nombre || "").trim().split(/\s+/);
      const nombre = nameParts.length >= 3 ? nameParts.slice(0, -2).join(" ") : nameParts[0] || "";
      const apellidoPaterno = nameParts.length >= 2 ? nameParts[nameParts.length - (nameParts.length >= 3 ? 2 : 1)] : "";
      const apellidoMaterno = nameParts.length >= 3 ? nameParts[nameParts.length - 1] : "";

      const res = await apiFetch(`/api/originations`, {
        method: "POST",
        body: JSON.stringify({
          tipo: "compraventa",
          perfilTipo: context.fuelType === "gnv" ? "A" : "B",
          otpPhone: context.phone,
          taxista: {
            nombre,
            apellidoPaterno: apellidoPaterno || nombre, // fallback to nombre if single word
            apellidoMaterno,
            telefono: context.phone,
          },
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.message || `Error ${res.status}`);
      }

      const data = await res.json();
      const folio = data.folio;

      toast({
        title: "¡Registro exitoso!",
        description: `Tu folio es ${folio}. Ahora puedes subir tus documentos.`,
      });

      // Navigate to origination flow
      navigate(`/originacion/${data.id}`);
    } catch (error: any) {
      toast({
        title: "Error al registrar",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  // Progress calculation
  const STEPS = ["Nombre", "Combustible", "Consumo", "Modelo", "Tanque", "Números", "Confirmar"];
  const stepIndex = {
    idle: 0,
    prospect_name: 0,
    prospect_fuel_type: 1,
    prospect_consumo: 2,
    prospect_show_models: 3,
    prospect_select_model: 3,
    prospect_tank: 4,
    prospect_corrida: 5,
    prospect_confirm: 6,
  }[state];
  const progress = ((stepIndex + 1) / STEPS.length) * 100;

  return (
    <div className="container max-w-2xl mx-auto py-8 px-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Car className="h-5 w-5" />
            Renovación de Taxi con GNV
          </CardTitle>
          <CardDescription className="flex items-center justify-between">
            <span>Programa de Conductores del Mundo — Aguascalientes</span>
            {state !== "prospect_name" && state !== "idle" && (
              <button
                onClick={() => { setState("prospect_name"); setContext({}); }}
                className="text-xs text-teal-500 hover:underline"
              >
                Nuevo prospecto
              </button>
            )}
          </CardDescription>
          <Progress value={progress} className="mt-4" />
        </CardHeader>

        <CardContent className="space-y-6">
          {/* Name State */}
          {state === "prospect_name" && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <User className="h-5 w-5" />
                ¿Cómo te llamas?
              </h3>
              <Input
                id="nombre"
                placeholder="Tu nombre completo"
                defaultValue={context.nombre}
                onKeyPress={(e) => e.key === "Enter" && handleName()}
              />
              <Input
                id="phone"
                placeholder="Tu teléfono (10 dígitos)"
                defaultValue={context.phone}
                onChange={(e) => setContext({ ...context, phone: e.target.value })}
              />
              <Button onClick={handleName} disabled={saving} className="w-full">
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Continuar
                <ChevronRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          )}

          {/* Fuel Type State */}
          {state === "prospect_fuel_type" && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <Fuel className="h-5 w-5" />
                Hola {context.nombre}, ¿tu taxi usa gas natural o gasolina?
              </h3>
              <RadioGroup defaultValue={context.fuelType}>
                <div className="flex items-center space-x-2 p-4 border rounded-lg hover:bg-muted/50 cursor-pointer"
                     onClick={() => handleFuelType("gnv")}>
                  <RadioGroupItem value="gnv" id="gnv" />
                  <Label htmlFor="gnv" className="cursor-pointer flex-1">
                    <div>
                      <p className="font-medium">Gas Natural (GNV)</p>
                      <p className="text-sm text-muted-foreground">Mi taxi ya tiene kit de gas</p>
                    </div>
                  </Label>
                </div>
                <div className="flex items-center space-x-2 p-4 border rounded-lg hover:bg-muted/50 cursor-pointer"
                     onClick={() => handleFuelType("gasolina")}>
                  <RadioGroupItem value="gasolina" id="gasolina" />
                  <Label htmlFor="gasolina" className="cursor-pointer flex-1">
                    <div>
                      <p className="font-medium">Gasolina</p>
                      <p className="text-sm text-muted-foreground">Uso gasolina tradicional</p>
                    </div>
                  </Label>
                </div>
              </RadioGroup>
            </div>
          )}

          {/* Consumo State */}
          {state === "prospect_consumo" && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <Calculator className="h-5 w-5" />
                {context.fuelType === "gnv"
                  ? "¿Cuántos litros de GNV cargas al mes?"
                  : "¿Cuánto gastas de gasolina al mes?"}
              </h3>
              <Input
                id="consumo"
                type="number"
                placeholder={context.fuelType === "gnv" ? "Ejemplo: 400 LEQ" : "Ejemplo: 6000 pesos"}
                defaultValue={context.fuelType === "gnv" ? context.consumoLeq : context.gastoPesosMes}
                onKeyPress={(e) => e.key === "Enter" && handleConsumo()}
              />
              <p className="text-sm text-muted-foreground">
                {context.fuelType === "gnv"
                  ? "Promedio mensual en Litros Equivalentes (LEQ)"
                  : "Gasto mensual en pesos mexicanos"}
              </p>
              <Button onClick={handleConsumo} disabled={saving} className="w-full">
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Continuar
                <ChevronRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          )}

          {/* Show Models State */}
          {state === "prospect_show_models" && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">
                Selecciona tu vehículo seminuevo
              </h3>
              <div className="grid gap-3">
                {models.map((model) => (
                  <Card
                    key={`${model.marca}-${model.modelo}`}
                    className="cursor-pointer hover:border-primary transition-colors"
                    onClick={() => handleSelectModel(model)}
                  >
                    <CardContent className="flex justify-between items-center p-4">
                      <div>
                        <p className="font-semibold">{model.marca} {model.modelo}</p>
                        <p className="text-sm text-muted-foreground">Año {model.anio}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-lg">${model.precio.toLocaleString()}</p>
                        <p className="text-sm text-green-600">Seminuevo certificado</p>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Tank State (GNV only) */}
          {state === "prospect_tank" && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">
                ¿Reutilizas tu tanque actual o prefieres kit nuevo?
              </h3>
              <RadioGroup defaultValue={context.reuseTank ? "reuse" : "new"}>
                <Card
                  className="cursor-pointer hover:border-primary"
                  onClick={() => handleTank(true)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="reuse" id="reuse" />
                      <Label htmlFor="reuse" className="cursor-pointer flex-1">
                        <div>
                          <p className="font-medium">Reutilizar mi tanque actual</p>
                          <p className="text-sm text-muted-foreground">Sin costo adicional</p>
                          <Badge className="mt-2 bg-green-100 text-green-800">Ahorras $9,400</Badge>
                        </div>
                      </Label>
                    </div>
                  </CardContent>
                </Card>

                <Card
                  className="cursor-pointer hover:border-primary"
                  onClick={() => handleTank(false)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="new" id="new" />
                      <Label htmlFor="new" className="cursor-pointer flex-1">
                        <div>
                          <p className="font-medium">Kit completamente nuevo</p>
                          <p className="text-sm text-muted-foreground">Incluye tanque nuevo + instalación</p>
                          <Badge className="mt-2">+$9,400 al precio</Badge>
                        </div>
                      </Label>
                    </div>
                  </CardContent>
                </Card>
              </RadioGroup>
            </div>
          )}

          {/* Corrida State */}
          {state === "prospect_corrida" && !context.corridaResumen && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Generando tu corrida financiera...</h3>
              <Button onClick={generateCorrida} className="w-full">
                Ver mis números
              </Button>
            </div>
          )}

          {state === "prospect_corrida" && context.corridaResumen && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <DollarSign className="h-5 w-5" />
                Tu corrida financiera
              </h3>

              <Card className="bg-muted/50">
                <CardContent className="pt-6 space-y-2">
                  <div className="flex justify-between">
                    <span>Vehículo:</span>
                    <span className="font-semibold">
                      {context.selectedModel?.marca} {context.selectedModel?.modelo} {context.selectedModel?.anio}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Precio:</span>
                    <span className="font-semibold">${context.selectedModel?.precio.toLocaleString()}</span>
                  </div>
                  {context.corridaResumen.kitGnv > 0 && (
                    <div className="flex justify-between">
                      <span>Kit GNV nuevo:</span>
                      <span className="font-semibold">+${context.corridaResumen.kitGnv.toLocaleString()}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-lg font-bold pt-2 border-t">
                    <span>Total financiado:</span>
                    <span>${context.corridaResumen.total.toLocaleString()}</span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-6">
                  <h4 className="font-semibold mb-3">Primeros 3 meses:</h4>
                  <div className="space-y-2">
                    {context.corridaResumen.rows.slice(0, 3).map((row: any) => (
                      <div key={row.mes} className="flex justify-between text-sm">
                        <span>Mes {row.mes}:</span>
                        <div className="text-right">
                          <span className="line-through text-muted-foreground mr-2">
                            ${row.cuota.toLocaleString()}
                          </span>
                          {row.recaudo > 0 && (
                            <span className="text-green-600 mr-2">
                              -${row.recaudo.toLocaleString()} GNV
                            </span>
                          )}
                          <span className="font-bold">
                            ${row.diferencial.toLocaleString()}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-4 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg">
                    <p className="text-sm">
                      <TrendingDown className="h-4 w-4 inline mr-1 text-green-600" />
                      {context.fuelType === "gnv"
                        ? `Tu ahorro en GNV cubre $${context.corridaResumen.rows[0].recaudo.toLocaleString()} de la cuota mensual`
                        : "Al cambiar a GNV, ahorrarás significativamente en combustible"}
                    </p>
                  </div>
                </CardContent>
              </Card>

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={() => setState("prospect_show_models")}
                  className="flex-1"
                >
                  <ChevronLeft className="h-4 w-4 mr-2" />
                  Cambiar vehículo
                </Button>
                <Button
                  onClick={() => setState("prospect_confirm")}
                  className="flex-1"
                >
                  Me interesa
                  <ChevronRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </div>
          )}

          {/* Confirm State */}
          {state === "prospect_confirm" && (
            <div className="space-y-4">
              <div className="text-center space-y-2">
                <CheckCircle2 className="h-12 w-12 text-green-600 mx-auto" />
                <h3 className="text-lg font-semibold">¿Listo para registrarte?</h3>
                <p className="text-muted-foreground">
                  El siguiente paso es subir tus documentos y hacer una entrevista rápida
                </p>
              </div>

              <Card className="bg-blue-50 dark:bg-blue-900/20 border-blue-200">
                <CardContent className="pt-6 space-y-2">
                  <p className="text-sm">📄 15 documentos (INE, licencia, etc.)</p>
                  <p className="text-sm">🎤 Entrevista de 8 preguntas</p>
                  <p className="text-sm">⏱️ Respuesta en 24-48 horas</p>
                  <p className="text-sm">🚗 Entrega en 1-2 semanas si aprobado</p>
                </CardContent>
              </Card>

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={() => setState("prospect_corrida")}
                  className="flex-1"
                >
                  <ChevronLeft className="h-4 w-4 mr-2" />
                  Ver números
                </Button>
                <Button
                  onClick={handleConfirm}
                  disabled={saving}
                  className="flex-1"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Crear mi folio
                  <ChevronRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Phone indicator */}
      {context.phone && (
        <div className="mt-4 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
          <Phone className="h-4 w-4" />
          {context.phone}
          {context.folio && (
            <>
              <span>•</span>
              <span>Folio: {context.folio}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}