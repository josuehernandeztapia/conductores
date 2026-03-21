import { useState, useEffect } from "react";
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
import NotFound from "./pages/not-found";

function AppRouter() {
  return (
    <Switch>
      <Route path="/">
        <Redirect to="/motor" />
      </Route>
      <Route path="/motor" component={EvaluatePage} />
      <Route path="/motor/catalog" component={CatalogPage} />
      <Route path="/originacion" component={OriginacionPage} />
      <Route path="/originacion/:id" component={OriginacionFlowPage} />
      <Route path="/inventario" component={InventarioPage} />
      <Route path="/panel" component={PanelPage} />
      <Route component={NotFound} />
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

function AuthenticatedApp({ promoter, onLogout }: { 
  promoter: { id: number; name: string }; 
  onLogout: () => void;
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
          <AppSidebar promoterName={promoter.name} onLogout={onLogout} />
          <div className="flex flex-col flex-1 min-w-0">
            <header className="flex items-center h-11 sm:h-12 px-2 sm:px-3 border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-10">
              <SidebarTrigger data-testid="button-sidebar-toggle" />
              <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
                {/* Connectivity indicator */}
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
                  {promoter.name} · Aguascalientes
                </span>
              </div>
            </header>
            <main className="flex-1 overflow-y-auto">
              <ErrorBoundary>
                <AppRouter />
              </ErrorBoundary>
            </main>
          </div>
        </div>
      </SidebarProvider>
    </Router>
  );
}

function App() {
  const [promoter, setPromoter] = useState<{ id: number; name: string } | null>(null);

  const handleLogin = (p: { id: number; name: string }) => {
    setPromoter(p);
  };

  const handleLogout = () => {
    setPromoter(null);
  };

  return (
    <ErrorBoundary>
      <TooltipProvider>
        <Toaster />
        {promoter ? (
          <AuthenticatedApp promoter={promoter} onLogout={handleLogout} />
        ) : (
          <PinLogin onLogin={handleLogin} />
        )}
      </TooltipProvider>
    </ErrorBoundary>
  );
}

export default App;
