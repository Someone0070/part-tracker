export interface ExtractedItem {
  partNumber: string;
  partName: string;
  quantity: number;
  unitPrice: number | null;
  shipCost: number | null;
  taxPrice: number | null;
  brand: string | null;
}

export interface DocumentResult {
  vendor: string;
  orderNumber: string | null;
  orderDate: string | null;
  technicianName: string | null;
  trackingNumber: string | null;
  deliveryCourier: string | null;
  items: ExtractedItem[];
  rawText: string;
}

export interface FieldRule {
  regex: string;
  group: number;
}

export interface ExtractionRules {
  vendorName: string;
  vendorSignals: {
    domains: string[];
    keywords: string[];
  };
  fields: Record<string, FieldRule>;
  lineItems: {
    start: string;
    end: string;
    row: string;
  };
  totals: Record<string, string>;
}

export interface VendorTemplate {
  id: number;
  vendorKey: string;
  vendorName: string;
  vendorDomains: string[];
  vendorKeywords: string[];
  extractionRules: ExtractionRules;
  successCount: number;
  failCount: number;
}

export interface VendorMatch {
  template: VendorTemplate;
  confidence: "domain" | "keyword";
}

export type StepCallback = (step: string, message: string) => void;

export function deriveVendorKey(signals: { domains: string[]; keywords: string[] }): string {
  if (signals.domains.length > 0) {
    return signals.domains[0].toLowerCase();
  }
  return signals.keywords[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") ?? "unknown";
}
