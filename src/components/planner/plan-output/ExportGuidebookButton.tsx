import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Download, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { TripPlan } from "@/lib/travel-plan";
import { exportGuidebook } from "@/lib/travel-plan.functions";

type ExportGuidebookButtonProps = {
  plan: TripPlan;
};

function downloadUrl(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function base64ToPdf(base64: string): Blob {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: "application/pdf" });
}

function openPrintableHtml(html: string, htmlFilename: string) {
  const printWindow = window.open("", "_blank");
  if (printWindow) {
    printWindow.opener = null;
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.addEventListener(
      "load",
      () => {
        printWindow.focus();
        printWindow.print();
      },
      { once: true },
    );
    return;
  }

  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  downloadUrl(url, htmlFilename);
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  toast.info("浏览器拦截了打印页，已改为下载可打印 HTML。");
}

export function ExportGuidebookButton({ plan }: ExportGuidebookButtonProps) {
  const exportGuidebookFn = useServerFn(exportGuidebook);
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const result = await exportGuidebookFn({ data: { plan } });

      if (result.status === "ok") {
        const url = URL.createObjectURL(base64ToPdf(result.pdfBase64));
        downloadUrl(url, result.filename);
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
        toast.success("路书 PDF 已开始下载");
        return;
      }

      toast.info(result.message);
      const routeName = plan.meta.title.trim() || plan.meta.destination.trim() || "旅行路书";
      openPrintableHtml(result.html, `${routeName}_guidebook.html`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "路书导出失败，请稍后重试。");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={exporting}
      onClick={() => void handleExport()}
    >
      {exporting ? (
        <LoaderCircle className="size-4 animate-spin" />
      ) : (
        <Download className="size-4" />
      )}
      {exporting ? "正在生成" : "导出路书"}
    </Button>
  );
}
