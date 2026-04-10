import { useState, useRef, type ChangeEvent, type DragEvent } from "react";
import { getAccessToken, refreshAccessToken, api } from "../api/client";
import { Icon } from "../components/Icon";
import { UrlImportForm } from "../components/UrlImportForm";
import { useSettings } from "../hooks/useSettings";

const EXTRACTION_MODELS = [
  { id: "qwen/qwen3.5-9b", label: "Qwen 9B", description: "Cheapest" },
  { id: "qwen/qwen3.5-flash-02-23", label: "Qwen Flash", description: "Faster, smarter" },
] as const;

const TEMPLATE_MODELS = [
  { id: "qwen/qwen3.5-flash-02-23", label: "Qwen Flash", description: "Faster, cheaper" },
  { id: "qwen/qwen3.5-35b-a3b", label: "Qwen 35B", description: "Smarter, 4x cost" },
] as const;

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

interface StepEntry {
  step: string;
  message: string;
  status: "active" | "done";
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
  const { settings, setSettings } = useSettings();
  const [result, setResult] = useState<ParseResult | null>(null);
  const [steps, setSteps] = useState<StepEntry[]>([]);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState<"pdf" | "url">("pdf");
  const dragCounter = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const extractionModel = settings?.extractionModel ?? "qwen/qwen3.5-flash-02-23";
  const templateModel = settings?.templateModel ?? "qwen/qwen3.5-flash-02-23";

  function handleSettingChange(key: string, value: string) {
    if (!settings) return;
    const prev = { ...settings };
    setSettings({ ...settings, [key]: value });
    api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ [key]: value }),
    }).catch(() => {
      setSettings(prev);
    });
  }

  async function processFile(file: File) {
    setError("");
    setParsing(true);
    setResult(null);
    setSteps([]);

    try {
      const base64 = await fileToBase64(file);
      const body = JSON.stringify({ document: base64, extractionModel, templateModel });

      async function doRequest(token: string): Promise<Response> {
        return fetch("/api/parts/import", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body,
        });
      }

      let token = getAccessToken();
      if (!token) throw new Error("Not authenticated");

      let response = await doRequest(token);

      if (response.status === 401) {
        const newToken = await refreshAccessToken();
        if (!newToken) throw new Error("Session expired");
        response = await doRequest(newToken);
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Import failed" }));
        throw new Error(err.error || `HTTP ${response.status}`);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split("\n\n");
        buffer = chunks.pop()!;

        for (const chunk of chunks) {
          if (!chunk.trim()) continue;
          const typeMatch = chunk.match(/^event:\s*(\w+)/m);
          const dataMatch = chunk.match(/^data:\s*(.+)$/m);
          if (!typeMatch || !dataMatch) continue;

          const eventType = typeMatch[1];
          const data = JSON.parse(dataMatch[1]);

          if (eventType === "step") {
            setSteps((prev) => {
              const updated = prev.map((s) =>
                s.status === "active" ? { ...s, status: "done" as const } : s
              );
              return [...updated, { step: data.step, message: data.message, status: "active" as const }];
            });
          } else if (eventType === "result") {
            setSteps((prev) => prev.map((s) => ({ ...s, status: "done" as const })));
            setResult(data as ParseResult);
          } else if (eventType === "error") {
            throw new Error(data.error);
          }
        }
      }
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
    setSteps([]);
    setError("");
  }

  const showPdfUpload = tab === "pdf" && !result && !parsing && steps.length === 0;

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

      {/* Model pickers */}
      {tab === "pdf" && !result && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 dark:text-gray-400">Extraction:</span>
            <select
              value={extractionModel}
              onChange={(e) => handleSettingChange("extractionModel", e.target.value)}
              className="text-xs px-2 py-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400"
            >
              {EXTRACTION_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} -- {m.description}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 dark:text-gray-400">Template:</span>
            <select
              value={templateModel}
              onChange={(e) => handleSettingChange("templateModel", e.target.value)}
              className="text-xs px-2 py-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400"
            >
              {TEMPLATE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} -- {m.description}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {tab === "pdf" && steps.length > 0 && (
        <div className="mb-4 space-y-1">
          {steps.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
              {s.status === "active" ? (
                <Icon name="hourglass_top" size={14} className="animate-spin text-gray-400" />
              ) : (
                <Icon name="check_circle" size={14} className="text-green-500" />
              )}
              <span>{s.message}</span>
            </div>
          ))}
        </div>
      )}

      {showPdfUpload && (
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
