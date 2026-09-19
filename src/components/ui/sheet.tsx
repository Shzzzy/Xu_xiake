import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const Sheet = Dialog.Root;
export const SheetTrigger = Dialog.Trigger;
export const SheetClose = Dialog.Close;

export function SheetContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--v-overlay)] backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out" />
      <Dialog.Content
        className={cn(
          "fixed inset-y-0 right-0 z-50 w-[min(92vw,28rem)] overflow-y-auto border-l border-[var(--v-line)] bg-[var(--v-paper)] p-6 shadow-2xl outline-none",
          className,
        )}
      >
        {children}
        <Dialog.Close className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full border border-[var(--v-line)] text-[var(--v-muted)] hover:bg-[var(--v-soft)] hover:text-[var(--v-ink)]">
          <X className="size-4" />
          <span className="sr-only">关闭</span>
        </Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  );
}
