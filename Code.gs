/**
 * NEXS Live Pickup Monitor — Google Apps Script
 *
 * Sheet "Snapshot"            → the original domestic dashboard (unchanged)
 * Sheet "International"       → NEW: isInternationalOrder dashboard, one row,
 *                                 broken down by courier × FR_TAG × status
 * Sheet "InternationalShipments" → NEW: every individual shipment ID from the
 *                                 latest international push (fully overwritten
 *                                 each push, never piles up)
 *
 * Push types (doPost payload.type):
 *   1. "snapshot"          → manifest done counts (filter API bookmarklet)
 *   2. "monitorSnapshot"   → B2C / B2B / Store Packing (monitor bookmarklet)
 *   3. "combinedSnapshot"  → all four dashboard columns in one live cycle
 *   4. "internationalSnapshot" → NEW: international matrix + shipment IDs
 *   5. "packingPrintList"    → NEW: FR1+FR2 Packing shipments → "PackingPrintList"
 *                             sheet (Shipping Package ID, Shipping Provider Code,
 *                             Store Code, Bin Code). Sheet is fully overwritten
 *                             on every push.
 *
 * GET (doGet):
 *   ?type=international            → International sheet, as flat JSON
 *   ?type=international&includeShipments=true
 *                                   → same, plus a "shipments" array pulled
 *                                     from InternationalShipments
 *   ?type=packingPrintList         → { runId, timestamp, rowCount } of last push
 *                                     timestamp is when Apps Script received it
 *                                     (add &includeRows=true for the rows too)
 *   (no ?type, or anything else)   → original Snapshot sheet (unchanged)
 *
 * Deploy as:
 *   Execute as → Me
 *   Who has access → Anyone
 */

const SNAPSHOT_SHEET = "Snapshot";
const INTERNATIONAL_SHEET = "International";
const INTL_SHIPMENTS_SHEET = "InternationalShipments";
const PACKING_PRINT_SHEET = "PackingPrintList";
const PACKING_PRINT_HEADERS = ["Shipping Package ID", "Shipping Provider Code", "Store Code", "Bin Code"];

const COURIERS = [
  "BLITZNDD", "BLUEDART", "BUSYBEESPPD", "BusybeesSDD",
  "DELCARTB2B", "DELHIVERY", "DELHIVERYPDS", "DOT",
  "DTDCVB2B", "FASTBEETLE", "GPSUPPLY", "PURPLEDRONE",
  "SHADOWFAX", "SHADOWFAXNCR", "shreerajxpress", "Velocity", "XPRESSBEES"
];

// Column groups, in header order (domestic "Snapshot" sheet only)
const FIELD_GROUPS = ["manifest", "b2c", "b2b", "storePacking"];

// ── NEW: international dashboard config ────────────────────────────────────
// The 3 couriers requested for the international / isInternationalOrder
// dashboard, on top of the existing 17. "UNMAPPED" catches any shipment whose
// courier code doesn't match a known courier, so nothing silently disappears.
const INTL_EXTRA_COURIERS = ["DHL", "DHL_SINGAPORE", "JEEBLY"];
const INTL_COURIERS = COURIERS.concat(INTL_EXTRA_COURIERS).concat(["UNMAPPED"]);

const FR_TAGS = ["FR0", "FR1", "FR2", "BULK", "CL", "OTHERS"];
const MONITOR_STATUSES = ["Manifest", "Packing"];

// ─────────────────────────────────────────────────────────────────────────────
// ✅ RUN ONCE after deploying — creates sheet + pushes dummy data
// ─────────────────────────────────────────────────────────────────────────────
function setupAndSendDummy() {
  ensureHeaders(getSheet());

  writeSnapshot({
    type: "snapshot",
    timestamp: nowIST(),
    runId: "DEV-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    facilityCode: "NXS2",
    counts: makeDummyCounts()
  });

  writeMonitorSnapshot({
    type: "monitorSnapshot",
    timestamp: nowIST(),
    runId: "DEV-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    facilityCode: "NXS2",
    b2cCounts: makeDummyCounts(),
    b2bCounts: makeDummyCounts(),
    storePackingCounts: makeDummyCounts()
  });

  Logger.log("✅ Done! Snapshot sheet ready with dummy manifest + monitor data.");
}

