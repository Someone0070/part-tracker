import { useState, useRef, useCallback, type ChangeEvent, type DragEvent } from "react";
import { api } from "../api/client";
import { Icon } from "../components/Icon";
import { AddPartForm } from "../components/AddPartForm";

type Tab = "manual" | "scan" | "bulk" | "import";

interface ScannedPart {
  id: string;
  partNumber: string;
  brand: string;
  description: string;
  status: "pending" | "adding" | "added" | "error";
  error?: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function useDropZone(onFiles: (files: File[]) => void, accept?: string) {
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  const handlers = {
    onDragEnter(e: DragEvent) {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current++;
      if (e.dataTransfer.types.includes("Files")) setDragging(true);
    },
    onDragOver(e: DragEvent) {
      e.preventDefault();
      e.stopPropagation();
    },
    onDragLeave(e: DragEvent) {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current--;
      if (dragCounter.current === 0) setDragging(false);
    },
    onDrop(e: DragEvent) {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      setDragging(false);
      const dropped = Array.from(e.dataTransfer.files);
      if (accept) {
        const exts = accept.split(",").map((a) => a.trim().toLowerCase());
        const filtered = dropped.filter((f) => {
          const name = f.name.toLowerCase();
          const mime = f.type.toLowerCase();
          return exts.some(
            (ext) =>
              (ext.startsWith(".") && name.endsWith(ext)) ||
              (ext.includes("/") && (ext === mime || (ext.endsWith("/*") && mime.startsWith(ext.replace("/*", "/")))))
          );
        });
        if (filtered.length > 0) onFiles(filtered);
      } else {
        onFiles(dropped);
      }
    },
  };

  return { dragging, handlers };
}

// --- Scan Tab: single photo -> auto-fill form ---

function ScanTab() {
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [scanned, setScanned] = useState(false);
  const [partNumber, setPartNumber] = useState("");
  const [brand, setBrand] = useState("");
  const [description, setDescription] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function processFile(file: File) {
    setScanError("");
    setScanning(true);
    try {
      const base64 = await fileToBase64(file);
      const result = await api<{ partNumber?: string; brand?: string; description?: string }>(
        "/api/parts/ocr",
        { method: "POST", body: JSON.stringify({ image: base64 }) }
      );
      setPartNumber(result.partNumber ?? "");
      setBrand(result.brand ?? "");
      setDescription(result.description ?? "");
      setScanned(true);
    } catch (err: any) {
      setScanError(err.message || "OCR failed");
    } finally {
      setScanning(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleCapture(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }

  const { dragging, handlers: dropHandlers } = useDropZone(
    (files) => { if (files[0]) processFile(files[0]); },
    "image/*"
  );

  function reset() {
    setScanned(false);
    setPartNumber("");
    setBrand("");
    setDescription("");
    setScanError("");
  }

  if (!scanned) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Take a photo of the part label to auto-fill the part number.
        </p>
        {scanError && (
          <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-400">
            {scanError}
          </div>
        )}
        {scanning ? (
          <div className="flex items-center justify-center gap-2 px-4 py-8 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 text-sm text-gray-500 dark:text-gray-400">
            <Icon name="hourglass_top" size={18} className="animate-spin" />
            Analyzing photo...
          </div>
        ) : (
          <label
            {...dropHandlers}
            className={`flex flex-col items-center justify-center gap-2 px-4 py-8 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
              dragging
                ? "border-gray-900 dark:border-gray-100 bg-gray-50 dark:bg-gray-800"
                : "border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500"
            }`}
          >
            <Icon name="photo_camera" size={28} className="text-gray-400 dark:text-gray-500" />
            <span className="text-sm text-gray-600 dark:text-gray-300">
              {dragging ? "Drop image here" : "Tap to take photo, choose from gallery, or drag and drop"}
            </span>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={handleCapture}
            />
          </label>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="px-3 py-2 rounded-lg bg-green-50 dark:bg-green-900/20 text-sm text-green-700 dark:text-green-400 flex-1">
          Part detected — edit fields below if needed.
        </div>
        <button
          type="button"
          onClick={reset}
          className="ml-2 p-2 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          title="Scan another"
        >
          <Icon name="refresh" size={18} />
        </button>
      </div>
      <AddPartForm
        keepOpen
        initialPartNumber={partNumber}
        initialBrand={brand}
        initialDescription={description}
        onSuccess={reset}
      />
    </div>
  );
}

// --- Bulk Scan Tab: multi-select from gallery -> queue ---

function BulkScanTab() {
  const [parts, setParts] = useState<ScannedPart[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ done: 0, total: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  async function processFiles(files: File[]) {
    if (files.length === 0) return;
    setScanning(true);
    setScanProgress({ done: 0, total: files.length });

    const results: ScannedPart[] = [];
    for (let i = 0; i < files.length; i++) {
      try {
        const base64 = await fileToBase64(files[i]);
        const result = await api<{ partNumber?: string; brand?: string; description?: string }>(
          "/api/parts/ocr",
          { method: "POST", body: JSON.stringify({ image: base64 }) }
        );
        results.push({
          id: crypto.randomUUID(),
          partNumber: result.partNumber ?? "",
          brand: result.brand ?? "",
          description: result.description ?? "",
          status: "pending",
        });
      } catch {
        results.push({
          id: crypto.randomUUID(),
          partNumber: "",
          brand: "",
          description: "",
          status: "error",
          error: `Failed to scan ${files[i].name}`,
        });
      }
      setScanProgress({ done: i + 1, total: files.length });
    }

    setParts((prev) => [...prev, ...results]);
    setScanning(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  function handleFiles(e: ChangeEvent<HTMLInputElement>) {
    processFiles(Array.from(e.target.files ?? []));
  }

  const { dragging, handlers: dropHandlers } = useDropZone(
    (files) => processFiles(files),
    "image/*"
  );

  function removePart(id: string) {
    setParts((prev) => prev.filter((p) => p.id !== id));
  }

  function updatePart(id: string, field: keyof Pick<ScannedPart, "partNumber" | "brand">, value: string) {
    setParts((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  }

  const addAll = useCallback(async () => {
    const pending = parts.filter((p) => p.status === "pending" && p.partNumber.trim());
    if (pending.length === 0) return;

    for (const part of pending) {
      setParts((prev) => prev.map((p) => (p.id === part.id ? { ...p, status: "adding" } : p)));
      try {
        await api("/api/parts", {
          method: "POST",
          body: JSON.stringify({
            partNumber: part.partNumber.trim(),
            brand: part.brand.trim() || undefined,
            description: part.description.trim() || undefined,
            quantity: 1,
          }),
        });
        setParts((prev) => prev.map((p) => (p.id === part.id ? { ...p, status: "added" } : p)));
      } catch (err: any) {
        setParts((prev) =>
          prev.map((p) => (p.id === part.id ? { ...p, status: "error", error: err.message || "Failed" } : p))
        );
      }
    }
  }, [parts]);

  const pendingCount = parts.filter((p) => p.status === "pending" && p.partNumber.trim()).length;
  const addedCount = parts.filter((p) => p.status === "added").length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Select multiple photos from your gallery. Each will be scanned for a part number.
      </p>

      {scanning ? (
        <div className="flex items-center justify-center gap-2 px-4 py-6 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 text-sm text-gray-500 dark:text-gray-400">
          <Icon name="hourglass_top" size={18} className="animate-spin" />
          Scanning {scanProgress.done}/{scanProgress.total}...
        </div>
      ) : (
        <label
          {...dropHandlers}
          className={`flex items-center justify-center gap-2 px-4 py-6 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
            dragging
              ? "border-gray-900 dark:border-gray-100 bg-gray-50 dark:bg-gray-800"
              : "border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500"
          }`}
        >
          <Icon name="add_photo_alternate" size={24} className="text-gray-400 dark:text-gray-500" />
          <span className="text-sm text-gray-600 dark:text-gray-300">
            {dragging
              ? "Drop images here"
              : parts.length > 0
              ? "Add more photos or drag and drop"
              : "Select photos from gallery or drag and drop"}
          </span>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={handleFiles}
          />
        </label>
      )}

      {parts.length > 0 && (
        <>
          <div className="space-y-2">
            {parts.map((part) => (
              <div
                key={part.id}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border ${
                  part.status === "added"
                    ? "border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20"
                    : part.status === "error"
                    ? "border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20"
                    : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
                }`}
              >
                {part.status === "added" ? (
                  <Icon name="check_circle" size={18} className="text-green-600 dark:text-green-400 shrink-0" />
                ) : part.status === "error" ? (
                  <Icon name="error" size={18} className="text-red-500 dark:text-red-400 shrink-0" />
                ) : part.status === "adding" ? (
                  <Icon name="hourglass_top" size={18} className="text-gray-400 animate-spin shrink-0" />
                ) : (
                  <Icon name="label" size={18} className="text-gray-400 dark:text-gray-500 shrink-0" />
                )}

                <div className="flex-1 min-w-0">
                  {part.status === "pending" ? (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={part.partNumber}
                        onChange={(e) => updatePart(part.id, "partNumber", e.target.value)}
                        placeholder="Part number"
                        className="flex-1 min-w-0 px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                      />
                      <input
                        type="text"
                        value={part.brand}
                        onChange={(e) => updatePart(part.id, "brand", e.target.value)}
                        placeholder="Brand"
                        className="w-24 px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {part.partNumber || "(no part number)"}
                      </span>
                      {part.brand && (
                        <span className="text-xs text-gray-500 dark:text-gray-400">{part.brand}</span>
                      )}
                    </div>
                  )}
                  {part.status === "error" && part.error && (
                    <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">{part.error}</p>
                  )}
                </div>

                {part.status === "pending" && (
                  <button
                    type="button"
                    onClick={() => removePart(part.id)}
                    className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  >
                    <Icon name="close" size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>

          {pendingCount > 0 && (
            <button
              type="button"
              onClick={addAll}
              className="w-full px-3 py-2.5 text-sm font-medium rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
            >
              Add {pendingCount} part{pendingCount !== 1 ? "s" : ""} to inventory
            </button>
          )}

          {addedCount > 0 && pendingCount === 0 && (
            <div className="px-3 py-2.5 rounded-lg bg-green-50 dark:bg-green-900/20 text-sm text-green-700 dark:text-green-400 text-center">
              {addedCount} part{addedCount !== 1 ? "s" : ""} added successfully
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --- Import Tab: PDF document parsing ---

interface ImportedItem {
  id: string;
  partNumber: string;
  description: string;
  quantity: number;
  unitPrice: number | null;
  brand: string | null;
  status: "pending" | "adding" | "added" | "error";
  error?: string;
}

function ImportTab() {
  const [items, setItems] = useState<ImportedItem[]>([]);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState("");
  const [vendor, setVendor] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function processFile(file: File) {
    setParseError("");
    setParsing(true);
    try {
      const base64 = await fileToBase64(file);
      const result = await api<{
        vendor: string;
        orderNumber: string | null;
        items: Array<{
          partNumber: string;
          description: string;
          quantity: number;
          unitPrice: number | null;
          brand: string | null;
        }>;
      }>("/api/parts/import", {
        method: "POST",
        body: JSON.stringify({ document: base64 }),
      });
      setVendor(result.vendor);
      setOrderNumber(result.orderNumber ?? "");
      setItems(
        result.items.map((item) => ({
          ...item,
          id: crypto.randomUUID(),
          status: "pending" as const,
        }))
      );
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to parse document";
      setParseError(message);
    } finally {
      setParsing(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }

  const { dragging, handlers: dropHandlers } = useDropZone(
    (files) => { if (files[0]) processFile(files[0]); },
    ".pdf,application/pdf"
  );

  function removeItem(id: string) {
    setItems((prev) => prev.filter((p) => p.id !== id));
  }

  function updateItem(
    id: string,
    field: "partNumber" | "brand" | "quantity",
    value: string
  ) {
    setItems((prev) =>
      prev.map((p) =>
        p.id === id
          ? {
              ...p,
              [field]: field === "quantity" ? Math.max(1, parseInt(value) || 1) : value,
            }
          : p
      )
    );
  }

  const addAll = useCallback(async () => {
    const pending = items.filter(
      (p) => p.status === "pending" && p.partNumber.trim()
    );
    if (pending.length === 0) return;

    const note = vendor && orderNumber
      ? `Imported from ${vendor} order #${orderNumber}`
      : vendor
      ? `Imported from ${vendor}`
      : undefined;

    for (const item of pending) {
      setItems((prev) =>
        prev.map((p) =>
          p.id === item.id ? { ...p, status: "adding" } : p
        )
      );
      try {
        await api("/api/parts", {
          method: "POST",
          body: JSON.stringify({
            partNumber: item.partNumber.trim(),
            brand: item.brand?.trim() || undefined,
            description: item.description?.trim() || undefined,
            quantity: item.quantity,
            note,
          }),
        });
        setItems((prev) =>
          prev.map((p) =>
            p.id === item.id ? { ...p, status: "added" } : p
          )
        );
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed";
        setItems((prev) =>
          prev.map((p) =>
            p.id === item.id ? { ...p, status: "error", error: message } : p
          )
        );
      }
    }
  }, [items, vendor, orderNumber]);

  const pendingCount = items.filter(
    (p) => p.status === "pending" && p.partNumber.trim()
  ).length;
  const addedCount = items.filter((p) => p.status === "added").length;

  function reset() {
    setItems([]);
    setVendor("");
    setOrderNumber("");
    setParseError("");
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Upload an order PDF (Amazon, eBay, Marcone) to extract parts
        automatically.
      </p>

      {parseError && (
        <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-400">
          {parseError}
        </div>
      )}

      {items.length === 0 && (
        <>
          {parsing ? (
            <div className="flex items-center justify-center gap-2 px-4 py-8 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 text-sm text-gray-500 dark:text-gray-400">
              <Icon name="hourglass_top" size={18} className="animate-spin" />
              Parsing document...
            </div>
          ) : (
            <label
              {...dropHandlers}
              className={`flex flex-col items-center justify-center gap-2 px-4 py-8 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
                dragging
                  ? "border-gray-900 dark:border-gray-100 bg-gray-50 dark:bg-gray-800"
                  : "border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500"
              }`}
            >
              <Icon
                name="upload_file"
                size={28}
                className="text-gray-400 dark:text-gray-500"
              />
              <span className="text-sm text-gray-600 dark:text-gray-300">
                {dragging ? "Drop PDF here" : "Select or drag and drop a PDF document"}
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

      {items.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <div className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300">
              {vendor && (
                <span className="font-medium capitalize">{vendor}</span>
              )}
              {orderNumber && (
                <span className="text-gray-500 dark:text-gray-400">
                  {" "}
                  #{orderNumber}
                </span>
              )}
              {!vendor && "Document"}
              {" \u2014 "}
              {items.length} item{items.length !== 1 ? "s" : ""} found
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

          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={item.id}
                className={`px-3 py-2.5 rounded-lg border ${
                  item.status === "added"
                    ? "border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20"
                    : item.status === "error"
                    ? "border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20"
                    : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
                }`}
              >
                <div className="flex items-center gap-2">
                  {item.status === "added" ? (
                    <Icon
                      name="check_circle"
                      size={18}
                      className="text-green-600 dark:text-green-400 shrink-0"
                    />
                  ) : item.status === "error" ? (
                    <Icon
                      name="error"
                      size={18}
                      className="text-red-500 dark:text-red-400 shrink-0"
                    />
                  ) : item.status === "adding" ? (
                    <Icon
                      name="hourglass_top"
                      size={18}
                      className="text-gray-400 animate-spin shrink-0"
                    />
                  ) : (
                    <Icon
                      name="label"
                      size={18}
                      className="text-gray-400 dark:text-gray-500 shrink-0"
                    />
                  )}

                  <div className="flex-1 min-w-0">
                    {item.status === "pending" ? (
                      <div className="space-y-1.5">
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={item.partNumber}
                            onChange={(e) =>
                              updateItem(item.id, "partNumber", e.target.value)
                            }
                            placeholder="Part number"
                            className="flex-1 min-w-0 px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                          />
                          <input
                            type="text"
                            value={item.brand ?? ""}
                            onChange={(e) =>
                              updateItem(item.id, "brand", e.target.value)
                            }
                            placeholder="Brand"
                            className="w-24 px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                          />
                          <input
                            type="number"
                            min={1}
                            value={item.quantity}
                            onChange={(e) =>
                              updateItem(item.id, "quantity", e.target.value)
                            }
                            className="w-14 px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-center"
                          />
                        </div>
                        {item.description && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                            {item.description}
                          </p>
                        )}
                        {item.unitPrice != null && (
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            ${item.unitPrice.toFixed(2)} each
                          </p>
                        )}
                      </div>
                    ) : (
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                            {item.partNumber || "(no part number)"}
                          </span>
                          {item.brand && (
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              {item.brand}
                            </span>
                          )}
                          {item.quantity > 1 && (
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              x{item.quantity}
                            </span>
                          )}
                        </div>
                        {item.description && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                            {item.description}
                          </p>
                        )}
                      </div>
                    )}
                    {item.status === "error" && item.error && (
                      <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">
                        {item.error}
                      </p>
                    )}
                  </div>

                  {item.status === "pending" && (
                    <button
                      type="button"
                      onClick={() => removeItem(item.id)}
                      className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 shrink-0"
                    >
                      <Icon name="close" size={16} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {pendingCount > 0 && (
            <button
              type="button"
              onClick={addAll}
              className="w-full px-3 py-2.5 text-sm font-medium rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
            >
              Add {pendingCount} part{pendingCount !== 1 ? "s" : ""} to
              inventory
            </button>
          )}

          {addedCount > 0 && pendingCount === 0 && (
            <div className="px-3 py-2.5 rounded-lg bg-green-50 dark:bg-green-900/20 text-sm text-green-700 dark:text-green-400 text-center">
              {addedCount} part{addedCount !== 1 ? "s" : ""} added successfully
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --- Main Page ---

export function AddPartPage() {
  const [tab, setTab] = useState<Tab>("manual");

  const tabs: { key: Tab; label: string; icon: string }[] = [
    { key: "manual", label: "Manual", icon: "edit" },
    { key: "scan", label: "Scan", icon: "photo_camera" },
    { key: "bulk", label: "Bulk", icon: "add_photo_alternate" },
    { key: "import", label: "Import", icon: "upload_file" },
  ];

  return (
    <div className="pt-4">
      <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-4">Add Part</h1>

      {/* Tab bar */}
      <div className="flex gap-1 p-1 mb-4 rounded-lg bg-gray-100 dark:bg-gray-800">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
              tab === t.key
                ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            <Icon name={t.icon} size={16} />
            {t.label}
          </button>
        ))}
      </div>

      {tab === "manual" && <AddPartForm keepOpen onSuccess={() => {}} />}
      {tab === "scan" && <ScanTab />}
      {tab === "bulk" && <BulkScanTab />}
      {tab === "import" && <ImportTab />}
    </div>
  );
}
