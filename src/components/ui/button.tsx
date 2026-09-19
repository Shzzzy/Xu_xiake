import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 border text-sm font-medium transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v-accent)]/40 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "border-[var(--v-accent)] bg-[var(--v-accent)] text-[var(--v-accent-ink)] hover:brightness-110",
        outline:
          "border-[var(--v-line)] bg-[var(--v-surface)] text-[var(--v-ink)] hover:border-[var(--v-accent)] hover:text-[var(--v-accent)]",
        ghost: "border-transparent bg-transparent text-[var(--v-muted)] hover:bg-[var(--v-soft)] hover:text-[var(--v-ink)]",
        seal: "border-[var(--v-seal)] bg-[var(--v-seal)] text-white shadow-[3px_3px_0_var(--v-ink)] hover:-translate-y-0.5",
      },
      size: {
        default: "h-11 rounded-[var(--v-button-radius)] px-5",
        sm: "h-9 rounded-[var(--v-button-radius)] px-3 text-xs",
        lg: "h-13 rounded-[var(--v-button-radius)] px-7 text-base",
        icon: "size-10 rounded-full p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}



