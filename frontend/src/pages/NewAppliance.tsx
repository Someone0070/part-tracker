import { useState, useRef, type FormEvent, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { Icon } from "../components/Icon";

const INPUT_CLASS =
  "w-full px-3 py-2.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:border-transparent";

const APPLIANCE_TYPES = [
  "refrigerator",
  "washer",
  "dryer",
  "dishwasher",
  "range",
  "microwave",
  "freezer",
  "hvac",
  "other",
] as const;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}


export function NewAppliance() {
  const navigate = useNavigate();

  // Sticker OCR state
  const [stickerDone, setStickerDone] = useState(false);
  const [stickerSkipped, setStickerSkipped] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState("");
  const stickerInputRef = useRef<HTMLInputElement>(null);

  // Unit photo state
  const [unitPhotoBase64, setUnitPhotoBase64] = useState<string | null>(null);
  const [unitPhotoPreview, setUnitPhotoPreview] = useState<string | null>(null);

  // Form fields
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [serial, setSerial] = useState("");
  const [type, setType] = useState("");
  const [notes, setNotes] = useState("");

  // Submit state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [photoWarning, setPhotoWarning] = useState("");

  const showFields = stickerDone || stickerSkipped;

  async function handleStickerCapture(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setOcrError("");
    setOcrLoading(true);
    try {
      const base64 = await fileToBase64(file);
      const result = await api<{ brand?: string; model?: string; serial?: string }>(
        "/api/appliances/ocr",
        {
          method: "POST",
          body: JSON.stringify({ image: base64 }),
        }
      );
      if (result.brand) setBrand(result.brand);
      if (result.model) setModel(result.model);
      if (result.serial) setSerial(result.serial);
      setStickerDone(true);
    } catch (err: any) {
      setOcrError(err.message || "OCR failed");
    } finally {
      setOcrLoading(false);
      if (stickerInputRef.current) stickerInputRef.current.value = "";
    }
  }

  function removeUnitPhoto() {
    setUnitPhotoBase64(null);
    setUnitPhotoPreview(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError("");
    setPhotoWarning("");
    setSubmitting(true);

    let photoUrl: string | undefined;

    // Try uploading unit photo
    if (unitPhotoBase64) {
      try {
        const result = await api<{ url: string }>("/api/appliances/upload", {
          method: "POST",
          body: JSON.stringify({ image: unitPhotoBase64 }),
        });
        photoUrl = result.url;
      } catch (err: any) {
        if (err instanceof ApiError && err.status === 503) {
          setPhotoWarning("Photo storage not configured — appliance will be created without photo.");
        } else {
          setPhotoWarning("Photo upload failed — appliance will be created without photo.");
        }
      }
    }

    try {
      const result = await api<{ id: number }>("/api/appliances", {
        method: "POST",
        body: JSON.stringify({
          brand: brand.trim() || undefined,
          model: model.trim() || undefined,
          serialNumber: serial.trim() || undefined,
          type: type || undefined,
          notes: notes.trim() || undefined,
          photoUrl,
        }),
      });
      navigate(`/disassemble/${result.id}`);
    } catch (err: any) {
      setSubmitError(err.message || "Failed to create appliance");
      setSubmitting(false);
    }
  }

  return (
    <div className="pt-4">
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={() => navigate("/disassemble")}
          className="p-1 -ml-1 rounded-md text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <Icon name="arrow_back" size={20} />
        </button>
        <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">New Appliance</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Unit photo — first, but disabled until R2 is configured */}
        <div className="opacity-50">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Unit Photo <span className="text-xs font-normal text-gray-400 dark:text-gray-500">(optional)</span>
          </p>
          {unitPhotoPreview ? (
            <div className="relative inline-block">
              <img
                src={unitPhotoPreview}
                alt="Unit preview"
                className="w-24 h-24 object-cover rounded-lg border border-gray-200 dark:border-gray-700"
              />
              <button
                type="button"
                onClick={removeUnitPhoto}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-700 dark:hover:bg-gray-300"
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 cursor-not-allowed">
              <Icon name="photo_camera" size={20} className="text-gray-400 dark:text-gray-500" />
              <span className="text-sm text-gray-400 dark:text-gray-500">Take unit photo</span>
            </div>
          )}
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1.5">
            R2 image storage is not configured. Add R2 credentials to enable photo uploads.
          </p>
        </div>

        {/* Sticker OCR section */}
        {!stickerDone && !stickerSkipped && (
          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Sticker Photo
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Take a photo of the model/serial sticker to auto-fill the fields below.
            </p>
            {ocrError && (
              <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-400">
                {ocrError}
              </div>
            )}
            {ocrLoading ? (
              <div className="flex items-center gap-2 px-4 py-3 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 text-sm text-gray-500 dark:text-gray-400">
                <Icon name="hourglass_top" size={18} className="animate-spin" />
                Analyzing sticker...
              </div>
            ) : (
              <div>
                <label className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 cursor-pointer hover:border-gray-400 dark:hover:border-gray-500">
                  <Icon name="photo_camera" size={20} className="text-gray-500 dark:text-gray-400" />
                  <span className="text-sm text-gray-600 dark:text-gray-300">Take sticker photo</span>
                  <input
                    ref={stickerInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="sr-only"
                    onChange={handleStickerCapture}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setStickerSkipped(true)}
                  className="mt-2 text-xs text-gray-500 dark:text-gray-400 underline underline-offset-2"
                >
                  Skip — enter manually
                </button>
              </div>
            )}
          </div>
        )}

        {stickerDone && (
          <div className="px-3 py-2.5 rounded-lg bg-green-50 dark:bg-green-900/20 text-sm text-green-700 dark:text-green-400">
            Sticker analyzed — fields populated below. Edit as needed.
          </div>
        )}

        {/* Form fields — always shown after sticker step resolved */}
        {showFields && (
          <>
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
              <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Model Number</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="e.g. WDT730PAHZ"
                maxLength={100}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Serial Number</label>
              <input
                type="text"
                value={serial}
                onChange={(e) => setSerial(e.target.value)}
                placeholder="e.g. F84726493"
                maxLength={100}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Type</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">Select type...</option>
                {APPLIANCE_TYPES.map((t) => (
                  <option key={t} value={t} className="capitalize">
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Notes</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Bottom freezer, pulled from job on Main St"
                maxLength={1000}
                rows={3}
                className={`${INPUT_CLASS} resize-none`}
              />
            </div>
          </>
        )}

        {photoWarning && (
          <div className="px-3 py-2.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-sm text-amber-700 dark:text-amber-400">
            {photoWarning}
          </div>
        )}

        {submitError && (
          <div className="px-3 py-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 text-sm text-red-700 dark:text-red-400">
            {submitError}
          </div>
        )}

        {showFields && (
          <button
            type="submit"
            disabled={submitting}
            className="w-full px-3 py-2.5 text-sm font-medium rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Creating..." : "Create Appliance"}
          </button>
        )}
      </form>
    </div>
  );
}
