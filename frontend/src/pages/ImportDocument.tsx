import { useState, useRef, type ChangeEvent, type DragEvent } from "react";
import { api } from "../api/client";
import { Icon } from "../components/Icon";

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
  description: string;
  quantity: number;
  unitPrice: number | null;
  brand: string | null;
}

interface ParseResult {
  vendor: string;
  orderNumber: string | null;
  orderDate: string | null;
  items: ExtractedItem[];
  rawText: string;
}

export function ImportDocument() {
  const [result, setResult] = useState<ParseResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
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
  function onDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }
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

      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Upload an order PDF (Amazon, eBay, Marcone) to preview extracted parts.
        Nothing is saved — this is for testing.
      </p>

      {error && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {!result && (
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
                {dragging ? "Drop PDF here" : "Select or drag and drop a PDF"}
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

      {result && (
        <div className="space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300">
              {result.vendor && (
                <span className="font-medium capitalize">{result.vendor}</span>
              )}
              {result.orderNumber && (
                <span className="text-gray-500 dark:text-gray-400">
                  {" "}#{result.orderNumber}
                </span>
              )}
              {result.orderDate && (
                <span className="text-gray-500 dark:text-gray-400">
                  {" "}&mdash; {result.orderDate}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={reset}
              className="ml-2 p-2 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              title="Upload different document"
            >
              <Icon name="refresh" size={18} />
            </button>
          </div>

          {/* Items */}
          <div className="space-y-2">
            {result.items.length === 0 && (
              <div className="px-3 py-4 text-center text-sm text-gray-500 dark:text-gray-400">
                No items extracted from this document.
              </div>
            )}
            {result.items.map((item, i) => (
              <div
                key={i}
                className="px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
              >
                <div className="flex items-start gap-2">
                  <Icon name="label" size={18} className="text-gray-400 dark:text-gray-500 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {item.partNumber || "(no part number)"}
                      </span>
                      {item.brand && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                          {item.brand}
                        </span>
                      )}
                      {item.quantity > 1 && (
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          x{item.quantity}
                        </span>
                      )}
                      {item.unitPrice != null && (
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          ${item.unitPrice.toFixed(2)}
                        </span>
                      )}
                    </div>
                    {item.description && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {item.description}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Raw text (collapsed) */}
          <details className="text-xs">
            <summary className="text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">
              Raw extracted text
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
