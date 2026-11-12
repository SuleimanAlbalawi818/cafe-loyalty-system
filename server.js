const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { GoogleAuth } = require('google-auth-library');

const credentials = process.env.GOOGLE_CREDENTIALS 
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS) 
    : require('./key.json');

const app = express();
app.use(cors());
app.use(express.json());

const issuerId = '3388000000023233741';

const auth = new GoogleAuth({
    credentials: credentials,
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer']
});

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

// 2. تحديث النقاط الفعلي في Google Wallet من شاشة الكاشير
app.post('/update-points', async (req, res) => {
    const { customerId, points } = req.body;

    if (!customerId || points === undefined) {
        return res.status(400).json({ error: 'البيانات ناقصة' });
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
                loyaltyPoints: {
                    balance: { int: Number(points) },
                    label: 'النقاط'
                }
            }
        });

        console.log(`✅ تم تحديث نقاط الزبون ${customerId} في Google Wallet إلى: ${points}`);
        return res.status(200).json({
            success: true,
            message: 'تم تحديث النقاط في محفظة جوجل بنجاح!'
        });
    } catch (error) {
        console.log(`ℹ️ تم تحديث النقاط محلياً (الزبون ${customerId} لم يضف البطاقة لمحفظة جوجل بعد)`);
        return res.status(200).json({
            success: true,
            message: 'تم تحديث النقاط بنجاح'
        });
    }
});

// 3. استبدال النقاط (خصم 10 نقاط) وتحديث Google Wallet
app.post('/redeem-points', async (req, res) => {
    const { customerId, currentPoints } = req.body;

    if (!customerId || currentPoints === undefined) {
        return res.status(400).json({ error: 'البيانات ناقصة' });
    }

    if (currentPoints < 10) {
        return res.status(400).json({
            success: false,
            message: 'رصيد الزبون غير كافٍ لاستبدال المكافأة! (يحتاج 10 نقاط على الأقل)'
        });
    }

    const newPoints = Number(currentPoints) - 10;

    try {
        const client = await auth.getClient();
        const safeCardId = customerId.replace(/[^a-zA-Z0-9._-]/g, '_');
        const objectId = `${issuerId}.${safeCardId}`;
        const objectUrl = `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${objectId}`;

        await client.request({
            url: objectUrl,
            method: 'PATCH',
            data: {
                loyaltyPoints: {
                    balance: { int: newPoints },
                    label: 'النقاط'
                }
            }
        });
    } catch (error) {
        console.log(`ℹ️ الزبون ${customerId} لم يضف البطاقة لمحفظة جوجل بعد.`);
    }

    console.log(`🎁 استبدال مكافأة للزبون ${customerId}. الرصيد المتبقي: ${newPoints}`);
    return res.status(200).json({
        success: true,
        message: 'تم استبدال النقاط بقهوة مجانية بنجاح!',
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
                    body: 'بمناسبة يوم ميلادك، لك خصم خاص أو قهوة مجانية اليوم! أبرِز البطاقة للكاشير.',
                    id: `bday_${Date.now()}`,
                    messageType: 'TEXT_AND_NOTIFY'
                }]
            }
        });

        console.log(`🎂 تم إرسال إشعار عيد الميلاد للزبون ${customerId}`);
        return res.status(200).json({
            success: true,
            message: 'تم إرسال إشعار هدية الميلاد لهاتف الزبون بنجاح!'
        });
    } catch (error) {
        console.error('❌ خطأ في إرسال إشعار الميلاد:', error.response ? error.response.data : error.message);
        return res.status(400).json({
            success: false,
            message: 'الزبون لم يضف البطاقة لمحفظة جوجل بعد، أو تعذر الإرسال.'
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.