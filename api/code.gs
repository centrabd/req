// =========================================================
// منظومة سنتر عبد الله المتكاملة - Google Apps Script v8.4.0
// 1. خادم إرسال رسائل الواتساب الجماعية (Bulk Sender API)
// 2. المزامنة التلقائية لأسماء العملاء مع نموذج التحصيل (Google Form)
// =========================================================

// ---------------------------------------------------------
// الإعدادات العامة والثوابت (Configuration)
// ---------------------------------------------------------
var WA_SHEET_NAME = "22";
var CUSTOMER_SHEET_NAME = "2026";
var CUSTOMER_COL_INDEX = 4;
var CUSTOMER_START_ROW = 2;
var INCOME_FORM_ID = "1JUxjXIc5jB7iEyi_HCpiWf6yNue3Z6yRjLW06mhjfGc";

var DATE_TRACK_SHEET = "5";
var DATE_CELL = "C1";
var TIMEZONE = "GMT+3";
var MAX_BATCH_LIMIT = 100;
var MIN_BATCH_LIMIT = 1;
var PROPS_KEY_LAST_RESET = "LAST_RESET_DATE";
var LOCK_TIMEOUT_MS = 10000;   // 🔧 FIX: قفل موحد

// مؤشرات أعمدة شيت 22 (0-based)
var COL = {
  DELAY_URL:          0,
  DELAY_STATUS:       1,
  DELAY_TIME:         2,
  SERIAL:             3,
  DELAY_NOTES:        4,
  COLLECTION_URL:     5,
  COLLECTION_STATUS:  6,
  COLLECTION_TIME:    7,
  COLLECTION_NOTES:   8
};

// =========================================================
// 1. مزامنة أسماء العملاء مع نموذج التحصيل
// =========================================================

function syncCustomersToIncomeForm() {
  var t0 = new Date();
  function log(msg) {
    Logger.log("[" + ((new Date() - t0) / 1000).toFixed(1) + "s] " + msg);
  }

  try {
    log("START syncCustomersToIncomeForm");

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(CUSTOMER_SHEET_NAME);

    if (!sheet) {
      log("❌ Sheet not found: " + CUSTOMER_SHEET_NAME);
      return;
    }

    // 🔧 FIX 1: حد أقصى لعدد الصفوف المقروءة (يمنع تعليق بسبب صفوف وهمية)
    var lastRow = sheet.getLastRow();
    var MAX_SCAN_ROWS = 5000;
    var scanEndRow = Math.min(lastRow, CUSTOMER_START_ROW + MAX_SCAN_ROWS - 1);
    log("lastRow=" + lastRow + ", scanEndRow=" + scanEndRow);

    if (lastRow < CUSTOMER_START_ROW) {
      log("No data rows.");
      return;
    }

    // 🔧 FIX 2: قراءة القيم فقط (بدون معادلات) لتسريع العملية
    var numRows = scanEndRow - CUSTOMER_START_ROW + 1;
    log("Reading " + numRows + " rows...");
    var rawData = sheet
      .getRange(CUSTOMER_START_ROW, CUSTOMER_COL_INDEX, numRows, 1)
      .getValues();
    log("Read done: " + rawData.length);

    // 🔧 FIX 3: استخدام for عادية + Set لتجميع الأسماء
    var customerSet = {};
    for (var i = 0; i < rawData.length; i++) {
      var name = String(rawData[i][0] || "").trim();
      if (name !== "" &&
          name.indexOf("الاســـــم") === -1 &&
          name.indexOf("حساب المحل") === -1) {
        customerSet[name] = true;
      }
    }

    var customerList = Object.keys(customerSet);
    log("Unique customers: " + customerList.length);

    if (customerList.length === 0) {
      log("❌ Empty customer list.");
      return;
    }

    // 🔧 FIX 4: ترتيب عربي
    customerList.sort(function(a, b) { return a.localeCompare(b, 'ar'); });
    log("Sort done.");

    // 🔧 FIX 5: فتح النموذج وتحديث القائمة
    log("Opening form...");
    var form = FormApp.openById(INCOME_FORM_ID);
    log("Form opened: " + form.getTitle());

    var items = form.getItems();
    log("Items: " + items.length);

    var nameQuestion = null;
    for (var j = 0; j < items.length; j++) {
      var title = items[j].getTitle().trim();
      if (title === "الأسم" || title === "الاسم") {
        if (items[j].getType() === FormApp.ItemType.LIST) {
          nameQuestion = items[j].asListItem();
          log("Found list item at " + j);
          break;
        }
      }
    }

    if (!nameQuestion) {
      log("❌ No matching list item found.");
      return;
    }

    log("Calling setChoiceValues (" + customerList.length + " items)...");
    nameQuestion.setChoiceValues(customerList);
    log("✅ DONE - synced " + customerList.length + " customers.");

  } catch (error) {
    log("💥 ERROR: " + error.toString());
  }
}