// ✅ RUN ONCE (optional) — creates International sheet + dummy matrix/shipments
function setupAndSendDummyInternational() {
  const matrix = {};
  INTL_COURIERS.forEach(c => {
    matrix[c] = {};
    FR_TAGS.forEach(fr => {
      matrix[c][fr] = {
        Manifest: Math.random() < 0.7 ? 0 : Math.floor(Math.random() * 20),
        Packing: Math.random() < 0.7 ? 0 : Math.floor(Math.random() * 20)
      };
    });
  });

  const shipments = [];
  INTL_COURIERS.slice(0, 3).forEach(c => {
    FR_TAGS.slice(0, 2).forEach(fr => {
      MONITOR_STATUSES.forEach(st => {
        shipments.push({
          shipmentId: "DEV-" + Math.random().toString(36).slice(2, 10).toUpperCase(),
          courier: c,
          frTag: fr,
          status: st,
          type: st === "Manifest" ? (Math.random() < 0.5 ? "STC" : "STS") : ""
        });
      });
    });
  });

  writeInternationalSnapshot({
    type: "internationalSnapshot",
    timestamp: nowIST(),
    runId: "DEV-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    facilityCode: "NXS2",
    countsMatrix: matrix,
    shipments: shipments
  });

  Logger.log("✅ Done! International sheet ready with dummy matrix + shipment data.");
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — Dashboards read this
// ─────────────────────────────────────────────────────────────────────────────
function doGet(e) {
  try {
    const type = (e && e.parameter && e.parameter.type) || "";

    if (type === "international") return doGetInternational(e);
    if (type === "packingPrintList") return doGetPackingPrintList(e);

    const sheet = getSheet();
    if (sheet.getLastRow() < 2) return jsonResponse({ error: "no_data" });

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const values  = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];

    const result = {};
    headers.forEach((h, i) => { if (h !== "") result[h] = values[i]; });

    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

// NEW: serves the International sheet, optionally with the full shipment list
function doGetInternational(e) {
  const sheet = getInternationalSheet();
  if (sheet.getLastRow() < 2) return jsonResponse({ error: "no_data" });

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const values  = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];

  const result = {};
  headers.forEach((h, i) => { if (h !== "") result[h] = values[i]; });

  const includeShipments = e && e.parameter && e.parameter.includeShipments === "true";
  if (includeShipments) {
    result.shipments = readInternationalShipments();
  }

  return jsonResponse(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — Bookmarklets push here
// ─────────────────────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    if (payload.type === "snapshot") writeSnapshot(payload);
    if (payload.type === "monitorSnapshot") writeMonitorSnapshot(payload);
    if (payload.type === "combinedSnapshot") writeCombinedSnapshot(payload);
    if (payload.type === "internationalSnapshot") writeInternationalSnapshot(payload);
    if (payload.type === "packingPrintList") writePackingPrintList(payload);

    return jsonResponse({ status: "ok" });
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Write manifest-done snapshot (from filter API bookmarklet)
// ─────────────────────────────────────────────────────────────────────────────
function writeSnapshot(payload) {
  const sheet = getSheet();
  ensureHeaders(sheet);
  ensureRow2(sheet);

  // Update meta columns
  setCell(sheet, "timestamp", payload.timestamp || "");
  setCell(sheet, "runId", payload.runId || "");
  setCell(sheet, "facilityCode", payload.facilityCode || "");

  const counts = payload.counts || {};
  COURIERS.forEach(c => {
    setCell(sheet, "manifest_" + c, counts[c] !== undefined ? counts[c] : 0);
  });

  colorManifestCells(sheet, counts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Write B2C / B2B / Store Packing snapshot (from monitor bookmarklet)
// ─────────────────────────────────────────────────────────────────────────────
function writeMonitorSnapshot(payload) {
  const sheet = getSheet();
  ensureHeaders(sheet);
  ensureRow2(sheet);

  setCell(sheet, "monitorTimestamp", payload.timestamp || "");

  const b2c = payload.b2cCounts || {};
  const b2b = payload.b2bCounts || {};
  const sp  = payload.storePackingCounts || {};

  COURIERS.forEach(c => {
    setCell(sheet, "b2c_" + c, b2c[c] !== undefined ? b2c[c] : 0);
    setCell(sheet, "b2b_" + c, b2b[c] !== undefined ? b2b[c] : 0);
    setCell(sheet, "storePacking_" + c, sp[c] !== undefined ? sp[c] : 0);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Write manifest + B2C + B2B + Store Packing in a single live push
// ─────────────────────────────────────────────────────────────────────────────
function writeCombinedSnapshot(payload) {
  writeSnapshot({
    type: "snapshot",
    timestamp: payload.timestamp || nowIST(),
    runId: payload.runId || "",
    facilityCode: payload.facilityCode || "",
    counts: payload.counts || {}
  });

  writeMonitorSnapshot({
    type: "monitorSnapshot",
    timestamp: payload.monitorTimestamp || payload.timestamp || nowIST(),
    runId: payload.runId || "",
    facilityCode: payload.facilityCode || "",
    b2cCounts: payload.b2cCounts || {},
    b2bCounts: payload.b2bCounts || {},
    storePackingCounts: payload.storePackingCounts || {}
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Write international matrix (courier × FR_TAG × status) + shipment IDs
// payload.countsMatrix looks like: { [courier]: { [frTag]: { Manifest: n, Packing: n } } }
// payload.shipments looks like: [{ shipmentId, courier, frTag, status, type }]
// ─────────────────────────────────────────────────────────────────────────────
function writeInternationalSnapshot(payload) {
  const sheet = getInternationalSheet();
  ensureInternationalHeaders(sheet);
  ensureInternationalRow2(sheet);

  const shipments = payload.shipments || [];

  setCellIn(sheet, "timestamp", payload.timestamp || "");
  setCellIn(sheet, "runId", payload.runId || "");
  setCellIn(sheet, "facilityCode", payload.facilityCode || "");
  setCellIn(sheet, "shipmentCount", shipments.length);

  const matrix = payload.countsMatrix || {};
  INTL_COURIERS.forEach(c => {
    FR_TAGS.forEach(fr => {
      MONITOR_STATUSES.forEach(st => {
        const key = c + "_" + fr + "_" + st;
        const val = (matrix[c] && matrix[c][fr] && matrix[c][fr][st] !== undefined)
          ? matrix[c][fr][st]
          : 0;
        setCellIn(sheet, key, val);
      });
    });
  });

  writeInternationalShipments(shipments);
}

// Full shipment-level detail — sheet is cleared and rewritten every push
function writeInternationalShipments(shipments) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(INTL_SHIPMENTS_SHEET);
  if (!sheet) sheet = ss.insertSheet(INTL_SHIPMENTS_SHEET);

  sheet.clear();
  const headers = ["shipmentId", "courier", "frTag", "status", "type", "pushedAt"];
  sheet.appendRow(headers);
  sheet.getRange(1, 1, 1, headers.length)
       .setBackground("#000042").setFontColor("#ffffff")
       .setFontWeight("bold").setHorizontalAlignment("center");
  sheet.setFrozenRows(1);

  if (!shipments.length) return;

  const pushedAt = nowIST();
  const rows = shipments.map(s => [
    s.shipmentId || "",
    s.courier || "UNMAPPED",
    s.frTag || "",
    s.status || "",
    s.type || "",
    pushedAt
  ]);
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

function readInternationalShipments() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(INTL_SHIPMENTS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();

  return values.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: FR1 + FR2 Packing shipments → "PackingPrintList" sheet
// payload.rows looks like: [[shippingPackageId, shippingProviderCode, storeCode, binCode], ...]
// The sheet is cleared and rewritten on every push, so it always mirrors the latest run.
// ─────────────────────────────────────────────────────────────────────────────
function writePackingPrintList(payload) {
  const receivedAt = nowIST();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(PACKING_PRINT_SHEET) || ss.insertSheet(PACKING_PRINT_SHEET);

  const rows = (payload.rows || []).map(r => [
    r[0] === undefined || r[0] === null ? "" : String(r[0]),
    r[1] === undefined || r[1] === null ? "" : String(r[1]),
    r[2] === undefined || r[2] === null ? "" : String(r[2]),
    r[3] === undefined || r[3] === null ? "" : String(r[3])
  ]);

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    sheet.clear();
    sheet.getRange(1, 1, 1, PACKING_PRINT_HEADERS.length).setValues([PACKING_PRINT_HEADERS])
         .setBackground("#000042").setFontColor("#ffffff")
         .setFontWeight("bold").setHorizontalAlignment("center");
    sheet.setFrozenRows(1);
    for (let i = 1; i <= PACKING_PRINT_HEADERS.length; i++) sheet.setColumnWidth(i, 190);

    if (rows.length) {
      const needed = rows.length + 1;
      if (sheet.getMaxRows() < needed) {
        sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
      }
      const range = sheet.getRange(2, 1, rows.length, PACKING_PRINT_HEADERS.length);
      range.setNumberFormat("@");      // keep IDs / bin codes as text (no auto-conversion)
      range.setValues(rows);
    }

    PropertiesService.getScriptProperties().setProperty("PACKING_PRINT_LAST", JSON.stringify({
      runId: payload.runId || "",
      timestamp: receivedAt,
      rowCount: rows.length
    }));
  } finally {
    lock.releaseLock();
  }
}

function doGetPackingPrintList(e) {
  const raw = PropertiesService.getScriptProperties().getProperty("PACKING_PRINT_LAST");
  if (!raw) return jsonResponse({ error: "no_data" });
  const result = JSON.parse(raw);

  if (e && e.parameter && e.parameter.includeRows === "true") {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PACKING_PRINT_SHEET);
    result.rows = (sheet && sheet.getLastRow() > 1)
      ? sheet.getRange(2, 1, sheet.getLastRow() - 1, PACKING_PRINT_HEADERS.length).getValues()
      : [];
  }
  return jsonResponse(result);
}

// ✅ RUN ONCE (optional) — creates the PackingPrintList sheet with 3 dummy rows
function setupAndSendDummyPackingPrintList() {
  writePackingPrintList({
    type: "packingPrintList",
    timestamp: nowIST(),
    runId: "DEV-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    facilityCode: "NXS2",
    rows: [
      ["SNXS2270000070950415", "DOT", "LKST1826", "NDD1152"],
      ["SNXS2270000070716552", "GPSUPPLY", "", ""],
      ["SNXS2270000070951274", "BLUEDART", "LKST1001", "BLD0001"]
    ]
  });
  Logger.log("✅ Done! PackingPrintList sheet ready with dummy rows.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Header setup — builds column list once (domestic "Snapshot" sheet)
// timestamp | runId | facilityCode | monitorTimestamp |
// manifest_X17 | b2c_X17 | b2b_X17 | storePacking_X17
// ─────────────────────────────────────────────────────────────────────────────
function buildHeaders() {
  const headers = ["timestamp", "runId", "facilityCode", "monitorTimestamp"];
  FIELD_GROUPS.forEach(group => {
    COURIERS.forEach(c => headers.push(group + "_" + c));
  });
  return headers;
}

function ensureHeaders(sheet) {
  const headers = buildHeaders();
  const needsRepair = sheet.getLastRow() === 0 || !hasRequiredHeaders(sheet, headers);
  if (!needsRepair) return;

  sheet.clear();
  sheet.appendRow(headers);
  sheet.getRange(1, 1, 1, headers.length)
       .setBackground("#000042").setFontColor("#ffffff")
       .setFontWeight("bold").setHorizontalAlignment("center");
  sheet.setFrozenRows(1);
  for (let i = 1; i <= headers.length; i++) sheet.setColumnWidth(i, 130);
}

// NEW: header setup for the "International" sheet
// timestamp | runId | facilityCode | shipmentCount |
// <courier>_<frTag>_<status>  for every courier × FR_TAG × status combo
function buildInternationalHeaders() {
  const headers = ["timestamp", "runId", "facilityCode", "shipmentCount"];
  INTL_COURIERS.forEach(c => {
    FR_TAGS.forEach(fr => {
      MONITOR_STATUSES.forEach(st => headers.push(c + "_" + fr + "_" + st));
    });
  });
  return headers;
}

function ensureInternationalHeaders(sheet) {
  const headers = buildInternationalHeaders();
  const needsRepair = sheet.getLastRow() === 0 || !hasRequiredHeaders(sheet, headers);
  if (!needsRepair) return;

  sheet.clear();
  sheet.appendRow(headers);
  sheet.getRange(1, 1, 1, headers.length)
       .setBackground("#000042").setFontColor("#ffffff")
       .setFontWeight("bold").setHorizontalAlignment("center");
  sheet.setFrozenRows(1);
}

function ensureInternationalRow2(sheet) {
  if (sheet.getLastRow() < 2) {
    const headers = buildInternationalHeaders();
    sheet.appendRow(new Array(headers.length).fill(""));
  }
}

function getInternationalSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(INTERNATIONAL_SHEET) || ss.insertSheet(INTERNATIONAL_SHEET);
}

function hasRequiredHeaders(sheet, requiredHeaders) {
  if (sheet.getLastRow() === 0) return false;
  const currentHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return requiredHeaders.every(h => currentHeaders.indexOf(h) !== -1);
}

function ensureRow2(sheet) {
  if (sheet.getLastRow() < 2) {
    const headers = buildHeaders();
    sheet.appendRow(new Array(headers.length).fill(""));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Set a single cell in row 2 by header name (domestic "Snapshot" sheet)
// ─────────────────────────────────────────────────────────────────────────────
function setCell(sheet, headerName, value) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col = headers.indexOf(headerName) + 1;
  if (col === 0) return;
  sheet.getRange(2, col).setValue(value);
}

// Same helper, scoped separately so a rename of one sheet's headers can never
// collide with the other sheet's column lookup.
function setCellIn(sheet, headerName, value) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col = headers.indexOf(headerName) + 1;
  if (col === 0) return;
  sheet.getRange(2, col).setValue(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Color manifest cells based on value
// ─────────────────────────────────────────────────────────────────────────────
function colorManifestCells(sheet, counts) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  COURIERS.forEach(c => {
    const col = headers.indexOf("manifest_" + c) + 1;
    if (col === 0) return;
    const cell = sheet.getRange(2, col);
    const count = counts[c];
    if (count === undefined || count === -1) {
      cell.setBackground("#eeeeee").setFontColor("#9e9e9e");
    } else if (count === 0) {
      cell.setBackground("#e8f5e9").setFontColor("#2e7d32");
    } else {
      cell.setBackground("#fff3e0").setFontColor("#e65100");
    }
    cell.setFontWeight("bold");
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stale data clear — run on a 1-minute trigger
// ─────────────────────────────────────────────────────────────────────────────
function clearStaleSnapshot() {
  const sheet = getSheet();
  if (sheet.getLastRow() < 2) return;

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const tsCol = headers.indexOf("timestamp") + 1;
  if (tsCol === 0) return;

  const tsValue = sheet.getRange(2, tsCol).getValue();
  if (!tsValue) return;

  let pushedUTC;

  // If timestamp is already a Date object
  if (tsValue instanceof Date) {
    pushedUTC = tsValue;
  } else {
    // Parse string timestamp like "2026-06-20 19:36:06.725 IST"
    const clean = tsValue.toString().replace(" IST", "").trim();
    const isoString = clean.replace(" ", "T") + "+05:30";
    pushedUTC = new Date(isoString);
  }

  // Invalid timestamp check
  if (isNaN(pushedUTC.getTime())) {
    Logger.log("Failed to parse timestamp: " + tsValue);
    return;
  }

  const ageMinutes = (new Date() - pushedUTC) / 60000;
  Logger.log("Current row age: " + ageMinutes.toFixed(1) + " mins");

  // Clear row contents if older than 5 minutes
  if (ageMinutes > 5) {
    sheet.getRange(2, 1, 1, sheet.getLastColumn()).clearContent();
    Logger.log(
      "Stale data cleared. Row contents removed. Row was " +
      ageMinutes.toFixed(1) +
      " mins old."
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SNAPSHOT_SHEET) || ss.insertSheet(SNAPSHOT_SHEET);
}

function makeDummyCounts() {
  const counts = {};
  COURIERS.forEach(c => {
    counts[c] = Math.random() < 0.7 ? 0 : Math.floor(Math.random() * 100) + 1;
  });
  return counts;
}

function nowIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().replace("T", " ").replace("Z", "") + " IST";
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}