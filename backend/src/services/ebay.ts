import { getDb } from "../db/index.js";
import {
  settings,
  parts,
  inventoryEvents,
  ebayProcessedOrders,
  ebayPollWatermark,
} from "../db/schema.js";
import { eq, sql, and } from "drizzle-orm";
import { encrypt, decrypt } from "./crypto.js";

const EBAY_API_BASE = "https://api.ebay.com";
const EBAY_AUTH_BASE = "https://auth.ebay.com";
const TOKEN_URL = `${EBAY_API_BASE}/identity/v1/oauth2/token`;
const FULFILLMENT_URL = `${EBAY_API_BASE}/sell/fulfillment/v1/order`;

const OVERLAP_MINUTES = 5;

interface EbayTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface EbayOrder {
  orderId: string;
  lineItems: Array<{
    lineItemId: string;
    legacyItemId: string;
    quantity: number;
  }>;
}

interface EbayOrdersResponse {
  orders: EbayOrder[];
  total: number;
  offset: number;
  limit: number;
}

function getEbayCredentials() {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const redirectUri = process.env.EBAY_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_REDIRECT_URI must be set");
  }

  return { clientId, clientSecret, redirectUri };
}

function getBasicAuthHeader(): string {
  const { clientId, clientSecret } = getEbayCredentials();
  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

export function buildAuthUrl(state: string): string {
  const { clientId, redirectUri } = getEbayCredentials();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
    state,
  });

  return `${EBAY_AUTH_BASE}/oauth2/authorize?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const { redirectUri } = getEbayCredentials();

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${getBasicAuthHeader()}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`eBay token exchange failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as EbayTokenResponse;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    expiresIn: data.expires_in,
  };
}

