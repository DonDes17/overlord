import { useCallback, useRef, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ConfirmationOptions {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  details?: ReactNode;
  destructive?: boolean;
}

const DEFAULT_OPTIONS: ConfirmationOptions = {
  title: "Are you sure?",
  description: "This action cannot be undone.",
  confirmLabel: "Confirm",
  cancelLabel: "Cancel",
};

export function useConfirmation() {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmationOptions>(DEFAULT_OPTIONS);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  const resolve = useCallback((confirmed: boolean) => {
    resolverRef.current?.(confirmed);
    resolverRef.current = null;
    setOpen(false);
  }, []);

  const confirm = useCallback((nextOptions: ConfirmationOptions) => {
    return new Promise<boolean>((promiseResolve) => {
      resolverRef.current = promiseResolve;
      setOptions({ ...DEFAULT_OPTIONS, ...nextOptions });
      setOpen(true);
    });
  }, []);

  const ConfirmationDialog = useCallback(() => {
    return (
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) resolve(false);
          else setOpen(true);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="overflow-hidden border-border/80 p-0 shadow-2xl sm:max-w-md"
        >
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-destructive via-primary to-warning" />
          <div className="p-5">
            <DialogHeader className="gap-3">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-destructive/20 bg-destructive/10 text-destructive">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <DialogTitle className="text-base">{options.title}</DialogTitle>
                  <DialogDescription className="mt-2 leading-relaxed">
                    {options.description}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            {options.details && (
              <div className="mt-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {options.details}
              </div>
            )}
          </div>

          <div className="flex flex-col-reverse gap-2 border-t bg-muted/30 px-5 py-4 sm:flex-row sm:justify-end">
            <Button variant="ghost" size="sm" onClick={() => resolve(false)}>
              {options.cancelLabel}
            </Button>
            <Button
              variant={options.destructive ? "destructive" : "default"}
              size="sm"
              onClick={() => resolve(true)}
            >
              {options.confirmLabel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }, [open, options, resolve]);

  return { confirm, ConfirmationDialog };
}
