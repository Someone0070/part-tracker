interface StatusBadgeProps {
  variant: "success" | "warning" | "info" | "neutral" | "error";
  children: React.ReactNode;
}

const variantClasses: Record<StatusBadgeProps["variant"], string> = {
  success: "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400",
  warning: "bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400",
  info: "bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400",
  neutral: "bg-gray-50 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
  error: "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400",
};

export function StatusBadge({ variant, children }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${variantClasses[variant]}`}
    >
      {children}
    </span>
  );
}
