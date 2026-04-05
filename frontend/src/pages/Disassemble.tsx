import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { Icon } from "../components/Icon";
import { StatusBadge } from "../components/StatusBadge";
import { ApplianceDetail } from "./ApplianceDetail";

interface Appliance {
  id: number;
  brand: string | null;
  modelNumber: string | null;
  serialNumber: string | null;
  applianceType: string | null;
  status: string;
  notes: string | null;
  photoKey: string | null;
  createdAt: string;
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function Disassemble() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [appliances, setAppliances] = useState<Appliance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (id) return;
    setLoading(true);
    api<Appliance[]>("/api/appliances")
      .then((data) => {
        const sorted = [...data].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        setAppliances(sorted);
      })
      .catch((err: any) => setError(err.message || "Failed to load appliances"))
      .finally(() => setLoading(false));
  }, [id]);

  if (id) {
    const numId = parseInt(id, 10);
    if (isNaN(numId)) return <div className="pt-4 text-sm text-red-600">Invalid appliance ID</div>;
    return <ApplianceDetail id={numId} onBack={() => navigate("/disassemble")} />;
  }

  return (
    <div className="pt-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">Disassemble</h1>
        <button
          onClick={() => navigate("/disassemble/new")}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
        >
          <Icon name="add" size={16} />
          New Appliance
        </button>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading...</p>
      ) : appliances.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Icon name="handyman" size={40} className="text-gray-300 dark:text-gray-600 mb-3" />
          <p className="text-sm text-gray-500 dark:text-gray-400">No appliances yet</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Add one to get started</p>
        </div>
      ) : (
        <div className="space-y-2">
          {appliances.map((appliance) => (
            <button
              key={appliance.id}
              onClick={() => navigate(`/disassemble/${appliance.id}`)}
              className="w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-750"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {[appliance.brand, appliance.modelNumber].filter(Boolean).join(" ") || "Unknown Appliance"}
                  </span>
                  <StatusBadge variant={statusVariant(appliance.status)}>
                    {statusLabel(appliance.status)}
                  </StatusBadge>
                </div>
                <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  {appliance.applianceType && <span className="capitalize">{appliance.applianceType}</span>}
                  {appliance.applianceType && <span>·</span>}
                  <span>{formatDate(appliance.createdAt)}</span>
                </div>
              </div>
              <Icon name="chevron_right" size={18} className="text-gray-400 dark:text-gray-500 shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
