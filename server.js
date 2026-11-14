const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { GoogleAuth } = require('google-auth-library');
const admin = require('firebase-admin');

const credentials = process.env.GOOGLE_CREDENTIALS 
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS) 
    : require('./key.json');

// تهيئة Firebase Admin SDK للتحكم الآمن بقاعدة البيانات من الخادم
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(credentials),
        projectId: credentials.project_id || 'cafe-system-24331'
    });
}
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

const issuerId = '3388000000023233741';
const JWT_SECRET = process.env.JWT_SECRET || credentials.private_key_id || 'shabten_super_secret_key_2026';
const SUPER_ADMIN_PIN = process.env.SUPER_ADMIN_PIN || '2026';

const auth = new GoogleAuth({
    credentials: credentials,
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer']
});

// 0. مسار النبض (Keep-Alive Ping) لمنع سيرفر Render المجاني من النوم
app.get('/ping', (req, res) => {
    res.status(200).json({ status: 'awake', timestamp: Date.now() });
});

// حماية ضد تخمين الرموز السرية (Rate Limiting)
const loginAttempts = new Map();
function checkRateLimit(ip) {
    const now = Date.now();
    const record = loginAttempts.get(ip) || { count: 0, resetAt: now + 5 * 60 * 1000 };
    if (now > record.resetAt) {
        record.count = 0;
        record.resetAt = now + 5 * 60 * 1000;
    }
    record.count += 1;
    loginAttempts.set(ip, record);
    return record.count <= 15;
}

// مسار التحقق الآمن من الرموز السرية في السيرفر وإصدار Session Token
app.post('/api/auth/login', async (req, res) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
        return res.status(429).json({ success: false, message: '⛔ محاولات كثيرة خاطئة! يرجى الانتظار 5 دقائق.' });
    }

    const { cafeId, role, pin } = req.body;
    if (!role || !pin) {
        return res.status(400).json({ success: false, message: 'البيانات ناقصة' });
    }

    try {
        if (role === 'super_admin') {
            if (String(pin).trim() !== String(SUPER_ADMIN_PIN).trim()) {
                return res.status(401).json({ success: false, message: '❌ الرمز السري للإدارة غير صحيح!' });
            }
            const token = jwt.sign({ role: 'super_admin' }, JWT_SECRET, { expiresIn: '24h' });
            return res.status(200).json({ success: true, role: 'super_admin', token });
        }

        const cleanCafeId = (cafeId || 'mandel').toLowerCase().trim();
        const cafeSnap = await db.collection('cafes').doc(cleanCafeId).get();

        if (!cafeSnap.exists) {
            return res.status(404).json({ success: false, message: '❌ المتجر غير موجود!' });
        }

        const cafeData = cafeSnap.data();
        if (cafeData.isActive === false) {
            return res.status(403).json({ success: false, message: '⛔ اشتراك هذا المتجر متوقف مؤقتاً!' });
        }

        const cashierPin = String(cafeData.cashierPin || '1111').trim();
        const managerPin = String(cafeData.managerPin || '9999').trim();
        const enteredPin = String(pin).trim();

        if (role === 'manager') {
            if (enteredPin !== managerPin) {
                return res.status(401).json({ success: false, message: '❌ الرمز السري لمدير المحل غير صحيح!' });
            }
        } else if (role === 'cashier') {
            if (enteredPin !== cashierPin && enteredPin !== managerPin) {
                return res.status(401).json({ success: false, message: '❌ الرمز السري للكاشير غير صحيح!' });
            }
        } else {
            return res.status(400).json({ success: false, message: 'نوع صلاحية غير صالح' });
        }

        const token = jwt.sign({ role, cafeId: cleanCafeId }, JWT_SECRET, { expiresIn: '16h' });
        return res.status(200).json({
            success: true,
            role,
            cafeId: cleanCafeId,
            token
        });
    } catch (error) {
        console.error('Auth Error:', error.message);
        return res.status(500).json({ success: false, message: 'حدث خطأ في الخادم أثناء التحقق' });
    }
});

function verifyStaffToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'غير مصرح! يرجى تسجيل الدخول مجدداً.' });
    }
    const token = authHeader.split(' ')[1];
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'انتهت جلسة الدخول، يرجى تسجيل الدخول مجدداً.' });
    }
}

// مسار المعاملات الذرية للنقاط والمكافآت (Server-Side Atomic Points)
const recentTxLocks = new Map();

