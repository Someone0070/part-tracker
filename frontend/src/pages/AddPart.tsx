import { Icon } from "../components/Icon";
import { AddPartForm } from "../components/AddPartForm";

interface AddPartModalProps {
  onClose: () => void;
  onPartAdded: () => void;
}

export function AddPartModal({ onClose, onPartAdded }: AddPartModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 dark:bg-black/70">
      <div className="w-full max-w-lg h-full sm:h-auto sm:max-h-[90vh] sm:my-8 sm:rounded-xl bg-white dark:bg-gray-950 flex flex-col sm:shadow-xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-800 sm:rounded-t-xl">
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
          <AddPartForm
            formId="add-part-form"
            onSuccess={() => { onPartAdded(); onClose(); }}
          />
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-800 sm:rounded-b-xl">
          <button
            type="submit"
            form="add-part-form"
            className="w-full px-3 py-2.5 text-sm font-medium rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add Part
          </button>
        </div>
      </div>
    </div>
  );
}
