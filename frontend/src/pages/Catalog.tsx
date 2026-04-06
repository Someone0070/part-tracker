import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";
import { Icon } from "../components/Icon";
import { StatusBadge } from "../components/StatusBadge";
import { PartDetail } from "./PartDetail";
import { AddPartModal } from "./AddPart";

interface Part {
  id: number;
  partNumber: string;
  partNumberRaw: string;
  brand: string | null;
  description: string | null;
  quantity: number;
  listedQuantity: number;
  available: number;
  ebayListingId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function Catalog() {
  const [parts, setParts] = useState<Part[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedPartId, setSelectedPartId] = useState<number | null>(null);
  const [showAddPart, setShowAddPart] = useState(false);

  const fetchParts = useCallback(async () => {
    setLoading(true);
    try {
      const params = search ? `?search=${encodeURIComponent(search)}` : "";
      const data = await api<Part[]>(`/api/parts${params}`);
      setParts(data);
    } catch {
      // stay on empty state
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const timer = setTimeout(fetchParts, search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [fetchParts]);

  return (
    <>
      <div className="pt-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">Catalog</h1>
          <button
            onClick={() => setShowAddPart(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
          >
            <Icon name="add" size={16} />
            Add Part
          </button>
        </div>
        <div className="relative mb-4">
          <Icon name="search" size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search parts..."
            className="w-full pl-9 pr-3 py-2.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent"
          />
        </div>

        {loading && parts.length === 0 ? (
          <div className="text-center py-12 text-sm text-gray-500 dark:text-gray-400">Loading...</div>
        ) : parts.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-sm text-gray-500 dark:text-gray-400">{search ? "No parts found" : "No parts in inventory"}</p>
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
            {parts.map((part) => (
              <button
                key={part.id}
                onClick={() => setSelectedPartId(part.id)}
                className="w-full flex items-center justify-between px-3 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer first:rounded-t-lg last:rounded-b-lg"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{part.partNumberRaw}</span>
                    {part.brand && <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">{part.brand}</span>}
                  </div>
                  {part.description && <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">{part.description}</p>}
                </div>
                <div className="shrink-0 ml-3 text-right">
                  {part.quantity === 0 ? (
                    <StatusBadge variant="neutral">Out of stock</StatusBadge>
                  ) : part.listedQuantity > 0 ? (
                    <div className="flex items-center gap-1.5">
                      <StatusBadge variant="success">{part.available} avail</StatusBadge>
                      <StatusBadge variant="info">{part.listedQuantity} listed</StatusBadge>
                    </div>
                  ) : (
                    <StatusBadge variant="success">{part.quantity} in stock</StatusBadge>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedPartId !== null && (
        <PartDetail partId={selectedPartId} onClose={() => setSelectedPartId(null)} onPartChanged={fetchParts} />
      )}

      {showAddPart && (
        <AddPartModal onClose={() => setShowAddPart(false)} onPartAdded={fetchParts} />
      )}
    </>
  );
}