app.post('/api/points-transaction', verifyStaffToken, async (req, res) => {
    const { customerId, actionType, amount, rewardTitle } = req.body;
    const { cafeId, role } = req.user;

    if (!customerId || !actionType || !amount || Number(amount) <= 0) {
        return res.status(400).json({ success: false, message: 'بيانات العملية غير مكتملة أو غير صحيحة' });
    }

    const lockKey = `${cafeId}_${customerId}_${actionType}_${amount}`;
    const lastTime = recentTxLocks.get(lockKey) || 0;
    if (Date.now() - lastTime < 3000) {
        return res.status(429).json({ success: false, message: '⏳ تم تنفيذ هذه العملية للتو! يرجى الانتظار لحظة لمنع التكرار.' });
    }
    recentTxLocks.set(lockKey, Date.now());

    const ptsAmount = parseInt(amount, 10);
    const custRef = db.collection('customers').doc(String(customerId).trim().toUpperCase());
    const cafeRef = db.collection('cafes').doc(cafeId);

    try {
        const result = await db.runTransaction(async (transaction) => {
            const [custDoc, cafeDoc] = await Promise.all([
                transaction.get(custRef),
                transaction.get(cafeRef)
            ]);

            if (!cafeDoc.exists || cafeDoc.data().isActive === false) {
                throw new Error('STORE_SUSPENDED');
            }
            if (!custDoc.exists) {
                throw new Error('CUSTOMER_NOT_FOUND');
            }

            const custData = custDoc.data();
            if ((custData.cafeId || 'mandel').toLowerCase() !== cafeId.toLowerCase()) {
                throw new Error('WRONG_STORE');
            }

            const currentPoints = Number(custData.points) || 0;
            let newBalance = currentPoints;
            let pointsChangeLabel = '';

            if (actionType === 'add') {
                newBalance = currentPoints + ptsAmount;
                pointsChangeLabel = `+${ptsAmount}`;
            } else if (actionType === 'deduct') {
                if (currentPoints < ptsAmount) throw new Error('INSUFFICIENT_POINTS');
                newBalance = currentPoints - ptsAmount;
                pointsChangeLabel = `-${ptsAmount}`;
            } else if (actionType === 'redeem') {
                if (currentPoints < ptsAmount) throw new Error('INSUFFICIENT_POINTS');
                newBalance = currentPoints - ptsAmount;
                pointsChangeLabel = `-${ptsAmount} (${rewardTitle || 'مكافأة'})`;
            } else {
                throw new Error('INVALID_ACTION');
            }

            transaction.update(custRef, { points: newBalance });

            const logRef = db.collection('logs').doc();
            transaction.set(logRef, {
                cafeId: cafeId,
                customerId: String(customerId).trim().toUpperCase(),
                customerName: custData.name || 'عميل مميز',
                actionType: actionType,
                pointsChange: pointsChangeLabel,
                newBalance: newBalance,
                performedBy: role === 'manager' ? '👑 مدير المحل' : '👨‍💼 موظف الكاشير',
                timestamp: Date.now()
            });

            return { newBalance, customerName: custData.name };
        });

        syncGoogleWalletBalance(customerId, result.newBalance).catch(() => {});

        return res.status(200).json({
            success: true,
            newBalance: result.newBalance,
            message: 'تمت العملية بنجاح!'
        });

    } catch (err) {
        recentTxLocks.delete(lockKey);
        if (err.message === 'INSUFFICIENT_POINTS') {
            return res.status(400).json({ success: false, message: 'رصيد نقاط الزبون غير كافٍ لإتمام العملية!' });
        }
        if (err.message === 'WRONG_STORE') {
            return res.status(403).json({ success: false, message: '⛔ هذه البطاقة تابعة لمتجر آخر!' });
        }
        if (err.message === 'STORE_SUSPENDED') {
            return res.status(403).json({ success: false, message: '⛔ اشتراك المتجر متوقف مؤقتاً!' });
        }
        console.error('Transaction Error:', err.message);
        return res.status(500).json({ success: false, message: 'حدث خطأ أثناء تنفيذ العملية' });
    }
});

async function syncGoogleWalletBalance(customerId, newPoints) {
    const client = await auth.getClient();
    const safeCardId = String(customerId).replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectId = `${issuerId}.${safeCardId}`;
    const objectUrl = `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${objectId}`;

    await client.request({
        url: objectUrl,
        method: 'PATCH',
        data: {
            loyaltyPoints: {
                balance: { int: Number(newPoints) },
                label: 'النقاط'
            }
        }
    });
}

async function ensureClassExists(client, cafeId, cafeName, logoUrl, primaryColor) {
    const classSuffix = cafeId === 'mandel' ? 'MandelRewards' : `${cafeId}_rewards`;
    const classId = `${issuerId}.${classSuffix}`;
    const classUrl = `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass/${classId}`;

    try {
        const res = await client.request({ url: classUrl, method: 'GET' });
        if (res.data.reviewStatus === 'DRAFT' || res.data.reviewStatus === 'draft') {
            await client.request({
                url: classUrl,
                method: 'PATCH',
                data: { reviewStatus: 'UNDER_REVIEW' }
            });
        }
    } catch (err) {
        if (err.response && err.response.status === 404) {
            await client.request({
                url: 'https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass',
                method: 'POST',
                data: {
                    id: classId,
                    issuerName: cafeName || 'Mandel Cafe',
                    programName: `${cafeName || 'Mandel'} Rewards`,
                    programLogo: {
                        sourceUri: {
                            uri: logoUrl || 'https://suleimanalbalawi818.github.io/cafe-loyalty-system/Mandel.jpg'
                        }
                    },
                    hexBackgroundColor: primaryColor || '#1e7041',
                    reviewStatus: 'UNDER_REVIEW'
                }
            });
        }
    }
    return classId;
}

