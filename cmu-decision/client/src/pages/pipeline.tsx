/**
 * Pipeline de Ventas — Vista Director
 * 
 * Embudo visual por status + filtro por canal + lista de prospectos
 * Solo visible para director.
 */

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Users,
  TrendingUp,
  Clock,
  AlertTriangle,
  RefreshCw,
  Loader2,
  QrCode,
  Phone,
  Fuel,
  FileText,
  CheckCircle2,
  ChevronRight,
  Copy,
  Search,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API_BASE = "";

interface Prospect {
  id: number;
  phone: string;
  nombre: string | null;
  canal_origen: string;
  status: string;
  fuel_type: string | null;
  consumo_mensual: number | null;
  ahorro_estimado: number | null;
  diferencial_estimado: number | null;
  folio_id: string | null;
  docs_completados: number;
  docs_total: number;
  evaluacion_decision: string | null;
  ultimo_contacto: string;
  created_at: string;
}

interface Canal {
  id: number;
  codigo: string;
  nombre: string;
  tipo: string;
  prospectos_count: number;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  curioso: { label: "Curioso", color: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300", icon: Users },
  interesado: { label: "Interesado", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400", icon: TrendingUp },
  registrado: { label: "Registrado", color: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-400", icon: FileText },
  docs_parcial: { label: "Docs parcial", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400", icon: Clock },
  docs_completo: { label: "Docs completo", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400", icon: CheckCircle2 },
  evaluado: { label: "Evaluado", color: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400", icon: CheckCircle2 },
  en_espera: { label: "En espera", color: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-400", icon: CheckCircle2 },
};

const FUNNEL_ORDER = ["curioso", "interesado", "registrado", "docs_parcial", "docs_completo", "evaluado", "en_espera"];

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("es-MX", { day: "numeric", month: "short" });
}

function daysAgo(d: string) {
  return Math.floor((Date.now() - new Date(d).getTime()) / (1000 * 60 * 60 * 24));
}

export default function PipelinePage() {
  const [stats, setStats] = useState<any>(null);
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [canales, setCanales] = useState<Canal[]>([]);
  const [loading, setLoading] = useState(true);
  const [canalFilter, setCanalFilter] = useState("todos");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [searchQuery, setSearchQuery] = useState("");
  const [qrLink, setQrLink] = useState<string | null>(null);
  const { toast } = useToast();

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [statsRes, listRes, canalesRes] = await Promise.all([
        fetch(`${API_BASE}/api/pipeline/stats`).then(r => r.json()),
        fetch(`${API_BASE}/api/pipeline/list?limit=200`).then(r => r.json()),
        fetch(`${API_BASE}/api/pipeline/canales`).then(r => r.json()),
      ]);
      if (statsRes.success) setStats(statsRes);
      if (listRes.success) setProspects(listRes.prospects);
      if (canalesRes.success) setCanales(canalesRes.canales);
    } catch (err) {
      console.error("Pipeline fetch error:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, []);

  const getQRLink = async (canalCode: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/pipeline/qr/${canalCode}`).then(r => r.json());
      if (res.success) {
        setQrLink(res.whatsapp_link);
        navigator.clipboard?.writeText(res.whatsapp_link);
        toast({ title: "Link copiado", description: `QR link para ${canalCode} copiado al portapapeles` });
      }
    } catch (err) {
      console.error(err);
    }
  };

  const filtered = prospects.filter(p => {
    if (canalFilter !== "todos" && p.canal_origen !== canalFilter) return false;
    if (statusFilter !== "todos" && p.status !== statusFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const text = `${p.nombre || ""} ${p.phone} ${p.folio_id || ""} ${p.canal_origen}`.toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  });

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Pipeline de Ventas</h1>
          <p className="text-xs text-muted-foreground">{stats?.total || 0} prospectos totales</p>
        </div>
        <Button variant="ghost" size="sm" onClick={fetchAll}>
          <RefreshCw className="w-4 h-4 mr-1" />
          Actualizar
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-primary">{stats?.total || 0}</p>
            <p className="text-[10px] text-muted-foreground">Total Prospectos</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-emerald-600">{stats?.by_status?.docs_completo || 0}</p>
            <p className="text-[10px] text-muted-foreground">Expediente Completo</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-amber-600">{(stats?.stale_3d || 0) + (stats?.stale_5d || 0) + (stats?.stale_7d || 0)}</p>
            <p className="text-[10px] text-muted-foreground">Sin Seguimiento</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-blue-600">{canales.length}</p>
            <p className="text-[10px] text-muted-foreground">Canales Activos</p>
          </CardContent>
        </Card>
      </div>

      {/* Funnel */}
      <Card>
        <div className="px-4 py-3 bg-muted/30 border-b">
          <h3 className="text-sm font-semibold">Embudo de Conversión</h3>
        </div>
        <CardContent className="p-4">
          <div className="space-y-2">
            {FUNNEL_ORDER.map((status, i) => {
              const count = stats?.by_status?.[status] || 0;
              const total = stats?.total || 1;
              const pct = Math.round((count / total) * 100);
              const cfg = STATUS_CONFIG[status] || { label: status, color: "bg-gray-100", icon: Users };
              const Icon = cfg.icon;
              const maxWidth = i === 0 ? 100 : Math.max(20, pct);
              return (
                <div key={status} className="flex items-center gap-3">
                  <div className="w-24 flex items-center gap-1.5">
                    <Icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="text-[10px] text-muted-foreground truncate">{cfg.label}</span>
                  </div>
                  <div className="flex-1 h-6 bg-muted/50 rounded overflow-hidden relative">
                    <div
                      className={`h-full rounded transition-all duration-500 ${cfg.color} flex items-center px-2`}
                      style={{ width: `${maxWidth}%` }}
                    >
                      {count > 0 && (
                        <span className="text-[10px] font-bold">{count}</span>
                      )}
                    </div>
                  </div>
                  <span className="text-[10px] text-muted-foreground w-8 text-right">{pct}%</span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Canales */}
      <Card>
        <div className="px-4 py-3 bg-muted/30 border-b flex items-center justify-between">
          <h3 className="text-sm font-semibold">Canales de Adquisición</h3>
        </div>
        <CardContent className="p-4 space-y-2">
          {canales.map(c => (
            <div key={c.id} className="flex items-center gap-3 p-2 rounded bg-muted/30">
              <Badge variant="outline" className="text-[10px]">{c.tipo}</Badge>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{c.nombre}</p>
                <p className="text-[10px] text-muted-foreground">{c.prospectos_count} prospectos</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-[10px] gap-1"
                onClick={() => getQRLink(c.codigo)}
                data-testid={`button-qr-${c.codigo}`}
              >
                <QrCode className="w-3.5 h-3.5" />
                QR Link
              </Button>
            </div>
          ))}
          {qrLink && (
            <div className="mt-2 p-2 bg-muted/50 rounded text-[10px] break-all">
              <div className="flex items-center gap-1 mb-1">
                <Copy className="w-3 h-3" />
                <span className="font-medium">Link para QR (copiado):</span>
              </div>
              <a href={qrLink} target="_blank" rel="noopener" className="text-blue-600 underline">{qrLink}</a>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Filters + List */}
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-[150px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar nombre, teléfono, folio..."
              className="pl-8 h-8 text-xs"
            />
          </div>
          <Select value={canalFilter} onValueChange={setCanalFilter}>
            <SelectTrigger className="w-[130px] h-8 text-xs">
              <SelectValue placeholder="Canal" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos los canales</SelectItem>
              {canales.map(c => (
                <SelectItem key={c.codigo} value={c.codigo}>{c.codigo}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[130px] h-8 text-xs">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos</SelectItem>
              {FUNNEL_ORDER.map(s => (
                <SelectItem key={s} value={s}>{STATUS_CONFIG[s]?.label || s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <p className="text-[10px] text-muted-foreground">{filtered.length} prospectos</p>

        {filtered.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No hay prospectos aún.</p>
              <p className="text-xs mt-1">Aparecerán cuando un taxista escanee el QR o escriba al WhatsApp.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {filtered.map(p => {
              const cfg = STATUS_CONFIG[p.status] || STATUS_CONFIG.curioso;
              const days = daysAgo(p.ultimo_contacto);
              const isStale = days >= 3 && !["docs_completo", "evaluado", "en_espera"].includes(p.status);
              return (
                <Card key={p.id} className={isStale ? "border-amber-300 dark:border-amber-700" : ""}>
                  <CardContent className="p-3 flex items-center gap-3">
                    <Badge className={`text-[9px] px-2 py-0.5 ${cfg.color}`}>
                      {cfg.label}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium truncate">
                          {p.nombre || p.phone}
                        </p>
                        {isStale && (
                          <Badge variant="destructive" className="text-[8px] px-1 py-0 h-3.5">
                            {days}d
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span>{p.canal_origen}</span>
                        {p.fuel_type && (
                          <>
                            <span>·</span>
                            <Fuel className="w-3 h-3 inline" />
                            <span>{p.fuel_type === "gnv" ? "GNV" : "Gasolina"} {p.consumo_mensual ? `${p.consumo_mensual} LEQ/mes` : ""}</span>
                          </>
                        )}
                        {p.ahorro_estimado && (
                          <>
                            <span>·</span>
                            <span className="text-emerald-600">Ahorro ${p.ahorro_estimado.toLocaleString()}</span>
                          </>
                        )}
                        {p.folio_id && (
                          <>
                            <span>·</span>
                            <span className="font-mono">{p.folio_id}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="text-right text-[10px] text-muted-foreground flex-shrink-0">
                      <p>{fmtDate(p.created_at)}</p>
                      {p.docs_completados > 0 && (
                        <p className="text-emerald-600">{p.docs_completados}/{p.docs_total} docs</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
