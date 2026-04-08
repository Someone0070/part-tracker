import { useState, useEffect, type FormEvent } from "react";
import { api } from "../api/client";

const INPUT_CLASS =
  "w-full px-3 py-2.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent";

interface AddPartFormProps {
  formId?: string;
  onSuccess: () => void;
  onError?: (message: string) => void;
  /** If true, resets fields after success instead of unmounting */
  keepOpen?: boolean;
  initialPartNumber?: string;
  initialBrand?: string;
  initialDescription?: string;
}

export function AddPartForm({ formId, onSuccess, onError, keepOpen, initialPartNumber, initialBrand, initialDescription }: AddPartFormProps) {
  const [partNumber, setPartNumber] = useState(initialPartNumber ?? "");
  const [brand, setBrand] = useState(initialBrand ?? "");
  const [description, setDescription] = useState(initialDescription ?? "");
  const [note, setNote] = useState("");

  // Sync when initial values change (e.g., from OCR scan)
  useEffect(() => { if (initialPartNumber !== undefined) setPartNumber(initialPartNumber); }, [initialPartNumber]);
  useEffect(() => { if (initialBrand !== undefined) setBrand(initialBrand); }, [initialBrand]);
  useEffect(() => { if (initialDescription !== undefined) setDescription(initialDescription); }, [initialDescription]);
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!partNumber.trim()) return;
    setError("");
    setLoading(true);
    setSuccess(false);
    try {
      await api("/api/parts", {
        method: "POST",
        body: JSON.stringify({
          partNumber: partNumber.trim(),
          brand: brand.trim() || undefined,
          description: description.trim() || undefined,
          note: note.trim() || undefined,
          quantity,
        }),
      });
      onSuccess();
      if (keepOpen) {
        setPartNumber("");
        setBrand("");
        setDescription("");
        setNote("");
        setQuantity(1);
        setSuccess(true);
        setTimeout(() => setSuccess(false), 3000);
      }
    } catch (err: any) {
      const msg = err.message || "Failed to add part";
      setError(msg);
      onError?.(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {success && (
        <div className="mb-4 px-3 py-2.5 rounded-lg bg-green-50 dark:bg-green-900/20 text-sm text-green-700 dark:text-green-400">
          Part added successfully
        </div>
      )}
      {error && (
        <div className="mb-4 px-3 py-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">
            Part Number <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={partNumber}
            onChange={(e) => setPartNumber(e.target.value)}
            placeholder="e.g. WPW10321304"
            maxLength={50}
            required
            autoFocus
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Brand</label>
          <input
            type="text"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            placeholder="e.g. Whirlpool"
            maxLength={100}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Door Shelf Bin"
            maxLength={500}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Note</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Pulled from Kenmore Elite #KE-2847"
            maxLength={1000}
            rows={2}
            className={`${INPUT_CLASS} resize-none`}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Saved to the activity log, not the part itself
          </p>
        </div>
        <div>
          <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Quantity</label>
          <input
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
            className={INPUT_CLASS}
          />
        </div>
        {!formId && (
          <button
            type="submit"
            disabled={loading || !partNumber.trim()}
            className="w-full px-3 py-2.5 text-sm font-medium rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Adding..." : "Add Part"}
          </button>
        )}
      </form>
    </>
  );
}