// 1. توليد رابط إضافة البطاقة إلى Google Wallet للزبون
app.post('/create-pass', async (req, res) => {
    const { cardId, customerName, points, cafeId, cafeName, logoUrl, primaryColor } = req.body;

    if (!cardId) {
        return res.status(400).json({ error: 'رقم البطاقة مطلوب' });
    }

    try {
        const client = await auth.getClient();
        const classId = await ensureClassExists(client, cafeId || 'mandel', cafeName, logoUrl, primaryColor);
        const safeCardId = cardId.replace(/[^a-zA-Z0-9._-]/g, '_');
        const objectId = `${issuerId}.${safeCardId}`;
        const objectUrl = `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${objectId}`;

        const objectPayload = {
            id: objectId,
            classId: classId,
            state: 'ACTIVE',
            accountId: cardId,
            accountName: customerName || 'عميل مميز',
            loyaltyPoints: {
                balance: { int: Number(points) || 0 },
                label: 'النقاط'
            },
            barcode: {
                type: 'QR_CODE',
                value: cardId
            }
        };

        try {
            await client.request({ url: objectUrl, method: 'GET' });
            await client.request({ url: objectUrl, method: 'PUT', data: objectPayload });
        } catch (err) {
            if (err.response && err.response.status === 404) {
                await client.request({
                    url: 'https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject',
                    method: 'POST',
                    data: objectPayload
                });
            } else {
                throw err;
            }
        }

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
        return res.status(200).json({
            success: true,
            saveUrl: `https://pay.google.com/gp/v/save/${token}`
        });

    } catch (error) {
        console.error('❌ خطأ في إنشاء البطاقة:', error.response ? error.response.data : error.message);
        return res.status(500).json({ error: 'فشل إنشاء رابط المحفظة' });
    }
});

// 2. تحديث النقاط الفعلي في Google Wallet
app.post('/update-points', async (req, res) => {
    const { customerId, points } = req.body;

    if (!customerId || points === undefined) {
        return res.status(400).json({ error: 'البيانات ناقصة' });
    }

    try {
        await syncGoogleWalletBalance(customerId, points);
        return res.status(200).json({
            success: true,
            message: 'تم تحديث النقاط في محفظة جوجل بنجاح!'
        });
    } catch (error) {
        return res.status(200).json({
            success: true,
            message: 'تم تحديث النقاط بنجاح'
        });
    }
});

// 3. استبدال النقاط
app.post('/redeem-points', async (req, res) => {
    const { customerId, currentPoints } = req.body;

    if (!customerId || currentPoints === undefined) {
        return res.status(400).json({ error: 'البيانات ناقصة' });
    }

    if (currentPoints < 10) {
        return res.status(400).json({
            success: false,
            message: 'رصيد الزبون غير كافٍ لاستبدال المكافأة!'
        });
    }

    const newPoints = Number(currentPoints) - 10;

    try {
        await syncGoogleWalletBalance(customerId, newPoints);
    } catch (error) {}

    return res.status(200).json({
        success: true,
        message: 'تم استبدال النقاط بنجاح!',
        newPoints: newPoints
    });
});

// 4. إرسال إشعار وخصم عيد الميلاد إلى محفظة Google Wallet للزبون
app.post('/send-birthday-offer', async (req, res) => {
    const { customerId, customerName } = req.body;

    if (!customerId) {
        return res.status(400).json({ error: 'رقم البطاقة مطلوب' });
    }

    try {
        const client = await auth.getClient();
        const safeCardId = customerId.replace(/[^a-zA-Z0-9._-]/g, '_');
        const objectId = `${issuerId}.${safeCardId}`;
        const objectUrl = `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${objectId}`;

        await client.request({
            url: objectUrl,
            method: 'PATCH',
            data: {
                messages: [{
                    header: `كل عام وأنت بخير يا ${customerName || 'صديقنا'}! 🎂`,
                    body: 'بمناسبة يوم ميلادك، لك هدية خاصة اليوم! أبرِز البطاقة للكاشير.',
                    id: `bday_${Date.now()}`,
                    messageType: 'TEXT_AND_NOTIFY'
                }]
            }
        });

        return res.status(200).json({
            success: true,
            message: 'تم إرسال إشعار هدية الميلاد لهاتف الزبون بنجاح!'
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: 'الزبون لم يضف البطاقة لمحفظة جوجل بعد، أو تعذر الإرسال.'
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 سيرفر SHABTEN CARD الآمن يعمل الآن على المنفذ ${PORT}...`);
});