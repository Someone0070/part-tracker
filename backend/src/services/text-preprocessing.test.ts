import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripBoilerplate, stripForFillIn } from "./text-preprocessing.js";

// --- stripBoilerplate ---

describe("stripBoilerplate: legal prose", () => {
  it("removes long lines with no dollar, no date, no key:value", () => {
    const longLegal =
      "This invoice is subject to the terms and conditions set forth in the master service agreement executed by both parties which governs all transactions.";
    const result = stripBoilerplate(longLegal);
    assert.equal(result.trim(), "");
  });

  it("keeps long lines that contain a dollar amount", () => {
    const line =
      "The total amount due for this invoice including all applicable fees is $1,234.56 payable within 30 days.";
    const result = stripBoilerplate(line);
    assert.ok(result.includes("$1,234.56"));
  });

  it("keeps long lines that contain a date", () => {
    const line =
      "This agreement was signed on 03/15/2024 and supersedes all prior agreements between the parties hereto regarding this subject matter.";
    const result = stripBoilerplate(line);
    assert.ok(result.includes("03/15/2024"));
  });

  it("keeps lines with key:value structure even when long", () => {
    const line = "Ship Via: FedEx Ground 2-Day Delivery with tracking number provided via email";
    const result = stripBoilerplate(line);
    assert.ok(result.includes("Ship Via:"));
  });

  it("keeps short lines (<=80 chars) regardless of content", () => {
    const line = "All sales are final and non-refundable per company policy.";
    assert.ok(line.length <= 80);
    const result = stripBoilerplate(line);
    assert.ok(result.includes(line));
  });

  it("keeps lines with YYYY-MM-DD date pattern", () => {
    const line =
      "This order was placed on 2024-03-15 and all terms herein shall remain binding until the completion of delivery and payment.";
    const result = stripBoilerplate(line);
    assert.ok(result.includes("2024-03-15"));
  });

  it("keeps lines with month name date patterns", () => {
    const line =
      "Payment is due by January 31st and any amounts not received by that date will incur a late fee of two percent per month outstanding.";
    const result = stripBoilerplate(line);
    assert.ok(result.includes("January"));
  });
});

describe("stripBoilerplate: boilerplate section headers", () => {
  it("removes TERMS: header and its body", () => {
    const text = [
      "Order #12345",
      "TERMS:",
      "Net 30 days from invoice date.",
      "Late payments subject to 1.5% monthly interest.",
      "",
      "Ship To: Customer Name",
    ].join("\n");
    const result = stripBoilerplate(text);
    assert.ok(!result.includes("TERMS:"));
    assert.ok(!result.includes("Net 30 days"));
    assert.ok(!result.includes("Late payments subject"));
    assert.ok(result.includes("Order #12345"));
    assert.ok(result.includes("Ship To:"));
  });

  it("removes RETURNS: header and its body", () => {
    const text = [
      "Invoice #999",
      "RETURNS:",
      "Returns accepted within 30 days.",
      "Original packaging required.",
      "",
      "Total: $50.00",
    ].join("\n");
    const result = stripBoilerplate(text);
    assert.ok(!result.includes("RETURNS:"));
    assert.ok(!result.includes("Returns accepted"));
    assert.ok(result.includes("Total: $50.00"));
  });

  it("removes WARRANTY: header and body", () => {
    const text = [
      "Part: WPW10321304",
      "WARRANTY:",
      "90-day limited warranty on parts.",
      "",
      "Qty: 2",
    ].join("\n");
    const result = stripBoilerplate(text);
    assert.ok(!result.includes("WARRANTY:"));
    assert.ok(!result.includes("90-day limited warranty"));
    assert.ok(result.includes("Part: WPW10321304"));
  });

  it("removes Return Policy: header and body", () => {
    const text = [
      "Order Date: 01/15/2024",
      "Return Policy:",
      "No returns on electrical parts.",
      "",
      "Amount: $25.00",
    ].join("\n");
    const result = stripBoilerplate(text);
    assert.ok(!result.includes("Return Policy:"));
    assert.ok(!result.includes("No returns on electrical"));
  });

  it("removes Remit to header and body", () => {
    const text = [
      "Invoice Total: $500.00",
      "Remit to",
      "ACME Parts Co.",
      "PO Box 1234",
      "",
      "Customer: John Doe",
    ].join("\n");
    const result = stripBoilerplate(text);
    assert.ok(!result.includes("Remit to"));
    assert.ok(!result.includes("ACME Parts Co."));
    assert.ok(result.includes("Invoice Total: $500.00"));
  });

  it("removes ACH header and body", () => {
    const text = [
      "Subtotal: $200.00",
      "ACH",
      "Routing: 021000021",
      "Account: 123456789",
      "",
      "Tax: $15.00",
    ].join("\n");
    const result = stripBoilerplate(text);
    assert.ok(!result.includes("ACH"));
    assert.ok(!result.includes("Routing:"));
  });

  it("removes Wire Info header and body", () => {
    const text = [
      "Order: ORD-001",
      "Wire Info",
      "Bank: First National",
      "SWIFT: FNBKUS33",
      "",
      "Ship Date: 01/20/2024",
    ].join("\n");
    const result = stripBoilerplate(text);
    assert.ok(!result.includes("Wire Info"));
    assert.ok(!result.includes("SWIFT:"));
  });
});

