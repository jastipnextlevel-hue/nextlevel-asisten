import crypto from 'crypto';

const PROJECT_ID = 'nextlevel-chat';
const FIREBASE_DB_URL = 'https://nextlevel-chat-default-rtdb.asia-southeast1.firebasedatabase.app';
const DEFAULT_ICON = 'https://i.postimg.cc/Dyr12NNx/1794292182201.jpg';

let cachedAccessToken = { token: '', expiresAt: 0 };

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.private_key && parsed.client_email) {
      parsed.private_key = String(parsed.private_key).replace(/\\n/g, '\n');
      return parsed;
    }
  } catch (e) {}
  return null;
}

async function getGoogleAccessToken(sa) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (cachedAccessToken.token && cachedAccessToken.expiresAt > nowSec + 120) {
    return cachedAccessToken.token;
  }

  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600
  }));

  const unsigned = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = base64UrlEncode(signer.sign(sa.private_key));
  const assertion = `${unsigned}.${signature}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => '');
    throw new Error('OAuth2 token gagal: ' + errTxt.slice(0, 200));
  }

  const data = await resp.json();
  cachedAccessToken = {
    token: data.access_token,
    expiresAt: nowSec + (parseInt(data.expires_in, 10) || 3500)
  };
  return data.access_token;
}

function toSafeKey(str) {
  return String(str || '').trim().replace(/\./g, '_').replace(/[#$[\]/]/g, '_');
}

async function sendSingleFcm(accessToken, deviceToken, { title, body, url, orderId, tag }) {
  const clickLink = url || '/';
  const payload = {
    message: {
      token: deviceToken,
      notification: {
        title: String(title || 'NEXT LEVEL').slice(0, 120),
        body: String(body || 'Ada pembaruan baru di NEXT LEVEL').slice(0, 240)
      },
      data: {
        title: String(title || 'NEXT LEVEL').slice(0, 120),
        body: String(body || 'Ada pembaruan baru di NEXT LEVEL').slice(0, 240),
        url: String(clickLink),
        orderId: String(orderId || ''),
        tag: String(tag || orderId || 'nextlevel-push')
      },
      webpush: {
        headers: {
          Urgency: 'high',
          TTL: '1800'
        },
        notification: {
          title: String(title || 'NEXT LEVEL').slice(0, 120),
          body: String(body || 'Ada pembaruan baru di NEXT LEVEL').slice(0, 240),
          icon: DEFAULT_ICON,
          badge: DEFAULT_ICON,
          vibrate: [250, 120, 250, 120, 400],
          requireInteraction: true,
          tag: String(tag || orderId || 'nextlevel-push')
        },
        fcm_options: {
          link: String(clickLink)
        }
      }
    }
  };

  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (resp.ok) return { ok: true };
  const errJson = await resp.json().catch(() => ({}));
  const errCode = errJson?.error?.details?.[0]?.errorCode || errJson?.error?.status || '';
  return {
    ok: false,
    unregistered: errCode === 'UNREGISTERED' || errCode === 'INVALID_ARGUMENT' || resp.status === 404,
    error: errJson?.error?.message || `HTTP ${resp.status}`
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const sa = parseServiceAccount();
  if (!sa) {
    return res.status(200).json({
      ok: false,
      configured: false,
      error: 'FIREBASE_SERVICE_ACCOUNT belum dipasang di Environment Variables Vercel.'
    });
  }

  try {
    const body = req.body || {};
    const targetType = String(body.targetType || '').trim().toLowerCase(); // 'driver' | 'customer' | 'owner'
    const targetId = toSafeKey(body.targetId || '');
    const directToken = String(body.directToken || '').trim();
    const title = String(body.title || 'NEXT LEVEL').trim();
    const msgBody = String(body.body || 'Ada pembaruan baru').trim();
    const url = String(body.url || '/').trim();
    const orderId = String(body.orderId || '').trim();
    const tag = String(body.tag || orderId || 'nextlevel-push').trim();

    const accessToken = await getGoogleAccessToken(sa);

    if (directToken) {
      const r = await sendSingleFcm(accessToken, directToken, { title, body: msgBody, url, orderId, tag });
      return res.status(200).json({ ok: r.ok, sent: r.ok ? 1 : 0, error: r.error || '' });
    }

    if (!targetType || !targetId) {
      return res.status(400).json({ ok: false, error: 'targetType dan targetId wajib diisi' });
    }

    const dbPath = `fcm_tokens/${encodeURIComponent(targetType)}/${encodeURIComponent(targetId)}`;
    const tokResp = await fetch(`${FIREBASE_DB_URL}/${dbPath}.json`, { cache: 'no-store' });
    const tokMap = tokResp.ok ? await tokResp.json() : null;

    if (!tokMap || typeof tokMap !== 'object') {
      return res.status(200).json({ ok: true, sent: 0, info: 'Belum ada token FCM terdaftar untuk penerima ini' });
    }

    const entries = Object.entries(tokMap).filter(([, v]) => v && v.token);
    let sent = 0;
    const staleKeys = [];

    await Promise.all(entries.map(async ([k, v]) => {
      const r = await sendSingleFcm(accessToken, v.token, { title, body: msgBody, url, orderId, tag });
      if (r.ok) sent++;
      else if (r.unregistered) staleKeys.push(k);
    }));

    // Bersihkan token perangkat lama yang sudah tidak valid
    await Promise.all(staleKeys.map((k) =>
      fetch(`${FIREBASE_DB_URL}/${dbPath}/${encodeURIComponent(k)}.json`, { method: 'DELETE' }).catch(() => null)
    ));

    return res.status(200).json({ ok: true, sent, totalDevices: entries.length, cleaned: staleKeys.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Gagal mengirim push notification' });
  }
}
