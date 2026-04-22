import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  AlertTriangle,
  AlertCircle,
  Clock,
  FileText,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronRight,
} from "lucide-react";

interface DashboardFolio {
  id: number;
  folio: string;
  tipo: string;
  estado: string;
  taxistaNombre: string | null;
  taxistaTelefono: string | null;
  currentStep: number;
  diasDesdeCreacion: number;
  diasDesdeActualizacion: number;
  docsCapturados: number;
  docsFaltantes: string[];
  siguientePaso: string;
  urgencia: "ok" | "watch" | "alert" | "critical";
}

interface Bucket {
  key: string;
  titulo: string;
  descripcion: string;
  count: number;
  items: DashboardFolio[];
}

interface Alert {
  severity: "info" | "warning" | "critical";
  code: string;
  title: string;
  message: string;
  foliosAfectados: string[];
  action?: string;
}

interface KPIs {
  mesActual: string;
  totalActivos: number;
  totalFirmadosEsteMes: number;
  totalPerdidosEsteMes: number;
  totalRechazadosEsteMes: number;
  conversionRate: number;
}

interface Dashboard {
  promotor: { id: string; label: string };
  timestamp: string;
  alerts: Alert[];
  buckets: Bucket[];
  kpis: KPIs;
}

const URGENCIA_STYLES = {
  critical: { color: "text-red-600", bg: "bg-red-50", border: "border-red-300", label: "Crítico" },
  alert: { color: "text-orange-600", bg: "bg-orange-50", border: "border-orange-300", label: "Alerta" },
  watch: { color: "text-yellow-700", bg: "bg-yellow-50", border: "border-yellow-300", label: "Seguimiento" },
  ok: { color: "text-green-700", bg: "bg-green-50", border: "border-green-300", label: "OK" },
};

