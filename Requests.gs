const SHEET_ID = '12skw7AJDI40UNFziv0RGrsH4HLajbKfl4CTMkh4YFuc';
const SHEET_NAME = 'Requests';
const ADMIN_KEY = 'MySecretAdminKey123';

// ==========================================
// الأعمدة المطلوبة في الجدول
// ==========================================
const REQUIRED_COLUMNS = [
  'Timestamp',
  'UUID', 
  'Name',
  'Phone',
  'Latitude',
  'Longitude',
  'Accuracy',
  'Status'
];

// ==========================================
// دالة مساعدة: فحص وإصلاح هيكل الجدول
// ==========================================
function ensureSheetStructure(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const missingColumns = [];
  
  // فحص كل عمود مطلوب
  REQUIRED_COLUMNS.forEach(col => {
    const found = headers.some(h => h.toString().trim().toLowerCase() === col.toLowerCase());
    if (!found) {
      missingColumns.push(col);
    }
  });
  
  // إذا كانت هناك أعمدة مفقودة، أضفها
  if (missingColumns.length > 0) {
    const lastCol = sheet.getLastColumn();
    missingColumns.forEach((col, index) => {
      sheet.getRange(1, lastCol + index + 1).setValue(col);
    });
    
    // إعادة تنسيق الصف الأول (Bold + Background)
    const newRange = sheet.getRange(1, lastCol + 1, 1, missingColumns.length);
    newRange.setFontWeight('bold');
    newRange.setBackground('#4a86e8');
    newRange.setFontColor('#ffffff');
  }
  
  return missingColumns;
}

// ==========================================
// دالة مساعدة: الحصول على فهرس العمود (مع تجاهل حالة الأحرف)
// ==========================================
function getColumnIndex(headers, columnName) {
  const index = headers.findIndex(h => 
    h.toString().trim().toLowerCase() === columnName.toLowerCase()
  );
  return index;
}

// ==========================================
// 1. قراءة البيانات (للواجهة الإدارية)
// ==========================================
function doGet(e) {
  if (e.parameter.key !== ADMIN_KEY) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'غير مصرح' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAME);
    
    if (!sheet) {
      throw new Error(`ورقة العمل "${SHEET_NAME}" غير موجودة`);
    }
    
    // فحص وإصلاح الهيكل قبل القراءة
    ensureSheetStructure(sheet);
    
    const data = sheet.getDataRange().getValues();
    
    if (data.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({ status: 'success', data: [] }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    const headers = data[0];
    const rows = data.slice(1);
    
    const result = rows.map(row => {
      let obj = {};
      headers.forEach((header, index) => {
        const headerName = header.toString().trim();
        if (headerName === '') return; // تخطي الأعمدة الفارغة
        
        if (headerName.toLowerCase() === 'timestamp' && row[index] instanceof Date) {
          obj[headerName] = row[index].toISOString();
        } else {
          obj[headerName] = row[index];
        }
      });
      return obj;
    });

    return ContentService.createTextOutput(JSON.stringify({ status: 'success', data: result }))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ 
      status: 'error', 
      message: error.toString() 
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ==========================================
// 2. كتابة أو تحديث البيانات
// ==========================================
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);

  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAME);
    
    if (!sheet) {
      throw new Error(`ورقة العمل "${SHEET_NAME}" غير موجودة`);
    }

    // فحص وإصلاح الهيكل قبل الكتابة
    const addedColumns = ensureSheetStructure(sheet);
    
    // إعادة قراءة الهيدرز بعد الإصلاح (إذا تم إضافة أعمدة جديدة)
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    // السيناريو أ: تحديث حالة طلب موجود (من لوحة الأدمن)
    if (data.action === 'update_status') {
      const uuidIndex = getColumnIndex(headers, 'UUID');
      const statusIndex = getColumnIndex(headers, 'Status');
      
      if (uuidIndex === -1) {
        throw new Error('عمود UUID غير موجود حتى بعد الإصلاح');
      }
      if (statusIndex === -1) {
        throw new Error('عمود Status غير موجود حتى بعد الإصلاح');
      }

      const values = sheet.getDataRange().getValues();
      
      // البحث عن الصف المطابق للـ UUID
      for (let i = 1; i < values.length; i++) {
        if (values[i][uuidIndex].toString() === data.uuid) {
          // تحديث عمود الحالة
          sheet.getRange(i + 1, statusIndex + 1).setValue(data.newStatus);
          
          return ContentService.createTextOutput(JSON.stringify({ 
            status: 'success', 
            message: 'تم تحديث الحالة بنجاح' 
          })).setMimeType(ContentService.MimeType.JSON);
        }
      }
      throw new Error('لم يتم العثور على الطلب بمعرف: ' + data.uuid);
    } 
    
    // السيناريو ب: إضافة طلب جديد (من نموذج التسجيل)
    else {
      const timestamp = new Date();
      const uuid = Utilities.getUuid();
      
      // إنشاء صف بيانات بحجم الأعمدة الموجودة
      const rowData = new Array(headers.length).fill('');
      
      // ملء البيانات في الأعمدة المناسبة
      const setData = (colName, value) => {
        const idx = getColumnIndex(headers, colName);
        if (idx !== -1) rowData[idx] = value;
      };
      
      setData('Timestamp', timestamp);
      setData('UUID', uuid);
      setData('Name', data.name || 'غير محدد');
      setData('Phone', data.phone || 'غير محدد');
      setData('Latitude', data.latitude || '');
      setData('Longitude', data.longitude || '');
      setData('Accuracy', data.accuracy || '');
      setData('Status', 'جديد');
      
      sheet.appendRow(rowData);
      
      return ContentService.createTextOutput(JSON.stringify({ 
        status: 'success', 
        message: 'تم الحفظ بنجاح',
        uuid: uuid,
        addedColumns: addedColumns.length > 0 ? addedColumns : null
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ 
      status: 'error', 
      message: error.toString() 
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
