import { Car, FileText, Warehouse, LayoutDashboard, LogOut, ClipboardCheck, Users } from "lucide-react";
import { Link, useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { PerplexityAttribution } from "@/components/PerplexityAttribution";

const navGroups = [
  {
    label: "Compras",
    items: [
      { title: "Motor CMU", url: "/motor", icon: Car, description: "Decisión de compra" },
      { title: "Inventario", url: "/inventario", icon: Warehouse, description: "Vehículos en flota" },
    ],
  },
  {
    label: "Originación",
    items: [
      { title: "Folios", url: "/originacion", icon: FileText, description: "Alta de taxistas" },
      { title: "Evaluaciones", url: "/evaluaciones", icon: ClipboardCheck, description: "Scoring entrevistas" },
    ],
  },
  {
    label: "Ventas",
    items: [
      { title: "Pipeline", url: "/pipeline", icon: Users, description: "Prospectos por canal" },
    ],
  },
  {
    label: "Cartera",
    items: [
      { title: "Panel CMU", url: "/panel", icon: LayoutDashboard, description: "Créditos y cobranza" },
    ],
  },
];

export function AppSidebar({ promoterName, role, onLogout }: { promoterName: string; role: string; onLogout: () => void }) {
  const [location] = useLocation();

  return (
    <Sidebar>
      <SidebarHeader className="p-4 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center flex-shrink-0">
            <Car className="w-5 h-5 text-primary-foreground" />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="font-semibold text-sm text-sidebar-foreground truncate">
              CMU Plataforma
            </span>
            <span className="text-[10px] text-muted-foreground truncate">
              Conductores del Mundo
            </span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {navGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const isActive = location === item.url || 
                    (item.url !== "/" && location.startsWith(item.url));
                  return (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive}
                        tooltip={item.description}
                      >
                        <Link href={item.url}>
                          <item.icon />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="p-3 border-t border-sidebar-border">
        <div className="flex items-center justify-between">
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-medium text-sidebar-foreground truncate">
              {promoterName}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {role === "director" ? "Director" : "Promotora"}
            </span>
          </div>
          <button
            onClick={onLogout}
            className="p-1.5 rounded-md hover:bg-sidebar-accent text-muted-foreground hover:text-sidebar-foreground transition-colors"
            data-testid="button-logout"
            title="Cerrar sesión"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
        <div className="mt-2 pt-2 border-t border-sidebar-border">
          <PerplexityAttribution />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
