# req


# 🧪 نموذج اختبار Google Sheets Integration

نموذج عملي لربط واجهة ويب بـ Google Sheets عبر Google Apps Script.

## 📋 وصف المشروع

هذا المشروع يتكون من صفحتين:

### 1. صفحة التسجيل (`index.html`)
- نموذج بسيط لجمع البيانات (الاسم، رقم الهاتف، الموقع الجغرافي)
- يستخدم Geolocation API لجلب الإحداثيات
- يرسل البيانات مباشرة إلى Google Sheets

### 2. لوحة تحكم الأدمن (`admin.html`)
- عرض جميع الطلبات المسجلة
- تغيير حالة كل طلب (جديد / قيد المراجعة / مقبول / مرفوض)
- حماية بكلمة مرور بسيطة

## 🛠️ التقنيات المستخدمة

- **Frontend:** HTML5, CSS3, JavaScript (Vanilla)
- **Backend:** Google Apps Script
- **Database:** Google Sheets
- **Hosting:** GitHub Pages

## 🚀 كيفية التشغيل

1. افتح رابط الموقع: `https://your-username.github.io/req/`
2. املأ النموذج واضغط "إرسال"
3. افتح لوحة الأدمن: `https://your-username.github.io/req/admin.html`
4. كلمة المرور: `admin123`

## 📊 هيكل قاعدة البيانات (Google Sheets)

| Timestamp | UUID | Name | Phone | Latitude | Longitude | Accuracy | Status |

## 🔐 الأمان

- كلمة مرور الأدمن: `admin123` (للعرض التوضيحي فقط)
- مفتاح API: `MySecretAdminKey123` (في Google Apps Script)

## 📝 ملاحظات

- هذا نموذج تعليمي (Proof of Concept)
- لا يستخدم في إنتاج حقيقي بدون تحسينات أمنية إضافية
- Google Sheets له قيود على عدد الطلبات اليومية (حوالي 20,000 طلب)

## 👨‍💻 المطور

تم التطوير كجزء من اختبار قدرات Google Sheets كقاعدة بيانات.