// =========================================================
// 2. موجه طلبات GET
// =========================================================
function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : "fetch";
    if (action === "fetch") return handleFetch(e);
    if (action === "count") return handleCount(e);
    if (action === "ping")  return jsonResponse({ success: true, message: "pong" });
    if (action === "reset") return handleReset(e);
    if (action === "sync_form") {
      syncCustomersToIncomeForm();
      return jsonResponse({ success: true, message: "Income form synced successfully" });
    }
    return jsonResponse({ success: false, error: "Unknown action: " + action });
  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}

// =========================================================
// 3. جلب دفعة الرسائل (handleFetch)
// =========================================================
function handleFetch(e) {
  var msgType = (e && e.parameter && e.parameter.type) ? e.parameter.type : "delay";
  if (msgType !== "delay" && msgType !== "collection") {
    return jsonResponse({ success: false, error: "Invalid type: " + msgType });
  }

  var limit = 5;
  if (e && e.parameter && e.parameter.limit) {
    var parsed = parseInt(e.parameter.limit, 10);
    if (!isNaN(parsed) && parsed >= MIN_BATCH_LIMIT && parsed <= MAX_BATCH_LIMIT) {
      limit = parsed;
    }
  }

  var sinceRow = 0;
  if (e && e.parameter && e.parameter.since_row) {
    var sr = parseInt(e.parameter.since_row, 10);
    if (!isNaN(sr) && sr > 0) sinceRow = sr;
  }

  var excludeStr = (e && e.parameter && e.parameter.exclude) ? e.parameter.exclude : "";
  var excludeSet = {};
  if (excludeStr) {
    excludeStr.split(",").forEach(function(x) {
      var n = parseInt(x.trim(), 10);
      if (!isNaN(n) && n > 0) excludeSet[n] = true;
    });
  }

  var sheet = getWASheet();
  var data = sheet.getDataRange().getValues();
  var tasks = [];
  var totalPending = 0;
  var lastMatchedRow = 0;
  var hasMore = false;

  var urlCol = (msgType === "delay") ? COL.DELAY_URL : COL.COLLECTION_URL;
  var statusCol = (msgType === "delay") ? COL.DELAY_STATUS : COL.COLLECTION_STATUS;

  // 🔧 FIX: totalPending موحّد مع handleCount (مش شامل "فشل")
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var url = row[urlCol] ? row[urlCol].toString().trim() : "";
    var status = row[statusCol] ? row[statusCol].toString().trim() : "";
    if (url && !isAlreadySent(status) && !isFailedStatus(status)) totalPending++;
  }

  for (var j = 1; j < data.length; j++) {
    var rowNum = j + 1;
    if (sinceRow > 0 && rowNum <= sinceRow) continue;
    if (excludeSet[rowNum]) continue;

    var rowR = data[j];
    var urlR = rowR[urlCol] ? rowR[urlCol].toString().trim() : "";
    var statusR = rowR[statusCol] ? rowR[statusCol].toString().trim() : "";

    // 🔧 FIX: نستبعد الفاشلين من الـ fetch العادي (عشان مايتعاد إرسالهم تلقائيًا)
    if (urlR && !isAlreadySent(statusR) && !isFailedStatus(statusR)) {
      if (tasks.length < limit) {
        tasks.push({
          row_id: rowNum,
          serial: rowR[COL.SERIAL] ? rowR[COL.SERIAL].toString().trim() : String(rowNum),
          url: urlR,
          type: msgType,
          current_status: statusR
        });
        lastMatchedRow = rowNum;
      } else {
        hasMore = true;
        break;
      }
    }
  }

  return jsonResponse({
    success: true,
    batch: tasks,
    count: tasks.length,
    type: msgType,
    limit: limit,
    excluded_count: Object.keys(excludeSet).length,
    since_row: sinceRow,
    total_pending: totalPending,
    has_more: hasMore,
    next_suggested: lastMatchedRow
  });
}