export default function PromotorDashboardPage() {
  const [, setLocation] = useLocation();

  const { data, isLoading, error, refetch } = useQuery<Dashboard>({
    queryKey: ["promotor-dashboard"],
    queryFn: async () => {
      const res = await fetch("/api/promotor/dashboard", { credentials: "include" });
      if (!res.ok) throw new Error("Error cargando dashboard");
      return res.json();
    },
    refetchInterval: 60000, // refresh cada minuto
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 text-center">
        <p className="text-red-600">No se pudo cargar el panel.</p>
        <Button onClick={() => refetch()} className="mt-2">Reintentar</Button>
      </div>
    );
  }

  const abrirFolio = (id: number) => setLocation(`/originacion/${id}`);

  return (
    <div className="min-h-screen bg-background pb-24">
      {/* Header con KPIs */}
      <div className="bg-card border-b sticky top-0 z-10 shadow-sm">
        <div className="max-w-4xl mx-auto p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h1 className="text-2xl font-bold">{data.promotor.label}</h1>
              <p className="text-sm text-muted-foreground">
                Panel de trabajo · {new Date(data.timestamp).toLocaleString("es-MX", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}
              </p>
            </div>
          </div>
          {/* KPIs chips */}
          <div className="grid grid-cols-4 gap-2 text-center">
            <KpiChip label="Activos" value={data.kpis.totalActivos} />
            <KpiChip label="Firmados/mes" value={data.kpis.totalFirmadosEsteMes} accent="green" />
            <KpiChip label="Rechazados" value={data.kpis.totalRechazadosEsteMes} accent="red" />
            <KpiChip label="Conversión" value={`${Math.round(data.kpis.conversionRate * 100)}%`} />
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto p-4 space-y-4">
        {/* Alertas */}
        {data.alerts.length > 0 && (
          <div className="space-y-2">
            {data.alerts.map((alert) => (
              <AlertBanner key={alert.code} alert={alert} />
            ))}
          </div>
        )}

        {/* Buckets */}
        {data.buckets.map((bucket) => (
          <BucketCard key={bucket.key} bucket={bucket} onOpenFolio={abrirFolio} />
        ))}

        {data.buckets.every((b) => b.count === 0) && (
          <Card>
            <CardContent className="p-8 text-center">
              <p className="text-lg font-medium mb-2">No tienes folios todavía</p>
              <p className="text-sm text-muted-foreground mb-4">Empieza creando un nuevo prospecto.</p>
              <Button onClick={() => setLocation("/prospect")} size="lg">
                <Plus className="mr-2 h-5 w-5" />
                Nuevo Prospecto
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      {/* FAB Nuevo Prospecto */}
      <button
        onClick={() => setLocation("/prospect")}
        className="fixed bottom-6 right-6 bg-primary text-primary-foreground rounded-full shadow-lg flex items-center gap-2 px-5 py-4 hover:shadow-xl transition-shadow"
        data-testid="fab-nuevo-prospecto"
      >
        <Plus className="h-5 w-5" />
        <span className="font-medium">Nuevo Prospecto</span>
      </button>
    </div>
  );
}

// ========== Sub-components ==========

function KpiChip({ label, value, accent }: { label: string; value: number | string; accent?: "green" | "red" }) {
  const colorClass =
    accent === "green" ? "text-green-700" :
    accent === "red" ? "text-red-700" :
    "text-foreground";
  return (
    <div className="bg-muted/50 rounded-md px-2 py-2">
      <div className={`text-xl font-bold ${colorClass}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function AlertBanner({ alert }: { alert: Alert }) {
  const styles = {
    critical: "bg-red-50 border-red-300 text-red-900",
    warning: "bg-orange-50 border-orange-300 text-orange-900",
    info: "bg-blue-50 border-blue-300 text-blue-900",
  };
  const Icon = alert.severity === "critical" ? AlertCircle : AlertTriangle;

  return (
    <div className={`rounded-lg border-l-4 p-3 ${styles[alert.severity]}`}>
      <div className="flex items-start gap-2">
        <Icon className="h-5 w-5 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <p className="font-semibold">{alert.title}</p>
          <p className="text-sm mt-1">{alert.message}</p>
          {alert.foliosAfectados.length > 0 && (
            <p className="text-xs mt-2 font-mono">{alert.foliosAfectados.slice(0, 5).join(" · ")}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function BucketCard({ bucket, onOpenFolio }: { bucket: Bucket; onOpenFolio: (id: number) => void }) {
  if (bucket.count === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">{bucket.titulo}</CardTitle>
            <p className="text-xs text-muted-foreground">{bucket.descripcion}</p>
          </div>
          <Badge variant="secondary">{bucket.count}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pt-2">
        {bucket.items.map((folio) => (
          <FolioRow key={folio.id} folio={folio} onOpen={() => onOpenFolio(folio.id)} />
        ))}
      </CardContent>
    </Card>
  );
}

function FolioRow({ folio, onOpen }: { folio: DashboardFolio; onOpen: () => void }) {
  const urg = URGENCIA_STYLES[folio.urgencia];
  return (
    <button
      onClick={onOpen}
      className={`w-full text-left rounded-md border-l-4 p-3 hover:bg-muted/50 transition-colors ${urg.border} ${urg.bg}`}
      data-testid={`folio-${folio.folio}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-xs font-semibold">{folio.folio}</span>
            {folio.urgencia !== "ok" && (
              <Badge variant="outline" className={`text-xs ${urg.color}`}>
                {urg.label}
              </Badge>
            )}
          </div>
          <p className="text-sm font-medium truncate">{folio.taxistaNombre || "(sin nombre capturado)"}</p>
          <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {folio.diasDesdeActualizacion === 0 ? "hoy" : `hace ${folio.diasDesdeActualizacion}d`}
            {" · "}
            <FileText className="h-3 w-3" />
            docs {folio.docsCapturados}
          </p>
          <p className="text-xs mt-2 font-medium">
            <ChevronRight className="inline h-3 w-3" />
            {folio.siguientePaso}
          </p>
        </div>
        <ChevronRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
      </div>
    </button>
  );
}
