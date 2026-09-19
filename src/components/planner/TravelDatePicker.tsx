import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker } from "react-day-picker";
import { zhCN } from "react-day-picker/locale";
import "react-day-picker/style.css";
import { cn } from "@/lib/utils";

function parseDateValue(value: string) {
  return new Date(`${value}T12:00:00`);
}

function toDateValue(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function formatDisplayDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(parseDateValue(value));
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
  }).format(parseDateValue(value));
}

export function TravelDatePicker({
  value,
  min,
  max,
  onChange,
}: {
  value: string;
  min: string;
  max: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = parseDateValue(value);
  const minDate = parseDateValue(min);
  const maxDate = parseDateValue(max);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={cn("travel-date-trigger", open && "is-open")}>
          <span className="travel-date-icon">
            <CalendarDays className="size-4" />
          </span>
          <span className="travel-date-copy">
            <strong>{formatDisplayDate(value)}</strong>
          </span>
          <ChevronRight className="travel-date-chevron size-4" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="travel-calendar-popover"
          sideOffset={10}
          align="start"
          collisionPadding={12}
        >
          <DayPicker
            mode="single"
            selected={selected}
            onSelect={(date) => {
              if (!date) return;
              onChange(toDateValue(date));
              setOpen(false);
            }}
            locale={zhCN}
            weekStartsOn={1}
            showOutsideDays
            fixedWeeks
            disabled={[{ before: minDate }, { after: maxDate }]}
            startMonth={minDate}
            endMonth={maxDate}
            components={{
              Chevron: ({ orientation }) =>
                orientation === "left" ? (
                  <ChevronLeft className="size-4" />
                ) : (
                  <ChevronRight className="size-4" />
                ),
            }}
          />
          <div className="travel-calendar-foot">
            <span>可选日期</span>
            <strong>{formatShortDate(min)} – {formatShortDate(max)}</strong>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}