// =========================================================
// 4. إحصائيات الرسائل (handleCount)
// =========================================================
function handleCount(e) {
  var msgType = (e && e.parameter && e.parameter.type) ? e.parameter.type : "delay";
  if (msgType !== "delay" && msgType !== "collection") {
    return jsonResponse({ success: false, error: "Invalid type" });
  }

  var urlCol = (msgType === "delay") ? COL.DELAY_URL : COL.COLLECTION_URL;
  var statusCol = (msgType === "delay") ? COL.DELAY_STATUS : COL.COLLECTION_STATUS;

  var sheet = getWASheet();
  var data = sheet.getDataRange().getValues();
  var pending = 0, sent = 0, failed = 0, empty = 0;

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var url = row[urlCol] ? row[urlCol].toString().trim() : "";
    var status = row[statusCol] ? row[statusCol].toString().trim() : "";
    if (!url) { empty++; continue; }
    if (isAlreadySent(status)) sent++;
    // 🔧 FIX: اكتشاف "فشل" بالعربي والإنجليزي
    else if (isFailedStatus(status)) failed++;
    else pending++;
  }

  return jsonResponse({
    success: true,
    type: msgType,
    pending: pending,
    sent: sent,
    failed: failed,
    empty: empty
  });
}

// =========================================================
// 5. استقبال تحديث الحالة من أداة الإرسال (doPost)
// =========================================================
function doPost(e) {
  // 🔧 FIX: قفل لمنع تعارض الكتابة المتزامنة
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    locked = lock.tryLock(LOCK_TIMEOUT_MS);
    if (!locked) {
      return jsonResponse({ success: false, error: "Server busy, retry later" });
    }

    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ success: false, error: "No data received" });
    }
    var param;
    try { param = JSON.parse(e.postData.contents); }
    catch (pe) { return jsonResponse({ success: false, error: "Invalid JSON: " + pe }); }

    var rowId = parseInt(param.row_id, 10);
    var msgType = param.type;
    var status = (param.status || "").toString().trim();
    var notes = (param.notes || "").toString().trim();
    var timestamp = param.timestamp || Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm:ss");

    if (!rowId || rowId < 2) return jsonResponse({ success: false, error: "Invalid row_id" });
    if (msgType !== "delay" && msgType !== "collection") return jsonResponse({ success: false, error: "Invalid type" });
    if (status === "") return jsonResponse({ success: false, error: "Empty status" });

    var sheet = getWASheet();

    // 🔧 FIX: تحقق من نطاق الصف قبل الكتابة (يمنع توسّع الشيت بصفوف فاضية)
    var lastRow = sheet.getLastRow();
    if (rowId > lastRow) {
      return jsonResponse({
        success: false,
        error: "Row out of range: " + rowId + " > last " + lastRow
      });
    }

    var statusCol1 = (msgType === "delay") ? (COL.DELAY_STATUS + 1) : (COL.COLLECTION_STATUS + 1);
    var timeCol1 = (msgType === "delay") ? (COL.DELAY_TIME + 1) : (COL.COLLECTION_TIME + 1);
    var notesCol1 = (msgType === "delay") ? (COL.DELAY_NOTES + 1) : (COL.COLLECTION_NOTES + 1);

    // 🔧 FIX: كتابة الـ 3 خلايا في عملية واحدة (أسرع + متسق)
    var existing = sheet.getRange(rowId, statusCol1).getValue().toString().trim();
    var newIsSent = isAlreadySent(status);
    var oldIsSent = isAlreadySent(existing);

    if (oldIsSent && !newIsSent) {
      return jsonResponse({
        success: true,
        row_id: rowId,
        skipped: true,
        reason: "Row already Sent; not downgrading",
        existing_status: existing
      });
    }

    // كتابة الحالة والتوقيت
    sheet.getRange(rowId, statusCol1).setValue(status);
    sheet.getRange(rowId, timeCol1).setValue(timestamp);

    // 🔧 FIX: نكتب الملاحظات فقط لو جديدة، ونحتفظ بالقيمة القديمة لو فاضية
    if (notes) {
      sheet.getRange(rowId, notesCol1).setValue(notes);
    } else if (isFailedStatus(status)) {
      // لو الحالة فشل ومفيش notes، سجّل سبب الفشل نفسه
      sheet.getRange(rowId, notesCol1).setValue(status);
    }

    return jsonResponse({
      success: true,
      row_id: rowId,
      type: msgType,
      status: status,
      timestamp: timestamp,
      notes: notes
    });
  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  } finally {
    // 🔧 FIX: تحرير القفل دايمًا حتى لو حصل خطأ
    if (locked) lock.releaseLock();
  }
}

