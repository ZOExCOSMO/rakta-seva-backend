const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
require('dotenv').config();

const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db        = admin.firestore();
const messaging = admin.messaging();

const app = express();
app.use(cors());
app.use(express.json());

// ── HEALTH CHECK ─────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Rakta-Seva backend running ✓' }));

// ── ROUTE 1: CLAUDE AI CHAT ───────────────────
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  const SYSTEM = `You are Rakta AI, the assistant inside Rakta-Seva Connect,
a blood donor emergency app in India (Bengaluru). Be warm, concise (under 100 words), use emojis.
Expertise: blood donation eligibility (age 18-65, weight >50kg, Hb >12.5g/dL, 90-day cooldown),
pre/post donation diet, blood group compatibility, how Rakta-Seva works (FCM <5s alerts,
AI urgency scoring, 10km proximity matching, Donor ID card, Aadhaar verification).`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: SYSTEM,
        messages
      })
    });
    const data  = await response.json();
    const reply = data.content?.[0]?.text || "I couldn't process that. Try again!";
    res.json({ reply });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'AI service unavailable' });
  }
});

// ── ROUTE 2: NOTIFY NEARBY DONORS via FCM ─────
app.post('/api/notify-donors', async (req, res) => {
  const { requestId, bloodGroup, lat, lng, radiusKm = 10, hospitalName = 'Nearby Hospital' } = req.body;
  const start = Date.now();

  try {
    const snapshot = await db.collection('donors')
      .where('bloodGroup', '==', bloodGroup)
      .where('isAvailable', '==', true)
      .get();

    const eligibleTokens = [];
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;

    snapshot.forEach(doc => {
      const d = doc.data();
      if ((Date.now() - (d.lastDonationDateMillis || 0)) < ninetyDays) return;
      const dLat = d.location?.latitude;
      const dLng = d.location?.longitude;
      if (!dLat || !dLng || !d.fcmToken) return;
      const dist = haversine(lat, lng, dLat, dLng);
      if (dist <= radiusKm) eligibleTokens.push({ token: d.fcmToken, dist: dist.toFixed(1) });
    });

    if (!eligibleTokens.length) return res.json({ notifiedCount: 0, deliveredIn: Date.now() - start });

    const msgs = eligibleTokens.map(({ token, dist }) => ({
      token,
      data: { requestId, bloodGroup, hospital: hospitalName, distanceKm: dist,
              title: `🩸 Urgent: ${bloodGroup} Needed`, body: `${hospitalName} · ${dist} km away` },
      android: { priority: 'high', notification: { channelId: 'emergency_alerts', sound: 'default' } }
    }));

    let sent = 0;
    for (let i = 0; i < msgs.length; i += 500) {
      const r = await messaging.sendEach(msgs.slice(i, i + 500));
      sent += r.successCount;
    }

    console.log(`Notified ${sent} donors in ${Date.now() - start}ms`);
    res.json({ notifiedCount: sent, deliveredIn: Date.now() - start });
  } catch (err) {
    console.error('Notify error:', err.message);
    res.status(500).json({ error: 'Notification failed' });
  }
});

// ── HELPER ────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

app.listen(process.env.PORT || 3000, () =>
  console.log(`Rakta-Seva backend on port ${process.env.PORT || 3000}`));