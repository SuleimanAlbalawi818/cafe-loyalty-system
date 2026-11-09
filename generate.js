const jwt = require('jsonwebtoken');
const credentials = require('./key.json'); 

// معرفات مشروعك
const issuerId = '3388000000023233741';
const classId = `${issuerId}.MandelRewards`;
const objectId = '${issuerId}.CAF-TEST-11'; // رقم بطاقة تجريبي

const claims = {
  iss: credentials.client_email,
  aud: 'google_pay',
  typ: 'savetowallet',
  iat: Math.floor(Date.now() / 1000),
  origins: [],
  payload: {
    loyaltyObjects: [{
      id: objectId,
      classId: classId,
      state: 'ACTIVE',
      accountId: 'CAF-TEST-01',
      accountName: 'تجربة ماندل',
      loyaltyPoints: {
        balance: { string: '5' },
        label: 'النقاط'
      }
    }]
  }
};

// تشفير البيانات وتوليد الرابط
const token = jwt.sign(claims, credentials.private_key, { algorithm: 'RS256' });
console.log('\n=== رابط بطاقتك جاهز! ===\n');
console.log(`https://pay.google.com/gp/v/save/${token}\n`);
console.log('===========================\nانسخ الرابط وافتحه في هاتفك الذكي');