// =========================================================
// 6. إدارة التصفير اليومي
// =========================================================
function resetDailyStatus() {
  // 🔧 FIX: قفل لمنع التصفير أثناء الإرسال
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    locked = lock.tryLock(LOCK_TIMEOUT_MS);
    if (!locked) return { success: false, error: "Server busy, retry later" };

    var sheet = getWASheet();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, cleared_rows: 0 };

    var numRows = lastRow - 1;

    // Delay: B(2), C(3)
    sheet.getRange(2, COL.DELAY_STATUS + 1, numRows, 2).clearContent();
    // Collection: G(7), H(8)
    sheet.getRange(2, COL.COLLECTION_STATUS + 1, numRows, 2).clearContent();

    var todayStr = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd");
    PropertiesService.getScriptProperties().setProperty(PROPS_KEY_LAST_RESET, todayStr);
    Logger.log("Reset done at " + todayStr + " for " + numRows + " rows.");
    return { success: true, cleared_rows: numRows, reset_date: todayStr };
  } finally {
    if (locked) lock.releaseLock();
  }
}

function handleReset(e) {
  return jsonResponse(resetDailyStatus());
}

function checkAndResetOnDateChange() {
  var todayStr = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd");
  var lastReset = PropertiesService.getScriptProperties().getProperty(PROPS_KEY_LAST_RESET);

  // 🔧 FIX: تجاهل التشغيل الأول لو LAST_RESET فاضي (يمنع مسح بيانات موجودة)
  if (!lastReset) {
    Logger.log("First run detected. Setting LAST_RESET=" + todayStr + " without clearing.");
    PropertiesService.getScriptProperties().setProperty(PROPS_KEY_LAST_RESET, todayStr);
    return;
  }

  if (lastReset !== todayStr) {
    Logger.log("New day detected (" + todayStr + "). Auto-resetting...");
    resetDailyStatus();
  }
}

function updateHourlyTimestamp() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(DATE_TRACK_SHEET);
  if (!sheet) return;
  sheet.getRange(DATE_CELL).setValue(
    Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm:ss")
  );
  checkAndResetOnDateChange();
}

// =========================================================
// 7. الدوال المساعدة وقائمة الواجهة
// =========================================================
function getWASheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(WA_SHEET_NAME);
  if (!sheet) throw new Error("Sheet '" + WA_SHEET_NAME + "' not found");
  return sheet;
}

function isAlreadySent(statusText) {
  if (!statusText) return false;
  var s = statusText.toString().trim();
  if (s === "") return false;
  if (s.indexOf("تم الإرسال") === 0) return true;
  var lower = s.toLowerCase();
  if (lower.indexOf("sent") === 0) return true;
  return false;
}