describe("stripBoilerplate: payment lines", () => {
  it("removes VISA payment confirmation line", () => {
    const text = [
      "Order: ORD-555",
      "VISA ending 4242 charged $150.00",
      "Tracking: 1Z999AA10123456784",
    ].join("\n");
    const result = stripBoilerplate(text);
    assert.ok(!result.includes("VISA ending 4242"));
    assert.ok(result.includes("Order: ORD-555"));
  });

  it("removes Mastercard payment line", () => {
    const line = "Mastercard xxxx-9999 payment of $75.50 processed";
    const result = stripBoilerplate(line);
    assert.equal(result.trim(), "");
  });

  it("removes PayPal payment line", () => {
    const line = "PayPal payment received: $250.00";
    const result = stripBoilerplate(line);
    assert.equal(result.trim(), "");
  });

  it("removes 'payment' keyword with dollar amount", () => {
    const line = "payment applied: $99.95";
    const result = stripBoilerplate(line);
    assert.equal(result.trim(), "");
  });

  it("keeps 'payment' line without dollar amount", () => {
    const line = "Payment terms: Net 30";
    const result = stripBoilerplate(line);
    assert.ok(result.includes("Payment terms:"));
  });
});

describe("stripBoilerplate: page markers", () => {
  it("removes '-- N of N --' format", () => {
    const text = "Item: Widget\n-- 1 of 3 --\nPrice: $10.00";
    const result = stripBoilerplate(text);
    assert.ok(!result.includes("-- 1 of 3 --"));
    assert.ok(result.includes("Item: Widget"));
  });

  it("removes 'Page N of N' format", () => {
    const text = "Invoice #001\nPage 2 of 5\nTotal: $500.00";
    const result = stripBoilerplate(text);
    assert.ok(!result.includes("Page 2 of 5"));
  });

  it("removes 'Page N' format", () => {
    const text = "Line item data\nPage 3\nMore data";
    const result = stripBoilerplate(text);
    assert.ok(!result.includes("Page 3"));
  });
});

describe("stripBoilerplate: corporate contact blocks", () => {
  it("removes consecutive phone/fax/www block", () => {
    const text = [
      "Vendor: ACME Parts",
      "(800) 555-1234",
      "Fax: (800) 555-5678",
      "www.acmeparts.com",
      "Order #: ORD-001",
    ].join("\n");
    const result = stripBoilerplate(text);
    assert.ok(!result.includes("(800) 555-1234"));
    assert.ok(!result.includes("(800) 555-5678"));
    assert.ok(!result.includes("www.acmeparts.com"));
    assert.ok(result.includes("Vendor: ACME Parts"));
    assert.ok(result.includes("Order #: ORD-001"));
  });

  it("keeps a single phone number line (not consecutive contact block)", () => {
    const text = [
      "Contact: John Smith",
      "(312) 555-9999",
      "Order placed successfully",
    ].join("\n");
    const result = stripBoilerplate(text);
    // Single phone line should be kept (not a multi-line contact block)
    assert.ok(result.includes("(312) 555-9999"));
  });

  it("keeps ship-to address even with phone-like content", () => {
    const text = [
      "Ship To: Customer Name",
      "(800) 555-0000",
      "123 Main St",
      "",
      "Order: ORD-002",
    ].join("\n");
    const result = stripBoilerplate(text);
    // Ship-to context should protect the phone from contact-block removal
    assert.ok(result.includes("Ship To:"));
  });

  it("removes Website and Telephone keyword lines in consecutive block", () => {
    const text = [
      "Order #: 9001",
      "Website: www.example.com",
      "Telephone: (555) 123-4567",
      "Item: Part #WPW10321304",
    ].join("\n");
    const result = stripBoilerplate(text);
    assert.ok(!result.includes("Website:"));
    assert.ok(!result.includes("Telephone:"));
    assert.ok(result.includes("Item:"));
  });
});

