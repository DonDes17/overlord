import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useApi } from "../hooks/useApi.js";
import type { Project, WorkspaceInfo, WorkspacePackage } from "../types.js";
import { Box, Layers, Package } from "lucide-react";

interface Props {
  project: Project;
}

const CATEGORY_CONFIG = {
  app: { label: "Apps", icon: Box, color: "text-primary" },
  package: { label: "Packages", icon: Package, color: "text-muted-foreground" },
  other: { label: "Other", icon: Layers, color: "text-muted-foreground" },
};

function PackageCard({ pkg }: { pkg: WorkspacePackage }) {
  const config = CATEGORY_CONFIG[pkg.category];
  const Icon = config.icon;

  return (
    <Card className="group hover:border-primary/30 transition-colors">
      <CardContent className="flex items-start gap-3 py-3 px-4">
        <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", config.color)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{pkg.name}</span>
            {pkg.packageJson?.version && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                {pkg.packageJson.version}
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground font-mono mt-0.5">
            {pkg.path}
          </div>
          {pkg.packageJson?.description && (
            <p className="text-xs text-muted-foreground mt-1 truncate">
              {pkg.packageJson.description}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function WorkspacesTab({ project }: Props) {
  const { data, loading } = useApi<WorkspaceInfo>(
    `/projects/${project.id}/workspaces`
  );

  if (loading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Detection des workspaces...</div>
    );
  }

  if (!data || !data.type) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16">
        <Layers className="h-8 w-8 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          This project is not a monorepo.
        </p>
        <p className="text-xs text-muted-foreground/60">
          Supporte: pnpm workspaces, yarn workspaces, npm workspaces, nx, lerna
        </p>
      </div>
    );
  }

  const apps = data.packages.filter((p) => p.category === "app");
  const packages = data.packages.filter((p) => p.category === "package");
  const others = data.packages.filter((p) => p.category === "other");

  return (
    <div className="flex max-w-3xl flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Badge variant="outline" className="text-xs">
          {data.type}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {data.packages.length} workspace{data.packages.length > 1 ? "s" : ""}
        </span>
      </div>

      {/* Apps */}
      {apps.length > 0 && (
        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Box className="h-3 w-3" />
            Apps ({apps.length})
          </h3>
          <div className="flex flex-col gap-2">
            {apps.map((pkg) => (
              <PackageCard key={pkg.path} pkg={pkg} />
            ))}
          </div>
        </div>
      )}

      {/* Packages */}
      {packages.length > 0 && (
        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Package className="h-3 w-3" />
            Packages ({packages.length})
          </h3>
          <div className="flex flex-col gap-2">
            {packages.map((pkg) => (
              <PackageCard key={pkg.path} pkg={pkg} />
            ))}
          </div>
        </div>
      )}

      {/* Others */}
      {others.length > 0 && (
        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Layers className="h-3 w-3" />
            Autres ({others.length})
          </h3>
          <div className="flex flex-col gap-2">
            {others.map((pkg) => (
              <PackageCard key={pkg.path} pkg={pkg} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