export async function refreshAccessToken(): Promise<string> {
  const db = getDb();
  const [row] = await db.select().from(settings).limit(1);

  if (!row?.ebayRefreshToken) {
    throw new Error("No eBay refresh token stored");
  }

  const refreshToken = decrypt(row.ebayRefreshToken);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${getBasicAuthHeader()}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`eBay token refresh failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as EbayTokenResponse;
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  await db
    .update(settings)
    .set({
      ebayAccessToken: encrypt(data.access_token),
      ebayTokenExpiresAt: expiresAt,
      ...(data.refresh_token ? { ebayRefreshToken: encrypt(data.refresh_token) } : {}),
    })
    .where(eq(settings.id, row.id));

  return data.access_token;
}

async function getValidAccessToken(): Promise<string> {
  const db = getDb();
  const [row] = await db.select().from(settings).limit(1);

  if (!row?.ebayAccessToken) {
    throw new Error("No eBay access token stored");
  }

  const bufferMs = 5 * 60 * 1000;
  if (!row.ebayTokenExpiresAt || row.ebayTokenExpiresAt.getTime() < Date.now() + bufferMs) {
    return await refreshAccessToken();
  }

  return decrypt(row.ebayAccessToken);
}

async function fetchOrders(
  accessToken: string,
  fromDate: Date,
  toDate: Date,
): Promise<EbayOrder[]> {
  const from = fromDate.toISOString();
  const to = toDate.toISOString();
  const filter = `creationdate:[${from}..${to}]`;

  const allOrders: EbayOrder[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const url = new URL(FULFILLMENT_URL);
    url.searchParams.set("filter", filter);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`eBay Fulfillment API error: ${response.status} ${body}`);
    }

    const data = (await response.json()) as EbayOrdersResponse;
    allOrders.push(...(data.orders || []));

    if (allOrders.length >= data.total || (data.orders || []).length < limit) {
      break;
    }
    offset += limit;
  }

  return allOrders;
}

async function processLineItem(
  orderId: string,
  lineItem: { lineItemId: string; legacyItemId: string; quantity: number },
): Promise<"processed" | "quarantined" | "skipped"> {
  const db = getDb();

  const [existing] = await db
    .select({ id: ebayProcessedOrders.id })
    .from(ebayProcessedOrders)
    .where(
      and(
        eq(ebayProcessedOrders.ebayOrderId, orderId),
        eq(ebayProcessedOrders.ebayLineItemId, lineItem.lineItemId),
      ),
    )
    .limit(1);

  if (existing) return "skipped";

  return await db.transaction(async (tx) => {
    const [part] = await tx
      .select()
      .from(parts)
      .where(eq(parts.ebayListingId, lineItem.legacyItemId))
      .for("update");

    if (!part) {
      await tx.insert(ebayProcessedOrders).values({
        ebayOrderId: orderId,
        ebayLineItemId: lineItem.lineItemId,
        partId: null,
        quantityDepleted: 0,
        quarantineReason: `No matching listing for eBay item ${lineItem.legacyItemId}`,
      });
      console.warn(`Quarantined: order ${orderId} line ${lineItem.lineItemId} — no matching listing ${lineItem.legacyItemId}`);
      return "quarantined";
    }

    const newQuantity = part.quantity - lineItem.quantity;
    const newListedQty = part.listedQuantity - lineItem.quantity;

    if (newQuantity < 0 || newListedQty < 0) {
      await tx.insert(ebayProcessedOrders).values({
        ebayOrderId: orderId,
        ebayLineItemId: lineItem.lineItemId,
        partId: part.id,
        quantityDepleted: 0,
        quarantineReason: `Invariant violation: quantity=${part.quantity}, listedQuantity=${part.listedQuantity}, sold=${lineItem.quantity}`,
      });
      console.warn(`Quarantined: order ${orderId} line ${lineItem.lineItemId} — invariant violation on part ${part.id}`);
      return "quarantined";
    }

    await tx
      .update(parts)
      .set({
        quantity: sql`${parts.quantity} - ${lineItem.quantity}`,
        listedQuantity: sql`${parts.listedQuantity} - ${lineItem.quantity}`,
        ...(newListedQty === 0 ? { ebayListingId: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(parts.id, part.id));

    await tx.insert(inventoryEvents).values({
      partId: part.id,
      eventType: "ebay_sold",
      quantityChange: -lineItem.quantity,
      note: `eBay order #${orderId}`,
    });

    await tx.insert(ebayProcessedOrders).values({
      ebayOrderId: orderId,
      ebayLineItemId: lineItem.lineItemId,
      partId: part.id,
      quantityDepleted: lineItem.quantity,
      quarantineReason: null,
    });

    console.log(`Processed: order ${orderId} line ${lineItem.lineItemId} — depleted ${lineItem.quantity} of part ${part.id}`);
    return "processed";
  });
}

export async function pollEbayOrders(): Promise<{ processed: number; quarantined: number }> {
  const db = getDb();

  const [settingsRow] = await db.select().from(settings).limit(1);
  if (!settingsRow?.ebayEnabled || !settingsRow.ebayRefreshToken) {
    return { processed: 0, quarantined: 0 };
  }

  const [watermark] = await db.select().from(ebayPollWatermark).limit(1);
  if (!watermark) {
    throw new Error("eBay poll watermark not initialized — complete OAuth flow first");
  }

  const accessToken = await getValidAccessToken();

  const now = new Date();
  const fromDate = new Date(watermark.lastPolledAt.getTime() - OVERLAP_MINUTES * 60 * 1000);

  const orders = await fetchOrders(accessToken, fromDate, now);

  let processed = 0;
  let quarantined = 0;

  for (const order of orders) {
    for (const lineItem of order.lineItems) {
      const status = await processLineItem(order.orderId, lineItem);
      if (status === "processed") processed++;
      else if (status === "quarantined") quarantined++;
    }
  }

  await db
    .update(ebayPollWatermark)
    .set({ lastPolledAt: now })
    .where(eq(ebayPollWatermark.id, watermark.id));

  console.log(`eBay poll complete: ${processed} processed, ${quarantined} quarantined from ${orders.length} orders`);
  return { processed, quarantined };
}
