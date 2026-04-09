import { useState, useRef, type ChangeEvent, type DragEvent } from "react";
import { api } from "../api/client";
import { Icon } from "../components/Icon";
import { UrlImportForm } from "../components/UrlImportForm";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface ExtractedItem {
  partNumber: string;
  partName: string;
  quantity: number;
  unitPrice: number | null;
  shipCost: number | null;
  taxPrice: number | null;
  brand: string | null;
}

interface ParseResult {
  vendor: string;
  orderNumber: string | null;
  orderDate: string | null;
  technicianName: string | null;
  trackingNumber: string | null;
  deliveryCourier: string | null;
  items: ExtractedItem[];
  rawText: string;
}

function fmt(v: number | null): string {
  return v != null ? `$${v.toFixed(2)}` : "-";
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value && value !== "") return null;
  return (
    <tr>
      <td className="pr-4 py-1 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap align-top">{label}</td>
      <td className="py-1 text-sm text-gray-900 dark:text-gray-100 break-words">{value || "-"}</td>
    </tr>
  );
}

export function ImportDocument() {
  const [result, setResult] = useState<ParseResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState<"pdf" | "url">("pdf");
  const dragCounter = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  async function processFile(file: File) {
    setError("");
    setParsing(true);
    setResult(null);
    try {
      const base64 = await fileToBase64(file);
      const data = await api<ParseResult>("/api/parts/import", {
        method: "POST",
        body: JSON.stringify({ document: base64 }),
      });
      setResult(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to parse document");
    } finally {
      setParsing(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }

  function onDragEnter(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) setDragging(true);
  }
  function onDragOver(e: DragEvent) { e.preventDefault(); e.stopPropagation(); }
  function onDragLeave(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setDragging(false);
    const file = Array.from(e.dataTransfer.files).find(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")
    );
    if (file) processFile(file);
  }

  function reset() {
    setResult(null);
    setError("");
  }

  return (
    <div className="pt-4">
      <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Import Document
      </h1>

      <div className="flex gap-1 mb-4 p-0.5 rounded-lg bg-gray-100 dark:bg-gray-800">
        <button
          type="button"
          onClick={() => { setTab("pdf"); reset(); }}
          className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            tab === "pdf"
              ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
              : "text-gray-500 dark:text-gray-400"
          }`}
        >
          PDF Upload
        </button>
        <button
          type="button"
          onClick={() => { setTab("url"); reset(); }}
          className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            tab === "url"
              ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
              : "text-gray-500 dark:text-gray-400"
          }`}
        >
          URL Import
        </button>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {tab === "pdf" && !result && (
        <>
          {parsing ? (
            <div className="flex items-center justify-center gap-2 px-4 py-10 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 text-sm text-gray-500 dark:text-gray-400">
              <Icon name="hourglass_top" size={18} className="animate-spin" />
              Parsing document...
            </div>
          ) : (
            <label
              onDragEnter={onDragEnter}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              className={`flex flex-col items-center justify-center gap-2 px-4 py-10 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
                dragging
                  ? "border-gray-900 dark:border-gray-100 bg-gray-50 dark:bg-gray-800"
                  : "border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500"
              }`}
            >
              <Icon name="upload_file" size={32} className="text-gray-400 dark:text-gray-500" />
              <span className="text-sm text-gray-600 dark:text-gray-300">
                Select a PDF document
              </span>
              <input
                ref={inputRef}
                type="file"
                accept=".pdf,application/pdf"
                className="sr-only"
                onChange={handleFile}
              />
            </label>
          )}
        </>
      )}

      {tab === "url" && !result && (
        <UrlImportForm
          onResult={setResult}
          onError={setError}
          onReset={reset}
        />
      )}

      {result && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {result.items.length} item{result.items.length !== 1 ? "s" : ""} extracted
            </span>
            <button
              type="button"
              onClick={reset}
              className="p-2 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              title="Upload different document"
            >
              <Icon name="refresh" size={18} />
            </button>
          </div>

          {result.items.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No items found in this document.
            </p>
          )}

          {result.items.map((item, i) => (
            <table key={i} className="w-full border-collapse">
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {result.items.length > 1 && (
                  <tr>
                    <td colSpan={2} className="py-1 text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">
                      Item {i + 1}
                    </td>
                  </tr>
                )}
                <Row label="Technician" value={result.technicianName} />
                <Row label="Part Name" value={item.partName} />
                <Row label="Part Number" value={item.partNumber || "-"} />
                <Row label="Brand" value={item.brand} />
                <Row label="Unit Price" value={fmt(item.unitPrice)} />
                <Row label="Ship Cost" value={fmt(item.shipCost)} />
                <Row label="Tax" value={fmt(item.taxPrice)} />
                <Row label="Total" value={fmt(
                  (item.unitPrice ?? 0) + (item.shipCost ?? 0) + (item.taxPrice ?? 0)
                )} />
                <Row label="Quantity" value={String(item.quantity)} />
                <Row label="Order Number" value={result.orderNumber} />
                <Row label="Tracking" value={result.trackingNumber} />
                <Row label="Courier" value={result.deliveryCourier} />
                <Row label="Order Date" value={result.orderDate} />
                <Row label="Vendor" value={result.vendor} />
              </tbody>
            </table>
          ))}

          <details className="text-xs">
            <summary className="text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">
              Raw text
            </summary>
            <pre className="mt-2 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
              {result.rawText}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
