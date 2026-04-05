import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DropdownMenu } from "../components/DropdownMenu";
import { StatusBadge } from "../components/StatusBadge";
import { Timeline } from "../components/Timeline";
import { Icon } from "../components/Icon";

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

interface CrossRef {
  crossRefPartNumber: string;
  relationship: string;
  inStock: boolean;
  quantity: number;
}

interface TimelineEvent {
  id: number;
  eventType: string;
  quantityChange: number;
  note: string | null;
  createdAt: string;
}

interface PartDetailProps {
  partId: number;
  onClose: () => void;
  onPartChanged: () => void;
}

export function PartDetail({ partId, onClose, onPartChanged }: PartDetailProps) {
  const [part, setPart] = useState<Part | null>(null);
  const [crossRefs, setCrossRefs] = useState<CrossRef[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [hasMoreEvents, setHasMoreEvents] = useState(false);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editBrand, setEditBrand] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [depleteAction, setDepleteAction] = useState<"used" | "sold" | null>(null);
  const [depleteQty, setDepleteQty] = useState(1);
  const [depleting, setDepleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const EVENTS_LIMIT = 20;

  const fetchPart = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ part: Part; crossReferences: CrossRef[]; events: TimelineEvent[] }>(`/api/parts/${partId}?eventsLimit=${EVENTS_LIMIT}`);
      setPart(data.part);
      setCrossRefs(data.crossReferences);
      setEvents(data.events);
      setHasMoreEvents(data.events.length >= EVENTS_LIMIT);
    } catch {
      onClose();
    } finally {
      setLoading(false);
    }
  }, [partId, onClose]);

  useEffect(() => { fetchPart(); }, [fetchPart]);

  async function loadMoreEvents() {
    if (loadingEvents || !hasMoreEvents) return;
    setLoadingEvents(true);
    try {
      const data = await api<{ part: Part; crossReferences: CrossRef[]; events: TimelineEvent[] }>(`/api/parts/${partId}?eventsLimit=${EVENTS_LIMIT}&eventsOffset=${events.length}`);
      setEvents((prev) => [...prev, ...data.events]);
      setHasMoreEvents(data.events.length >= EVENTS_LIMIT);
    } finally {
      setLoadingEvents(false);
    }
  }

  async function handleSaveEdit() {
    if (!part) return;
    setSaving(true);
    try {
      await api(`/api/parts/${part.id}`, { method: "PATCH", body: JSON.stringify({ brand: editBrand || null, description: editDescription || null }) });
      setEditing(false);
      fetchPart();
      onPartChanged();
    } finally {
      setSaving(false);
    }
  }

  async function handleDeplete() {
    if (!part || !depleteAction) return;
    setDepleting(true);
    try {
      await api(`/api/parts/${part.id}/deplete`, { method: "POST", body: JSON.stringify({ quantity: depleteQty, reason: depleteAction }) });
      setDepleteAction(null);
      setDepleteQty(1);
      fetchPart();
      onPartChanged();
    } catch (err: any) {
      alert(err.message || "Failed to deplete");
    } finally {
      setDepleting(false);
    }
  }

  function startEdit() {
    if (!part) return;
    setEditBrand(part.brand || "");
    setEditDescription(part.description || "");
    setEditing(true);
  }

  async function handleDelete() {
    if (!part) return;
    try {
      await api(`/api/parts/${part.id}`, { method: "DELETE" });
      onPartChanged();
      onClose();
    } catch (err: any) {
      alert(err.message || "Failed to delete");
    }
  }

  const menuItems = [
    { label: "Edit", icon: "edit", onClick: startEdit },
    { label: "Mark Used", icon: "build", onClick: () => { setDepleteQty(1); setDepleteAction("used"); } },
    { label: "Mark Sold", icon: "sell", onClick: () => { setDepleteQty(1); setDepleteAction("sold"); } },
    { label: "Delete", icon: "delete", onClick: () => setShowDeleteConfirm(true), destructive: true },
  ];

  return (
    <>
      <Modal open={true} onClose={onClose} title={part?.partNumberRaw || "Loading..."} actions={part ? <DropdownMenu items={menuItems} /> : undefined}>
        {loading || !part ? (
          <div className="text-center py-8 text-sm text-gray-500 dark:text-gray-400">Loading...</div>
        ) : editing ? (
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Brand</label>
              <input type="text" value={editBrand} onChange={(e) => setEditBrand(e.target.value)} maxLength={100} className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100" />
            </div>
            <div>
              <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Description</label>
              <input type="text" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} maxLength={500} className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-xs font-medium rounded-md bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">Cancel</button>
              <button onClick={handleSaveEdit} disabled={saving} className="px-3 py-1.5 text-xs font-medium rounded-md bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50">{saving ? "Saving..." : "Save"}</button>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-x-8 gap-y-3">
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">Part Number</p>
                <p className="text-sm text-gray-900 dark:text-gray-100 mt-0.5">{part.partNumberRaw}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">Brand</p>
                <p className="text-sm text-gray-900 dark:text-gray-100 mt-0.5">{part.brand || "\u2014"}</p>
              </div>
              <div className="col-span-2">
                <p className="text-xs text-gray-500 dark:text-gray-400">Description</p>
                <p className="text-sm text-gray-900 dark:text-gray-100 mt-0.5">{part.description || "\u2014"}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">Total Qty</p>
                <p className="text-sm text-gray-900 dark:text-gray-100 mt-0.5">{part.quantity}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">Available / Listed</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <StatusBadge variant={part.available > 0 ? "success" : "neutral"}>{part.available} avail</StatusBadge>
                  {part.listedQuantity > 0 && <StatusBadge variant="info">{part.listedQuantity} listed</StatusBadge>}
                </div>
              </div>
            </div>

            {crossRefs.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2 flex items-center gap-1.5">
                  <Icon name="link" size={16} className="text-gray-400" />Cross-References
                </h3>
                <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
                  {crossRefs.map((ref) => (
                    <div key={ref.crossRefPartNumber} className="flex items-center justify-between px-3 py-2">
                      <div>
                        <span className="text-sm text-gray-900 dark:text-gray-100">{ref.crossRefPartNumber}</span>
                        <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">{ref.relationship}</span>
                      </div>
                      {ref.inStock ? <StatusBadge variant="success">{ref.quantity} in stock</StatusBadge> : <StatusBadge variant="neutral">Not in stock</StatusBadge>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">Activity</h3>
              <Timeline events={events} loading={loadingEvents} hasMore={hasMoreEvents} onLoadMore={loadMoreEvents} />
            </div>
          </div>
        )}
      </Modal>

      {depleteAction && part && (
        <DepleteDialog action={depleteAction} maxQty={part.available} quantity={depleteQty} onQuantityChange={setDepleteQty} onConfirm={handleDeplete} onClose={() => setDepleteAction(null)} loading={depleting} />
      )}

      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Delete part"
        message={`Delete ${part?.partNumberRaw || "this part"}? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
      />
    </>
  );
}

function DepleteDialog({ action, maxQty, quantity, onQuantityChange, onConfirm, onClose, loading }: { action: "used" | "sold"; maxQty: number; quantity: number; onQuantityChange: (n: number) => void; onConfirm: () => void; onClose: () => void; loading: boolean; }) {
  const label = action === "used" ? "Mark as Used" : "Mark as Sold";
  return (
    <Modal open={true} onClose={onClose} title={label}>
      <div className="space-y-3">
        <div>
          <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Quantity (max {maxQty})</label>
          <input type="number" min={1} max={maxQty} value={quantity} onChange={(e) => onQuantityChange(Math.max(1, Math.min(maxQty, parseInt(e.target.value) || 1)))} className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100" />
        </div>
        {maxQty === 0 && <p className="text-xs text-red-600 dark:text-red-400">No available units to deplete.</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-medium rounded-md bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">Cancel</button>
          <button onClick={onConfirm} disabled={loading || maxQty === 0 || quantity < 1} className="px-3 py-1.5 text-xs font-medium rounded-md bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50">{loading ? "Saving..." : label}</button>
        </div>
      </div>
    </Modal>
  );
}