describe("stripBoilerplate: OCR deduplication", () => {
  it("strips exact duplicate OCR lines that appear in pdf-parse section", () => {
    const text = [
      "Order #: 12345",
      "Part: WPW10321304",
      "Total: $50.00",
      "",
      "--- OCR-enhanced text ---",
      "Order #: 12345",
      "Part: WPW10321304",
      "Extra OCR detail: Model ABC123",
    ].join("\n");
    const result = stripBoilerplate(text);
    // The OCR separator section should only contain the unique OCR line
    const parts = result.split("--- OCR-enhanced text ---");
    if (parts.length === 2) {
      assert.ok(!parts[1].includes("Order #: 12345"), "duplicate order number removed from OCR");
      assert.ok(!parts[1].includes("Part: WPW10321304"), "duplicate part removed from OCR");
      assert.ok(parts[1].includes("Extra OCR detail:"), "unique OCR content kept");
    }
  });

  it("strips near-exact duplicates after normalizing whitespace", () => {
    const text = [
      "Invoice  Total:   $200.00",
      "",
      "--- OCR-enhanced text ---",
      "Invoice Total: $200.00",
      "Unique OCR line here",
    ].join("\n");
    const result = stripBoilerplate(text);
    // The OCR section should not contain the whitespace-normalized duplicate
    const parts = result.split("--- OCR-enhanced text ---");
    if (parts.length === 2) {
      assert.ok(!parts[1].includes("Invoice Total: $200.00"), "near-exact dup removed");
      assert.ok(parts[1].includes("Unique OCR line"), "unique kept");
    }
  });

  it("keeps all pdf-parse content when OCR has unique lines", () => {
    const text = [
      "Order: 555",
      "--- OCR-enhanced text ---",
      "Only in OCR: serial ABC",
    ].join("\n");
    const result = stripBoilerplate(text);
    assert.ok(result.includes("Order: 555"));
    assert.ok(result.includes("Only in OCR:"));
  });

  it("omits OCR separator section when all OCR lines are duplicates", () => {
    const text = [
      "Order: 555",
      "Part: WPW10321304",
      "--- OCR-enhanced text ---",
      "Order: 555",
      "Part: WPW10321304",
    ].join("\n");
    const result = stripBoilerplate(text);
    // No unique OCR content -- separator should not appear
    assert.ok(!result.includes("--- OCR-enhanced text ---"));
  });
});

describe("stripBoilerplate: preserves important content", () => {
  it("keeps order number, part numbers, prices", () => {
    const text = [
      "Order #: ORD-2024-001",
      "Part: WPW10321304",
      "Qty: 2",
      "Unit Price: $45.00",
      "Total: $90.00",
    ].join("\n");
    const result = stripBoilerplate(text);
    assert.ok(result.includes("Order #:"));
    assert.ok(result.includes("WPW10321304"));
    assert.ok(result.includes("$45.00"));
    assert.ok(result.includes("$90.00"));
  });

  it("keeps ship-to address block", () => {
    const text = [
      "Ship To: John Doe",
      "123 Main St",
      "Chicago, IL 60601",
      "",
      "Order: ORD-001",
    ].join("\n");
    const result = stripBoilerplate(text);
    assert.ok(result.includes("Ship To: John Doe"));
  });

  it("keeps blank lines (preserves structure)", () => {
    const text = "Line one\n\nLine two";
    const result = stripBoilerplate(text);
    assert.ok(result.includes("\n\n"));
  });
});

// --- stripForFillIn ---

