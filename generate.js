const jwt = require('jsonwebtoken');
const { GoogleAuth } = require('google-auth-library');
const credentials = require('./key.json');

const issuerId = '3388000000023233741';
const classId = `${issuerId}.MandelRewards`;
const randomNum = Math.floor(1000 + Math.random() * 9000);
const objectId = `${issuerId}.CAF-TEST-${randomNum}`;

const auth = new GoogleAuth({
  keyFile: './key.json',
  scopes: ['https://www.googleapis.com/auth/wallet_object.issuer']
});

async function createPass() {
  try {
    const client = await auth.getClient();
    const classUrl = `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass/${classId}`;

    // 1. تحويل القالب من مسودة (draft) إلى مفعل (UNDER_REVIEW)
    console.log('⏳ جاري تفعيل القالب في سيرفر جوجل...');
    const patchRes = await client.request({
      url: classUrl,
      method: 'PATCH',
      data: {
        reviewStatus: 'UNDER_REVIEW'
      }
    });
    console.log('✅ تم تفعيل القالب! الحالة الجديدة:', patchRes.data.reviewStatus);

    // 2. إنشاء بطاقة الزبون مباشرة في سيرفر جوجل
    const objectPayload = {
      id: objectId,
      classId: classId,
      state: 'ACTIVE',
      accountId: `MND-${randomNum}`,
      accountName: 'سليمان البلوي',
      loyaltyPoints: {
        balance: { int: 5 },
        label: 'النقاط'
      },
      barcode: {
        type: 'QR_CODE',
        value: `MND-${randomNum}`
      }
    };

    const objectUrl = `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject`;
    await client.request({
      url: objectUrl,
      method: 'POST',
      data: objectPayload
    });
    console.log('✅ تم تسجيل بطاقة الزبون في سيرفر جوجل بنجاح!');

    // 3. توليد رابط الحفظ النهائي
    const claims = {
      iss: credentials.client_email,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(Date.now() / 1000),
      origins: [],
      payload: {
        loyaltyObjects: [{ id: objectId }]
      }
    };

    const token = jwt.sign(claims, credentials.private_key, { algorithm: 'RS256' });
    console.log('\n=== رابط بطاقتك المضمون جاهز! ===\n');
    console.log(`https://pay.google.com/gp/v/save/${token}\n`);

  } catch (err) {
    console.error('\n❌ تفاصيل الخطأ:');
    console.error(err.response ? JSON.stringify(err.response.data, null, 2) : err.message);
  }
}

createPass();