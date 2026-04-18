import { useState, useEffect, useRef, useCallback } from "react";
import { Switch, Route, Router, Redirect } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { PinLogin } from "@/components/pin-login";
import { ErrorBoundary } from "@/components/error-boundary";
import { Wifi, WifiOff } from "lucide-react";
import EvaluatePage from "./pages/evaluate";
import CatalogPage from "./pages/catalog";
import InventarioPage from "./pages/inventario";
import OriginacionPage from "./pages/originacion";
import OriginacionFlowPage from "./pages/originacion-flow";
import PanelPage from "./pages/panel";
import EvaluacionesPage from "./pages/evaluaciones";
import PipelinePage from "./pages/pipeline";
import SandboxPage from "./pages/sandbox";
import NotFound from "./pages/not-found";
import ProspectFlowPage from "./pages/prospect-flow";

// ===== Director Router (full access) =====
function DirectorRouter() {
  return (
    <Switch>
      <Route path="/">
        <Redirect to="/evaluaciones" />
      </Route>
      {/* Compras */}
      <Route path="/motor" component={EvaluatePage} />
      <Route path="/motor/catalog" component={CatalogPage} />
      <Route path="/inventario" component={InventarioPage} />
      {/* Originación */}
      <Route path="/prospect" component={ProspectFlowPage} />
      <Route path="/originacion" component={OriginacionPage} />
      <Route path="/originacion/:id" component={OriginacionFlowPage} />
      <Route path="/evaluaciones" component={EvaluacionesPage} />
      {/* Ventas */}
      <Route path="/pipeline" component={PipelinePage} />
      {/* Cartera */}
      <Route path="/panel" component={PanelPage} />
      {/* Dev Tools */}
      <Route path="/sandbox">{() => <SandboxPage showDebug={false} />}</Route>
      <Route component={NotFound} />
    </Switch>
  );
}

// ===== Dev Router (everything + debug tools) =====
function DevRouter() {
  return (
    <Switch>
      <Route path="/">
        <Redirect to="/sandbox" />
      </Route>
      {/* All director routes */}
      <Route path="/motor" component={EvaluatePage} />
      <Route path="/motor/catalog" component={CatalogPage} />
      <Route path="/inventario" component={InventarioPage} />
      <Route path="/prospect" component={ProspectFlowPage} />
      <Route path="/originacion" component={OriginacionPage} />
      <Route path="/originacion/:id" component={OriginacionFlowPage} />
      <Route path="/evaluaciones" component={EvaluacionesPage} />
      <Route path="/pipeline" component={PipelinePage} />
      <Route path="/panel" component={PanelPage} />
      {/* Dev Tools */}
      <Route path="/sandbox">{() => <SandboxPage showDebug={true} />}</Route>
      <Route component={NotFound} />
    </Switch>
  );
}

// ===== Promotora Router (originación only) =====
function PromotoraRouter() {
  return (
    <Switch>
      <Route path="/">
        <Redirect to="/prospect" />
      </Route>
      <Route path="/prospect" component={ProspectFlowPage} />
      <Route path="/originacion" component={OriginacionPage} />
      <Route path="/originacion/:id" component={OriginacionFlowPage} />
      <Route>
        <Redirect to="/prospect" />
      </Route>
    </Switch>
  );
}

function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);
  return isOnline;
}