// 🔧 FIX: دالة موحدة لاكتشاف الفشل (عربي + إنجليزي)
function isFailedStatus(statusText) {
  if (!statusText) return false;
  var s = statusText.toString().trim();
  if (s === "") return false;
  var lower = s.toLowerCase();
  // إنجليزي: "failed", "failed: ...", "error"
  if (lower.indexOf("failed") === 0) return true;
  if (lower.indexOf("error") === 0) return true;
  // عربي: "فشل", "فشل الإرسال", "خطأ"
  if (s.indexOf("فشل") === 0) return true;
  if (s.indexOf("خطأ") === 0) return true;
  return false;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * شريط التحكم الموحد داخل شيت الإكسيل
 */
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu("⚙️ سنتر عبد الله")
    .addItem("🔄 تحديث أسماء نموذج التحصيل (Google Form)", "syncCustomersToIncomeForm")
    .addSeparator()
    .addItem("🔄 تصفير حالات إرسال الواتساب يدويًا", "resetDailyStatus")
    .addItem("⏱️ فحص اليوم الجديد وتحديث الوقت", "updateHourlyTimestamp")
    .addSeparator()
    .addItem("🔍 تشخيص سريع", "diagnoseServer")
    .addToUi();
}

// 🔧 FIX: دالة تشخيص لمساعدتك في تتبع المشاكل
function diagnoseServer() {
  var lines = [];
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    lines.push("Spreadsheet: " + ss.getName());

    var wa = ss.getSheetByName(WA_SHEET_NAME);
    lines.push("WA Sheet '" + WA_SHEET_NAME + "': " + (wa ? "OK, rows=" + wa.getLastRow() : "MISSING"));

    var cust = ss.getSheetByName(CUSTOMER_SHEET_NAME);
    lines.push("Customer Sheet '" + CUSTOMER_SHEET_NAME + "': " + (cust ? "OK, rows=" + cust.getLastRow() : "MISSING"));

    var dateS = ss.getSheetByName(DATE_TRACK_SHEET);
    lines.push("Date Sheet '" + DATE_TRACK_SHEET + "': " + (dateS ? "OK" : "MISSING"));

    var lastReset = PropertiesService.getScriptProperties().getProperty(PROPS_KEY_LAST_RESET);
    lines.push("LAST_RESET_DATE: " + (lastReset || "(not set)"));

    if (wa) {
      var delayStats = countForType("delay");
      var collStats = countForType("collection");
      lines.push("Delay -> pending=" + delayStats.pending + ", sent=" + delayStats.sent +
                 ", failed=" + delayStats.failed + ", empty=" + delayStats.empty);
      lines.push("Collection -> pending=" + collStats.pending + ", sent=" + collStats.sent +
                 ", failed=" + collStats.failed + ", empty=" + collStats.empty);
    }

    var report = lines.join("\n");
    Logger.log(report);
    try {
      SpreadsheetApp.getUi().alert("تشخيص السيرفر", report, SpreadsheetApp.getUi().ButtonSet.OK);
    } catch (e) {
      // لو مش شغال من قائمة، بس سجّل
    }
  } catch (err) {
    Logger.log("Diagnose error: " + err);
  }
}

// 🔧 FIX: دالة مساعدة للعد حسب النوع (تستخدمها diagnoseServer)
function countForType(msgType) {
  var urlCol = (msgType === "delay") ? COL.DELAY_URL : COL.COLLECTION_URL;
  var statusCol = (msgType === "delay") ? COL.DELAY_STATUS : COL.COLLECTION_STATUS;
  var sheet = getWASheet();
  var data = sheet.getDataRange().getValues();
  var pending = 0, sent = 0, failed = 0, empty = 0;
  for (var i = 1; i < data.length; i++) {
    var url = data[i][urlCol] ? data[i][urlCol].toString().trim() : "";
    var status = data[i][statusCol] ? data[i][statusCol].toString().trim() : "";
    if (!url) { empty++; continue; }
    if (isAlreadySent(status)) sent++;
    else if (isFailedStatus(status)) failed++;
    else pending++;
  }
  return { pending: pending, sent: sent, failed: failed, empty: empty };
}
