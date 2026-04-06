import { AddPartForm } from "../components/AddPartForm";

export function AddPartPage() {
  return (
    <div className="pt-4">
      <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-4">Add Part</h1>
      <AddPartForm keepOpen onSuccess={() => {}} />
    </div>
  );
}