// ===== Director view (sidebar + full nav) =====
function DirectorApp({ promoter, onLogout, routerOverride }: {
  promoter: { id: number; name: string; role: string };
  onLogout: () => void;
  routerOverride?: React.ReactNode;
}) {
  const isOnline = useOnlineStatus();
  const sidebarStyle = {
    "--sidebar-width": "15rem",
    "--sidebar-width-icon": "3.5rem",
  };

  return (
    <Router hook={useHashLocation}>
      <SidebarProvider style={sidebarStyle as React.CSSProperties}>
        <div className="flex h-screen w-full">
          <AppSidebar promoterName={promoter.name} role={promoter.role} onLogout={onLogout} />
          <div className="flex flex-col flex-1 min-w-0">
            <header className="flex items-center h-11 sm:h-12 px-2 sm:px-3 border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-10">
              <SidebarTrigger data-testid="button-sidebar-toggle" />
              <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
                <div
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium ${
                    isOnline
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                      : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
                  }`}
                  data-testid="connectivity-badge"
                >
                  {isOnline ? (
                    <Wifi className="w-2.5 h-2.5" />
                  ) : (
                    <WifiOff className="w-2.5 h-2.5" />
                  )}
                  <span className="hidden sm:inline">{isOnline ? "En línea" : "Sin conexión"}</span>
                </div>
                <span className="text-[10px] text-muted-foreground hidden sm:inline">
                  {promoter.name} · Director
                </span>
              </div>
            </header>
            <main className="flex-1 overflow-y-auto">
              <ErrorBoundary>
                {routerOverride || <DirectorRouter />}
              </ErrorBoundary>
            </main>
          </div>
        </div>
      </SidebarProvider>
    </Router>
  );
}

// ===== Promotora view (no sidebar, just originación) =====
function PromotoraApp({ promoter, onLogout }: {
  promoter: { id: number; name: string; role: string };
  onLogout: () => void;
}) {
  const isOnline = useOnlineStatus();

  return (
    <Router hook={useHashLocation}>
      <div className="flex flex-col h-screen w-full">
        <header className="flex items-center h-11 sm:h-12 px-3 sm:px-4 border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-10">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
              <span className="text-xs font-bold text-primary-foreground">CMU</span>
            </div>
            <span className="text-sm font-semibold">Originación</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            <div
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium ${
                isOnline
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                  : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
              }`}
            >
              {isOnline ? <Wifi className="w-2.5 h-2.5" /> : <WifiOff className="w-2.5 h-2.5" />}
              <span className="hidden sm:inline">{isOnline ? "En línea" : "Sin conexión"}</span>
            </div>
            <span className="text-[10px] text-muted-foreground hidden sm:inline">
              {promoter.name}
            </span>
            <button
              onClick={onLogout}
              className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded"
              data-testid="button-logout"
            >
              Salir
            </button>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto">
          <ErrorBoundary>
            <PromotoraRouter />
          </ErrorBoundary>
        </main>
      </div>
    </Router>
  );
}

// ===== Idle timeout hook =====
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function useIdleTimeout(onTimeout: () => void, enabled: boolean) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  
  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(onTimeout, IDLE_TIMEOUT_MS);
  }, [onTimeout]);

  useEffect(() => {
    if (!enabled) return;
    
    const events = ["mousedown", "keydown", "touchstart", "scroll", "mousemove"];
    const handler = () => resetTimer();
    
    events.forEach((e) => window.addEventListener(e, handler, { passive: true }));
    resetTimer(); // Start the timer
    
    return () => {
      events.forEach((e) => window.removeEventListener(e, handler));
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, resetTimer]);
}

function App() {
  const [promoter, setPromoter] = useState<{ id: number; name: string; role: string } | null>(null);

  const handleLogin = (p: { id: number; name: string; role: string }) => {
    setPromoter(p);
  };

  const handleLogout = useCallback(() => {
    setPromoter(null);
  }, []);

  // Auto-logout after 30 min of inactivity
  useIdleTimeout(handleLogout, !!promoter);

  return (
    <ErrorBoundary>
      <TooltipProvider>
        <Toaster />
        {!promoter ? (
          <PinLogin onLogin={handleLogin} />
        ) : promoter.role === "dev" ? (
          <DirectorApp promoter={promoter} onLogout={handleLogout} routerOverride={<DevRouter />} />
        ) : promoter.role === "director" ? (
          <DirectorApp promoter={promoter} onLogout={handleLogout} />
        ) : (
          <PromotoraApp promoter={promoter} onLogout={handleLogout} />
        )}
      </TooltipProvider>
    </ErrorBoundary>
  );
}

export default App;
