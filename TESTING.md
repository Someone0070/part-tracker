# Part Tracker Testing Guide

## Test environment

- Production site: <https://part-tracker-d4r.pages.dev>

Use that exact URL. Do not use `https://part-tracker.pages.dev` (it is a different application) or the Railway backend URL (it is not a public browser entry point).
- Obtain the login password from the owner through a private channel.
- Test on a phone first. If possible, repeat the core workflows on a desktop browser.
- Record the device, operating system, browser, and approximate test time.

This site uses the production database. Prefix every test part number and note with
`TEST-<your initials>-<date>` so test data is easy to identify. Do not change real
inventory records.

## Do not modify without the owner's approval

The following settings can interrupt real integrations or invalidate credentials:

- Do not disconnect or pause eBay.
- Do not generate, regenerate, or revoke an API key.
- Do not add, replace, or delete vendor cookies.
- Do not delete learned templates.
- Do not change the account password.

It is fine to open these sections and report display or usability problems.

## 1. Login and navigation

1. Sign in with the supplied password.
2. Refresh the browser and confirm the session remains active.
3. Open the Catalog, Add Part, Import, and Settings tabs. The Disassemble tab is outside this
   test and should be ignored.
4. Use the browser Back button from detail screens.
5. Confirm the layout works without clipped controls, overlapping text, or blank screens.
6. Test Log out last, then confirm the protected app cannot be opened without signing in again.

Expected result: navigation is responsive, the selected tab is clear, and authentication
survives an ordinary refresh.

## 2. Catalog and part details

1. Search using a full part number.
2. Search using only part of a part number.
3. Search for a value that does not exist and confirm a clear empty state appears.
4. Open a part and verify its part number, brand, description, total quantity, available
   quantity, listed quantity, cross-references, and activity history.
5. Open and cancel each action menu without saving changes.

For a test record only:

1. Edit the brand and description and confirm the Catalog updates.
2. Mark one unit Used or Sold and confirm the quantity and activity history update once.
3. Try to remove more units than are available and confirm the app refuses the action.
4. Delete the test record and confirm it disappears from search.

Current quantity behavior: a part can have more than one unit. Adding an existing normalized
part number increases its quantity instead of creating a second Catalog row.

## 3. Add Part — manual

1. Open Add Part and select Manual.
2. Create a unique test part with part number, brand, description, note, and quantity `1`.
3. Confirm the success message appears and the form resets.
4. Find the part in Catalog and confirm all saved values are correct.
5. Add the same part number once more and confirm its quantity increases rather than creating
   a duplicate row.
6. Try submitting without a part number and with unusually long text.

Expected result: validation is understandable, one click creates one inventory event, and
repeated clicks do not accidentally add extra stock.

## 4. Add Part — photo scan

Use realistic part labels when possible; this scan extracts a part number, brand, and
description. It does not save anything until Add Part is pressed.

Test several of the following:

- A new camera photo and an existing gallery photo.
- JPEG and PNG.
- iPhone HEIC/HEIF, if available.
- Android WebP or AVIF, if available.
- Portrait, landscape, and rotated photos.
- A large high-resolution phone photo.
- A dim, blurry, or partially cropped label.

For each image:

1. Confirm upload progress appears.
2. Confirm the app changes from uploading to analyzing.
3. Compare every detected value with the label.
4. Correct an incorrect value and confirm the field remains editable.
5. Save only clearly marked test data, then verify it in Catalog.

Expected result: supported phone photos are accepted, orientation is correct, and OCR mistakes
can be corrected before saving.

## 5. Add Part — bulk scan

1. Select three to five label photos together.
2. Mix orientations and image formats when possible.
3. Confirm every selected photo produces its own result or its own clear error.
4. Edit a detected part number or brand.
5. Retry one failed image.
6. Remove one unwanted result.
7. Add the remaining valid results and verify them in Catalog.

Expected result: one failed photo does not discard successful photos, and retrying one item
does not rescan or duplicate the others. Bulk scan adds each result with quantity `1`.

## 6. Poor and interrupted network testing

Do these tests without refreshing the page. A full refresh cannot retain a browser-selected
file because browsers intentionally block that behavior.

1. Turn on airplane mode, select a photo, and attempt a scan.
2. Confirm the app immediately reports that it is offline.
3. Reconnect and use Retry; do not select the photo again.
4. Start another upload, interrupt Wi-Fi or mobile data during the upload, wait for the error,
   reconnect, and use Retry.
5. On desktop, optionally use browser developer tools to select a Slow 3G network profile.
6. Watch for duplicate results after an automatic or manual retry.

Expected result: the page remains usable, progress is visible, errors explain what to do, and
the selected photo remains available for Retry. A retry must not create duplicate work or data.

## 7. Invalid-image handling

Try any samples that are easy to obtain:

- A GIF image.
- A zero-byte or damaged image.
- A non-image file renamed with `.jpg`.
- An image larger than 25 MB.

Expected result: the app rejects the file with a specific, understandable message. It must not
freeze, show a blank screen, expose technical provider details, or repeatedly retry a file that
cannot succeed.

## 8. Import — PDF Upload

PDF import extracts and previews order information; it does not add the results to Catalog.

1. Upload a representative vendor invoice or order PDF.
2. Watch the processing steps complete.
3. Verify vendor, order number, order date, technician, tracking number, courier, part names,
   part numbers, quantities, prices, shipping, and tax against the document.
4. Expand Raw text and check that useful document text was extracted.
5. Repeat with a different document.
6. If time permits, compare Template, Template+, and LLM Only modes.
7. Try a scanned/low-quality PDF and an invalid or oversized document.

Never share a document containing customer addresses, payment information, credentials, or
other sensitive data unless the owner explicitly approved that test file.

Expected result: extraction is accurate, missing values say `Not provided`, failures are clear,
and uploading a different document resets the previous result.

## 9. Import — URL Import

URL import fetches and previews order information; it does not add results to Catalog.

1. Paste a supported order URL provided by the owner.
2. Confirm the loading state appears and the page stays responsive.
3. Compare every extracted field with the source order.
4. Try an invalid URL and an unsupported site.
5. If the app reports missing or expired cookies, confirm it links to Settings.

Do not paste private login links or change vendor cookies without approval.

## 10. Settings and general quality

1. Toggle Dark mode and confirm every page remains readable.
2. Toggle Dark mode back to its original value when finished.
3. Inspect the other Settings sections without changing protected integrations or credentials.
4. Look for slow actions, buttons that can be clicked twice, stale values after navigation,
   confusing wording, inaccessible controls, and mobile keyboard/layout problems.
5. Leave the app idle for several minutes, return, and confirm it either continues normally or
   clearly asks for authentication again.

## Reporting a problem

Send one report per problem using this template:

```text
Title:
Date and exact time:
Device / OS / browser:
Page:
What I was trying to do:
Exact steps:
Expected result:
Actual result:
Did Retry help?:
Network condition:
File type and approximate size, if applicable:
Screenshot or screen recording:
```

Report incorrect extracted data as a bug even if the workflow technically completed. Include
the expected value, the detected value, and a cropped screenshot of the relevant label or
document section when it is safe to share.

## Cleanup

At the end of testing:

1. Delete all test parts you created.
2. Restore Dark mode and any safe toggles to their original values.
3. Confirm no real records, eBay settings, API keys, vendor cookies, templates, or passwords
   were changed.
4. Send the completed issue reports and a short list of workflows that passed without problems.
