import { useState, useEffect, type FormEvent } from "react";
import { api } from "../api/client";
import { Icon } from "../components/Icon";
import { StatusBadge } from "../components/StatusBadge";

const INPUT_CLASS =
  "w-full px-3 py-2.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent";

interface Appliance {
  id: number;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  type: string | null;
  status: string;
  notes: string | null;
  photoUrl: string | null;
  createdAt: string;
}

interface AppliancePart {
  id: number;
  partNumber: string;
  brand: string | null;
  description: string | null;
  quantity: number;
  createdAt: string;
}

interface ApplianceDetailProps {
  id: number;
  onBack: () => void;
}

function statusVariant(status: string): "info" | "success" | "neutral" {
  if (status === "active") return "info";
  if (status === "stripped") return "success";
  return "neutral";
}

function statusLabel(status: string): string {
  if (status === "active") return "Active";
  if (status === "stripped") return "Stripped";
  return status;
}

export function ApplianceDetail({ id, onBack }: ApplianceDetailProps) {
  const [appliance, setAppliance] = useState<Appliance | null>(null);
  const [parts, setParts] = useState<AppliancePart[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Strip action
  const [stripping, setStripping] = useState(false);

  // Add part form
  const [showAddPart, setShowAddPart] = useState(false);
  const [partNumber, setPartNumber] = useState("");
  const [partBrand, setPartBrand] = useState("");
  const [partQty, setPartQty] = useState(1);
  const [partDesc, setPartDesc] = useState("");
  const [partSubmitting, setPartSubmitting] = useState(false);
  const [partError, setPartError] = useState("");
  const [partSuccess, setPartSuccess] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api<Appliance>(`/api/appliances/${id}`),
      api<AppliancePart[]>(`/api/appliances/${id}/parts`),
    ])
      .then(([applianceData, partsData]) => {
        setAppliance(applianceData);
        setParts(partsData);
      })
      .catch((err: any) => setError(err.message || "Failed to load appliance"))
      .finally(() => setLoading(false));
  }, [id]);

  async function handleMarkStripped() {
    if (!appliance) return;
    setStripping(true);
    try {
      const updated = await api<Appliance>(`/api/appliances/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "stripped" }),
      });
      setAppliance(updated);
    } catch (err: any) {
      setError(err.message || "Failed to update status");
    } finally {
      setStripping(false);
    }
  }

  async function handleAddPart(e: FormEvent) {
    e.preventDefault();
    if (!partNumber.trim()) return;
    setPartError("");
    setPartSubmitting(true);
    setPartSuccess(false);
    try {
      const newPart = await api<AppliancePart>(`/api/appliances/${id}/parts`, {
        method: "POST",
        body: JSON.stringify({
          partNumber: partNumber.trim(),
          brand: partBrand.trim() || undefined,
          quantity: partQty,
          description: partDesc.trim() || undefined,
        }),
      });
      setParts((prev) => [newPart, ...prev]);
      setPartNumber("");
      setPartBrand("");
      setPartQty(1);
      setPartDesc("");
      setPartSuccess(true);
      setTimeout(() => setPartSuccess(false), 3000);
    } catch (err: any) {
      setPartError(err.message || "Failed to add part");
    } finally {
      setPartSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="pt-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading...</p>
      </div>
    );
  }

  if (error || !appliance) {
    return (
      <div className="pt-4">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 mb-4">
          <Icon name="arrow_back" size={18} />
          Back
        </button>
        <div className="px-3 py-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 text-sm text-red-700 dark:text-red-400">
          {error || "Appliance not found"}
        </div>
      </div>
    );
  }

  const title = [appliance.brand, appliance.model].filter(Boolean).join(" ") || "Unknown Appliance";

  return (
    <div className="pt-4">
      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={onBack}
          className="p-1 -ml-1 rounded-md text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <Icon name="arrow_back" size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">{title}</h1>
        </div>
        <StatusBadge variant={statusVariant(appliance.status)}>
          {statusLabel(appliance.status)}
        </StatusBadge>
      </div>

      {/* Info card */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 divide-y divide-gray-100 dark:divide-gray-700 mb-4">
        {appliance.type && (
          <div className="flex items-center px-4 py-3">
            <span className="text-xs text-gray-500 dark:text-gray-400 w-24 shrink-0">Type</span>
            <span className="text-sm text-gray-900 dark:text-gray-100 capitalize">{appliance.type}</span>
          </div>
        )}
        {appliance.model && (
          <div className="flex items-center px-4 py-3">
            <span className="text-xs text-gray-500 dark:text-gray-400 w-24 shrink-0">Model</span>
            <span className="text-sm text-gray-900 dark:text-gray-100">{appliance.model}</span>
          </div>
        )}
        {appliance.serialNumber && (
          <div className="flex items-center px-4 py-3">
            <span className="text-xs text-gray-500 dark:text-gray-400 w-24 shrink-0">Serial</span>
            <span className="text-sm text-gray-900 dark:text-gray-100">{appliance.serialNumber}</span>
          </div>
        )}
        {appliance.notes && (
          <div className="flex items-start px-4 py-3">
            <span className="text-xs text-gray-500 dark:text-gray-400 w-24 shrink-0 pt-0.5">Notes</span>
            <span className="text-sm text-gray-900 dark:text-gray-100">{appliance.notes}</span>
          </div>
        )}
        {!appliance.type && !appliance.model && !appliance.serialNumber && !appliance.notes && (
          <div className="px-4 py-3 text-sm text-gray-400 dark:text-gray-500">No details recorded</div>
        )}
      </div>

      {/* Mark as stripped */}
      {appliance.status === "active" && (
        <button
          onClick={handleMarkStripped}
          disabled={stripping}
          className="w-full mb-5 px-3 py-2.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {stripping ? "Updating..." : "Mark as Fully Stripped"}
        </button>
      )}

      {/* Parts pulled section */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Parts Pulled
          {parts.length > 0 && (
            <span className="ml-1.5 text-xs font-normal text-gray-500 dark:text-gray-400">
              ({parts.length})
            </span>
          )}
        </h2>
        <button
          type="button"
          onClick={() => setShowAddPart((v) => !v)}
          className="flex items-center gap-1 text-xs font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
        >
          <Icon name={showAddPart ? "expand_less" : "add"} size={16} />
          {showAddPart ? "Cancel" : "Add Part"}
        </button>
      </div>

      {/* Add part form */}
      {showAddPart && (
        <div className="mb-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
          {partSuccess && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-green-50 dark:bg-green-900/20 text-xs text-green-700 dark:text-green-400">
              Part added
            </div>
          )}
          {partError && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-400">
              {partError}
            </div>
          )}
          <form onSubmit={handleAddPart} className="space-y-3">
            <div>
              <label className="block text-xs text-gray-700 dark:text-gray-300 mb-1">
                Part Number <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={partNumber}
                onChange={(e) => setPartNumber(e.target.value)}
                placeholder="e.g. WPW10321304"
                maxLength={50}
                required
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-700 dark:text-gray-300 mb-1">Brand</label>
              <input
                type="text"
                value={partBrand}
                onChange={(e) => setPartBrand(e.target.value)}
                placeholder="e.g. Whirlpool"
                maxLength={100}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-700 dark:text-gray-300 mb-1">Qty</label>
              <input
                type="number"
                min={1}
                value={partQty}
                onChange={(e) => setPartQty(Math.max(1, parseInt(e.target.value) || 1))}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-700 dark:text-gray-300 mb-1">Description</label>
              <input
                type="text"
                value={partDesc}
                onChange={(e) => setPartDesc(e.target.value)}
                placeholder="e.g. Door shelf bin"
                maxLength={500}
                className={INPUT_CLASS}
              />
            </div>
            <button
              type="submit"
              disabled={partSubmitting || !partNumber.trim()}
              className="w-full px-3 py-2.5 text-sm font-medium rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {partSubmitting ? "Adding..." : "Add Part"}
            </button>
          </form>
        </div>
      )}

      {/* Parts list */}
      {parts.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-6">No parts pulled yet</p>
      ) : (
        <div className="space-y-2">
          {parts.map((part) => (
            <div
              key={part.id}
              className="flex items-start gap-3 px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
            >
              <Icon name="settings" size={16} className="text-gray-400 dark:text-gray-500 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{part.partNumber}</p>
                {(part.brand || part.description) && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {[part.brand, part.description].filter(Boolean).join(" — ")}
                  </p>
                )}
              </div>
              {part.quantity > 1 && (
                <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">x{part.quantity}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
