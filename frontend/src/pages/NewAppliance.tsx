import { useEffect, useState, useRef, type FormEvent, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, apiUpload, ApiError } from "../api/client";
import { Icon } from "../components/Icon";
import { useSettings } from "../hooks/useSettings";
import { IMAGE_ACCEPT, prepareImageFile } from "../lib/image-upload";

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

export function NewAppliance() {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const photoStorageConfigured = settings?.imageStorage?.configured ?? false;

  // Sticker OCR state
  const [stickerDone, setStickerDone] = useState(false);
  const [stickerSkipped, setStickerSkipped] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState("");
  const [ocrProgress, setOcrProgress] = useState(0);
  const [stickerFile, setStickerFile] = useState<File | null>(null);
  const [stickerRetryable, setStickerRetryable] = useState(false);
  const stickerInputRef = useRef<HTMLInputElement>(null);

  // Unit photo state
  const [unitPhoto, setUnitPhoto] = useState<File | null>(null);
  const [unitPhotoPreview, setUnitPhotoPreview] = useState<string | null>(null);
  const [uploadedPhotoKey, setUploadedPhotoKey] = useState<string | null>(null);
  const [photoProgress, setPhotoProgress] = useState(0);
  const unitInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => () => {
    if (unitPhotoPreview) URL.revokeObjectURL(unitPhotoPreview);
  }, [unitPhotoPreview]);

  async function processSticker(file: File, alreadyPrepared = false) {
    setOcrError("");
    setOcrLoading(true);
    setOcrProgress(0);
    let uploadFile = file;
    let canRetry = alreadyPrepared;
    try {
      if (!alreadyPrepared) {
        uploadFile = await prepareImageFile(file);
        canRetry = true;
      }
      setStickerFile(uploadFile);
      const result = await apiUpload<{ brand?: string; modelNumber?: string; serialNumber?: string; applianceType?: string }>(
        "/api/appliances/ocr",
        uploadFile,
        { onProgress: setOcrProgress },
      );
      if (result.brand) setBrand(result.brand);
      if (result.modelNumber) setModel(result.modelNumber);
      if (result.serialNumber) setSerial(result.serialNumber);
      if (result.applianceType) setType(result.applianceType);
      setStickerDone(true);
      setStickerFile(null);
      setStickerRetryable(false);
    } catch (err: any) {
      setStickerFile(uploadFile);
      setStickerRetryable(canRetry && (!(err instanceof ApiError) || err.retryable !== false));
      setOcrError(err.message || "Sticker scan failed. Tap Retry to try again");
    } finally {
      setOcrLoading(false);
      if (stickerInputRef.current) stickerInputRef.current.value = "";
    }
  }

  async function handleStickerCapture(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) await processSticker(file);
  }

  async function handleUnitCapture(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoWarning("");
    try {
      const prepared = await prepareImageFile(file);
      setUnitPhoto(prepared);
      setUploadedPhotoKey(null);
      setUnitPhotoPreview(URL.createObjectURL(prepared));
    } catch (error) {
      setPhotoWarning(error instanceof Error ? error.message : "Could not prepare this photo");
    } finally {
      if (unitInputRef.current) unitInputRef.current.value = "";
    }
  }

  function removeUnitPhoto() {
    setUnitPhoto(null);
    setUploadedPhotoKey(null);
    setUnitPhotoPreview(null);
    setPhotoProgress(0);
    setPhotoWarning("");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError("");
    setPhotoWarning("");
    setSubmitting(true);

    let photoKey = uploadedPhotoKey ?? undefined;

    // Try uploading unit photo
    if (unitPhoto && !photoKey) {
      try {
        const result = await apiUpload<{ key: string }>("/api/appliances/upload", unitPhoto, {
          onProgress: setPhotoProgress,
        });
        photoKey = result.key;
        setUploadedPhotoKey(result.key);
      } catch (err: any) {
        setPhotoWarning(err.message || "Photo upload failed. Your photo is still selected; retry or remove it");
        setSubmitting(false);
        return;
      }
    }

    try {
      const result = await api<{ id: number }>("/api/appliances", {
        method: "POST",
        body: JSON.stringify({
          brand: brand.trim() || undefined,
          modelNumber: model.trim() || undefined,
          serialNumber: serial.trim() || undefined,
          applianceType: type || undefined,
          notes: notes.trim() || undefined,
          photoKey,
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
        {/* Unit photo — enabled only when the backend reports configured storage */}
        <div className={photoStorageConfigured ? "" : "opacity-50"}>
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
          ) : photoStorageConfigured ? (
            <label className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 cursor-pointer hover:border-gray-400 dark:hover:border-gray-500">
              <Icon name="photo_camera" size={20} className="text-gray-500 dark:text-gray-400" />
              <span className="text-sm text-gray-600 dark:text-gray-300">Take or choose unit photo</span>
              <input
                ref={unitInputRef}
                type="file"
                accept={IMAGE_ACCEPT}
                capture="environment"
                className="sr-only"
                onChange={handleUnitCapture}
              />
            </label>
          ) : (
            <div className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 cursor-not-allowed">
              <Icon name="photo_camera" size={20} className="text-gray-400 dark:text-gray-500" />
              <span className="text-sm text-gray-400 dark:text-gray-500">Take unit photo</span>
            </div>
          )}
          {!photoStorageConfigured && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1.5">
              Photo storage is not configured. Add R2 credentials to enable unit photos.
            </p>
          )}
          {submitting && unitPhoto && photoProgress < 100 && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5">Uploading photo {photoProgress}%...</p>
          )}
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
              <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-400 flex items-center justify-between gap-3">
                <span>{ocrError}</span>
                {stickerFile && stickerRetryable && (
                  <button type="button" className="font-semibold underline shrink-0" onClick={() => processSticker(stickerFile, true)}>
                    Retry
                  </button>
                )}
              </div>
            )}
            {ocrLoading ? (
              <div className="flex items-center gap-2 px-4 py-3 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 text-sm text-gray-500 dark:text-gray-400">
                <Icon name="hourglass_top" size={18} className="animate-spin" />
                {ocrProgress < 100 ? `Uploading ${ocrProgress}%...` : "Analyzing sticker..."}
              </div>
            ) : (
              <div>
                <label className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 cursor-pointer hover:border-gray-400 dark:hover:border-gray-500">
                  <Icon name="photo_camera" size={20} className="text-gray-500 dark:text-gray-400" />
                  <span className="text-sm text-gray-600 dark:text-gray-300">Take sticker photo</span>
                  <input
                    ref={stickerInputRef}
                    type="file"
                    accept={IMAGE_ACCEPT}
                    capture="environment"
                    className="sr-only"
                    onChange={handleStickerCapture}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setStickerSkipped(true);
                    setStickerFile(null);
                    setOcrError("");
                  }}
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
            {submitting
              ? unitPhoto && !uploadedPhotoKey && photoProgress < 100
                ? `Uploading photo ${photoProgress}%...`
                : "Creating..."
              : photoWarning && unitPhoto && !uploadedPhotoKey
                ? "Retry Photo Upload"
                : "Create Appliance"}
          </button>
        )}
      </form>
    </div>
  );
}