describe("stripForFillIn: matched item rows", () => {
  it("removes exact matched item rows", () => {
    const clean = [
      "Order: ORD-001",
      "WPW10321304   2   $45.00   $90.00",
      "DC47-00019A   1   $12.00   $12.00",
      "Total: $102.00",
    ].join("\n");
    const matched = [
      "WPW10321304   2   $45.00   $90.00",
      "DC47-00019A   1   $12.00   $12.00",
    ];
    const result = stripForFillIn(clean, matched);
    assert.ok(!result.includes("WPW10321304   2   $45.00"));
    assert.ok(!result.includes("DC47-00019A   1   $12.00"));
    assert.ok(result.includes("Total: $102.00"));
  });

  it("trims whitespace when matching rows", () => {
    const clean = "Order: ORD-001\n  Part row   \nTotal: $50.00";
    const matched = ["Part row"];
    const result = stripForFillIn(clean, matched);
    assert.ok(!result.includes("Part row"));
    assert.ok(result.includes("Total: $50.00"));
  });

  it("keeps unmatched lines intact", () => {
    const clean = "Order: ORD-001\nTracking: 1Z999\nTotal: $50.00";
    const matched = ["Some other line"];
    const result = stripForFillIn(clean, matched);
    assert.ok(result.includes("Tracking: 1Z999"));
    assert.ok(result.includes("Total: $50.00"));
  });
});

describe("stripForFillIn: address blocks", () => {
  it("removes street address lines outside ship-to block", () => {
    const clean = [
      "Order: ORD-001",
      "123 Industrial Blvd",
      "Total: $50.00",
    ].join("\n");
    const result = stripForFillIn(clean, []);
    assert.ok(!result.includes("123 Industrial Blvd"));
    assert.ok(result.includes("Total: $50.00"));
  });

  it("removes city/state/zip lines outside ship-to block", () => {
    const clean = [
      "Order: ORD-001",
      "Chicago, IL 60601",
      "Total: $50.00",
    ].join("\n");
    const result = stripForFillIn(clean, []);
    assert.ok(!result.includes("Chicago, IL 60601"));
  });

  it("keeps ship-to name (first line after Ship To: header)", () => {
    const clean = [
      "Ship To: John Doe",
      "456 Oak Ave",
      "Dallas, TX 75201",
      "",
      "Total: $75.00",
    ].join("\n");
    const result = stripForFillIn(clean, []);
    assert.ok(result.includes("Ship To: John Doe"), "header kept");
    assert.ok(!result.includes("456 Oak Ave"), "address line stripped");
    assert.ok(!result.includes("Dallas, TX 75201"), "city/state stripped");
    assert.ok(result.includes("Total: $75.00"));
  });

  it("keeps non-address lines after ship-to name", () => {
    const clean = [
      "Ship To: John Doe",
      "456 Oak Ave",
      "Order notes: hold for pickup",
      "Total: $75.00",
    ].join("\n");
    const result = stripForFillIn(clean, []);
    // "Order notes:" is not an address line -- should be kept
    assert.ok(result.includes("Order notes:"));
  });

  it("handles Ship To: on its own line followed by name on next line", () => {
    const clean = [
      "Ship To:",
      "Jane Smith",
      "789 Elm Street",
      "Boston, MA 02101",
      "",
      "Part: WPW10321304",
    ].join("\n");
    const result = stripForFillIn(clean, []);
    assert.ok(result.includes("Ship To:"));
    assert.ok(result.includes("Jane Smith"), "ship-to name preserved");
    assert.ok(!result.includes("789 Elm Street"), "address stripped");
    assert.ok(!result.includes("Boston, MA"), "city/state stripped");
    assert.ok(result.includes("Part: WPW10321304"));
  });
});

describe("stripForFillIn: combined", () => {
  it("strips both matched rows and address blocks in one pass", () => {
    const clean = [
      "Order: ORD-999",
      "Ship To: Customer Corp",
      "1000 Commerce Dr",
      "Houston, TX 77001",
      "",
      "WPW10321304   1   $45.00   $45.00",
      "DC47-00019A   2   $12.00   $24.00",
      "Total: $69.00",
    ].join("\n");
    const matched = [
      "WPW10321304   1   $45.00   $45.00",
      "DC47-00019A   2   $12.00   $24.00",
    ];
    const result = stripForFillIn(clean, matched);
    assert.ok(result.includes("Order: ORD-999"));
    assert.ok(result.includes("Ship To: Customer Corp"));
    assert.ok(!result.includes("1000 Commerce Dr"));
    assert.ok(!result.includes("Houston, TX"));
    assert.ok(!result.includes("WPW10321304   1"));
    assert.ok(!result.includes("DC47-00019A   2"));
    assert.ok(result.includes("Total: $69.00"));
  });

  it("empty matchedRowLines does not crash", () => {
    const clean = "Order: ORD-001\nTotal: $50.00";
    const result = stripForFillIn(clean, []);
    assert.ok(result.includes("Order: ORD-001"));
  });

  it("empty text returns empty string", () => {
    const result = stripForFillIn("", []);
    assert.equal(result, "");
  });
});
