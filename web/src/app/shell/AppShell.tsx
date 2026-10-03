import { useState, type CSSProperties, type ReactNode } from "react";
import { useLocation } from "react-router";
import { useTranslations } from "use-intl";

import { signOut } from "../../platform/session/api";
import type { Role } from "../../platform/session/session-user";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from "../../platform/ui/shadcn/breadcrumb";
import { Separator } from "../../platform/ui/shadcn/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "../../platform/ui/shadcn/sidebar";
import { Toaster } from "../../platform/ui/shadcn/sonner";
import { TooltipProvider } from "../../platform/ui/shadcn/tooltip";
import { AppSidebar } from "./AppSidebar";
import { CommandPalette } from "./CommandPalette";
import { areaForPath, navigationItemForPath } from "./navigation";

const SIDEBAR_WIDTH = "234px";

// Shared with viewport-filling content to keep scrolling inside the shell.
const SHELL_HEADER_HEIGHT = "3.5rem";

type AppShellProps = {
  userName: string;
  role: Role;
  onSignedOut: () => void;
  children: ReactNode;
};

export function AppShell({ userName, role, onSignedOut, children }: AppShellProps) {
  const t = useTranslations();
  const [searchOpen, setSearchOpen] = useState(false);
  const { pathname } = useLocation();

  const activeItem = navigationItemForPath(pathname);

  const area = areaForPath(pathname);

  // Refresh session state even when the sign-out request fails.
  const handleSignOut = () => {
    void signOut().finally(onSignedOut);
  };

  return (
    // Cover header and content tooltips as well as the sidebar.
    <TooltipProvider>
      <SidebarProvider
        data-area={area}
        style={{ "--sidebar-width": SIDEBAR_WIDTH, "--shell-header-height": SHELL_HEADER_HEIGHT } as CSSProperties}
      >
        <AppSidebar
          userName={userName}
          role={role}
          onSearch={() => setSearchOpen(true)}
          onSignOut={handleSignOut}
        />
        <SidebarInset className="min-w-0">
          <header className="flex h-(--shell-header-height) shrink-0 items-center gap-2 border-b border-border px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                {/* Keep the app title visible when it is the only breadcrumb. */}
                <BreadcrumbItem className={activeItem === undefined ? undefined : "hidden md:block"}>
                  {t("appTitle")}
                </BreadcrumbItem>
                {activeItem !== undefined && (
                  <>
                    <BreadcrumbSeparator className="hidden md:block" />
                    <BreadcrumbItem>
                      <BreadcrumbPage>{t(activeItem.labelKey)}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </>
                )}
              </BreadcrumbList>
            </Breadcrumb>
          </header>
          <div className="min-w-0 flex-1">{children}</div>
        </SidebarInset>
        <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
      </SidebarProvider>

      <Toaster />
    </TooltipProvider>
  );
}

// Children provide the main landmark.
export function PlainShell({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <div className="flex min-h-svh w-full items-center justify-center bg-background font-sans text-foreground">
        {children}
      </div>
    </TooltipProvider>
  );
}
