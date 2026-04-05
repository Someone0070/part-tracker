import { Icon } from "./Icon";

interface TimelineEvent {
  id: number;
  eventType: string;
  quantityChange: number;
  note: string | null;
  createdAt: string;
}

interface TimelineProps {
  events: TimelineEvent[];
  loading?: boolean;
  onLoadMore?: () => void;
  hasMore?: boolean;
}

const eventConfig: Record<
  string,
  { icon: string; label: string; color: string }
> = {
  added: {
    icon: "add",
    label: "Added",
    color: "text-green-600 dark:text-green-400",
  },
  used: {
    icon: "build",
    label: "Used",
    color: "text-amber-600 dark:text-amber-400",
  },
  sold: {
    icon: "sell",
    label: "Sold",
    color: "text-blue-600 dark:text-blue-400",
  },
  ebay_sold: {
    icon: "store",
    label: "eBay sale",
    color: "text-blue-600 dark:text-blue-400",
  },
  adjusted: {
    icon: "tune",
    label: "Adjusted",
    color: "text-gray-600 dark:text-gray-400",
  },
};

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function Timeline({
  events,
  loading,
  onLoadMore,
  hasMore,
}: TimelineProps) {
  if (events.length === 0 && !loading) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">
        No activity yet
      </p>
    );
  }

  return (
    <div className="relative">
      <div className="absolute left-3 top-0 bottom-0 w-px bg-gray-200 dark:bg-gray-700" />

      <div className="space-y-4">
        {events.map((event) => {
          const config = eventConfig[event.eventType] || eventConfig.adjusted;
          const isPositive = event.quantityChange > 0;

          return (
            <div key={event.id} className="relative flex items-start gap-3 pl-0">
              <div className="relative z-10 flex items-center justify-center w-6 h-6 rounded-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shrink-0">
                <Icon
                  name={config.icon}
                  size={14}
                  className={config.color}
                />
              </div>

              <div className="flex-1 min-w-0 pt-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {config.label}
                  </span>
                  <span
                    className={`text-xs font-medium ${
                      isPositive
                        ? "text-green-700 dark:text-green-400"
                        : "text-red-700 dark:text-red-400"
                    }`}
                  >
                    {isPositive ? "+" : ""}
                    {event.quantityChange}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto shrink-0">
                    {formatRelativeTime(event.createdAt)}
                  </span>
                </div>
                {event.note && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                    {event.note}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {hasMore && (
        <div className="mt-4 text-center">
          <button
            onClick={onLoadMore}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            {loading ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
