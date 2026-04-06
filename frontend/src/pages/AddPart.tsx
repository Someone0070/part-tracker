import { useState, type FormEvent } from "react";
import { api } from "../api/client";
import { Icon } from "../components/Icon";

const INPUT_CLASS =
  "w-full px-3 py-2.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent";

interface AddPartModalProps {
  onClose: () => void;
  onPartAdded: () => void;
}

export function AddPartModal({ onClose, onPartAdded }: AddPartModalProps) {
  const [partNumber, setPartNumber] = useState("");
  const [brand, setBrand] = useState("");
  const [description, setDescription] = useState("");
  const [note, setNote] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!partNumber.trim()) return;
    setError("");
    setLoading(true);
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
      onPartAdded();
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to add part");
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-white dark:bg-gray-950 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-800">
        <button
          type="button"
          onClick={onClose}
          className="p-1 -ml-1 rounded-md text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <Icon name="close" size={20} />
        </button>
        <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">Add Part</h1>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {error && (
          <div className="mb-4 px-3 py-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 text-sm text-red-700 dark:text-red-400">
            {error}
          </div>
        )}
        <form id="add-part-form" onSubmit={handleSubmit} className="space-y-4">
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
        </form>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-800">
        <button
          type="submit"
          form="add-part-form"
          disabled={loading || !partNumber.trim()}
          className="w-full px-3 py-2.5 text-sm font-medium rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Adding..." : "Add Part"}
        </button>
      </div>
    </div>
  );
}
