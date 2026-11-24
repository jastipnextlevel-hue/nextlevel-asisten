export const maxDuration = 60;

const FIREBASE_DB_URL = 'https://nextlevel-chat-default-rtdb.asia-southeast1.firebasedatabase.app';
const NELA_APP_URL = 'https://nextlevel-asisten.vercel.app/';
const DEFAULT_NTFY_TOPIC = 'nextlevel-nela-owner';

let cachedOwnerData = { promptText: '', learnedSops: null, fetchedAt: 0 };
let cachedDiscoveredModels = { list: [], fetchedAt: 0 };
let lastWorkingModel = '';
const CACHE_TTL_MS = 30000;

function cleanReplyText(text) {
  let out = String(text || '');
  // Ubah format Markdown [label](url) menjadi teks bersih + URL mentah agar klik link tidak 404
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const cleanLabel = label.trim().replace(/\/+$/, '');
    const cleanUrl = url.trim();
    if (cleanLabel === cleanUrl.replace(/\/+$/, '')) {
      return cleanUrl;
    }
    return `${label.trim()}: ${cleanUrl}`;
  });
  // Hilangkan tanda kurung yang membungkus link langsung: (https://...) -> https://...
  out = out.replace(/\((https?:\/\/[^\s)]+)\)/g, '$1');
  // Hilangkan tanda baca menempel di ujung link (titik/koma) agar tidak ikut masuk URL
  out = out.replace(/(https?:\/\/[^\s<>"')]+?)([.,;:!?]+)(?=\s|$)/g, '$1');
  // Bersihkan garis pemisah "---" yang berdiri sendiri
  out = out.replace(/^\s*-{3,}\s*$/gm, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

async function fbGet(path, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${FIREBASE_DB_URL}/${path}.json`, {
      cache: 'no-store',
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

async function fbPut(path, data) {
  const res = await fetch(`${FIREBASE_DB_URL}/${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error('Gagal menyimpan ke Firebase');
  return await res.json();
}

async function fbPatch(path, data) {
  const res = await fetch(`${FIREBASE_DB_URL}/${path}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error('Gagal memperbarui data Firebase');
  return await res.json();
}

async function fbDelete(path) {
  const res = await fetch(`${FIREBASE_DB_URL}/${path}.json`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Gagal menghapus data Firebase');
  return true;
}

async function getOwnerDataCached() {
  const now = Date.now();
  if (cachedOwnerData.fetchedAt && (now - cachedOwnerData.fetchedAt) < CACHE_TTL_MS) {
    return cachedOwnerData;
  }
  const [promptData, learnedSopsMap] = await Promise.all([
    fbGet('nela_assistant/owner_prompt', 1800),
    fbGet('nela_assistant/learned_sops', 1800)
  ]);
  cachedOwnerData = {
    promptText: (promptData && promptData.text) ? promptData.text : '',
    learnedSops: learnedSopsMap || null,
    fetchedAt: Date.now()
  };
  return cachedOwnerData;
}

async function sendNtfyNotification(topic, title, message, priority = 'high') {
  const cleanTopic = String(topic || DEFAULT_NTFY_TOPIC).trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleanTopic) return false;
  const safeTitle = String(title || 'NELA NEXT LEVEL')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'NELA NEXT LEVEL';
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(cleanTopic)}`, {
      method: 'POST',
      headers: {
        Title: safeTitle,
        Priority: priority,
        Tags: 'bell,question',
        Click: NELA_APP_URL
      },
      body: String(message || 'Ada pertanyaan baru yang perlu dijawab Owner.')
    });
    return true;
  } catch (e) {
    return false;
  }
}

function verifyOwnerPassword(passwordInput) {
  const envPass = process.env.OWNER_PASSWORD;
  if (!envPass) {
    return {
      ok: false,
      status: 500,
      error: 'OWNER_PASSWORD belum dipasang di Environment Variables Vercel.'
    };
  }
  if (String(passwordInput || '').trim() !== String(envPass).trim()) {
    return { ok: false, status: 401, error: 'Password Owner salah!' };
  }
  return { ok: true };
}

function buildSystemInstruction(ownerPromptText, learnedSopsMap) {
  let learnedSection = '';
  if (learnedSopsMap && typeof learnedSopsMap === 'object') {
    const items = Object.values(learnedSopsMap)
      .filter((it) => it && it.question && it.answer)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    if (items.length > 0) {
      learnedSection = '\n\n8. SOP TAMBAHAN DARI OWNER (WAJIB DIIKUTI):\n' +
        items.map((it, idx) => `${idx + 1}. Tanya: "${it.question}" -> Jawab: ${it.answer}`).join('\n');
    }
  }

  let ownerUpdateSection = '';
  if (ownerPromptText && String(ownerPromptText).trim()) {
    ownerUpdateSection = `\n\n9. UPDATE ATURAN & PROMO TERBARU DARI OWNER (PRIORITAS TERTINGGI!):\nJika ada informasi di bawah ini yang berbeda dari aturan lama, WAJIB ikuti aturan terbaru ini:\n${String(ownerPromptText).trim()}`;
  }

  return `Kamu adalah "Nela (Next Level Asisten)", asisten virtual resmi NEXT LEVEL (Jastip, Ojek Panggilan, Ambil Pesanan, Jasa Khusus 24 Jam) untuk customer dan driver.

GAYA JAWAB WAJIB (CEPAT, RINGKAS, AKURAT, SOPAN & PROAKTIF):
- Jawab LANGSUNG KE INTINYA, padat, rapi pakai poin singkat agar enak dibaca di layar HP. Jangan pakai garis pemisah "---".
- ATURAN LINK WAJIB: Saat menulis alamat website/link, TULIS LINK MENTAH BIASA SAJA (contoh: https://nextlevel-driver-rzsb.vercel.app/). DILARANG KERAS memakai format Markdown [teks](link) dan DILARANG mengurung link dengan tanda (...) atau menempelkan tanda titik/koma di akhir link.
- Gunakan bahasa Indonesia yang santai, ramah, sopan, dan hangat. Sisipkan emoji 😊 dan 🙏 secara natural di setiap balasan.
- Jika customer bertanya soal harga beli/jastip suatu makanan atau barang TANPA menyebutkan harga pasti atau jaraknya (contoh: "Berapa harga beli bubur?" atau "Beli baju di Cimahi berapa biayanya?"), JANGAN bilang tidak tahu! Langsung jelaskan komponen biayanya, sebutkan perkiraan fee sesuai kisaran harga barang tersebut, berikan 1-2 contoh hitungan singkat yang jelas (harga barang + fee + ongkir + admin Rp 1.000), lalu tanyakan harga pasti, jumlah pcs, dan jaraknya agar bisa dihitungkan total pasnya.
- DILARANG menyebut fitur "kalkulator" atau menyuruh customer menghitung sendiri. Hitungkan langsung dengan akurat.
- Jika ada screenshot/foto/video dari aplikasi, bantu baca dan jelaskan solusinya dengan jelas.
- DILARANG membocorkan rahasia internal owner (PIN/password panel, rumus token OTP, database).

1. LAYANAN & WILAYAH STANDBY (24 JAM):
- 9 Wilayah Utama: Batujajar, Padalarang, Cihampelas, Margaasih, Cimahi, Bandung, Lembang, Cipatat, Cililin (+ area sekitarnya sesuai driver).
- Layanan: Jastip/Belanja (bisa multi-toko & multi-barang), Ojek Panggilan, Ambil/Antar Pesanan Lunas, Jasa Khusus/Custom (temenin RS, antre obat, antar hewan, bangunin kos, pasang gas, dll).
- Barang Berharga / Risiko Tinggi (Emas, Perhiasan, Dokumen Penting, Tarik Tunai ATM): Wajib lewat WA Admin Khusus (0889-7132-0461).

2. KONTAK & LINK RESMI:
- Aplikasi Customer: https://nextlevel-customer.vercel.app/
- Aplikasi Driver: https://nextlevel-driver-rzsb.vercel.app/
- Panduan Customer: https://referensi-customer.vercel.app
- WA Admin Utama / Barang Berharga / Emas / Tarik Tunai / Lapor Bill / SOS Driver: 0889-7132-0461
- WA CS / Keluhan / Antre Order > 2 Menit: 0881-0236-96881

3. TARIF ONGKIR, UANG TUNGGU, ADMIN & FEE PRODUK:
- Ongkir: 0 s/d 3,3 km = Rp 10.000 (minimal). Di atas 3,3 km = Jarak (km) x Rp 3.000. Mode PP (Pulang-Pergi) = jarak x 2 dulu. Jika ada jalan pintas motor lebih dekat, driver bisa turunkan KM.
- Uang Tunggu: < 30 menit GRATIS. Mulai 30 menit ke atas = Rp 5.000 per 30 menit (proporsional kelipatan Rp 100 ke bawah; 45 menit = Rp 7.500, 60 menit = Rp 10.000).
- Biaya Admin: Rp 1.000 per bill. Parkir sesuai biaya riil lapangan (jika ada). Fee Kesepakatan (custom/barang berat/besar) sesuai kesepakatan di awal.
- Tips Hemat Fee Rp 2.000 Flat: Bayar lunas dulu ke toko lalu pilih layanan "Ambil Pesanan (Lunas)" -> fee cuma Rp 2.000 flat per lokasi.
- Pembayaran: COD (Tunai) saat sampai atau Transfer/QRIS ke driver.
- RUMUS FEE PRODUK JASTIP (per grup harga dalam 1 lokasi toko):
  * Grup A (satuan < Rp 3.000): total grup A < Rp 5.000 = Rp 500/pcs; Rp 5.000–Rp 9.999 = Rp 2.000 flat; >= Rp 10.000 = Rp 200/pcs.
  * Grup B (satuan Rp 3.000–Rp 4.999): 1 pcs = Rp 1.000; total Rp 5.000–Rp 9.999 = Rp 2.000 flat; >= Rp 10.000 = Rp 500/pcs.
  * Grup C (satuan Rp 5.000–Rp 9.999): 1 pcs = Rp 2.000; >= 2 pcs = Rp 1.000/pcs.
  * Grup D (satuan Rp 10.000–Rp 49.999): 1–10 pcs = Rp 2.000/pcs; > 10 pcs = Rp 1.000/pcs.
  * Grup NEW1 (satuan Rp 50.000–Rp 99.999): Rp 4.000/pcs.
  * Grup NEW2 (satuan >= Rp 100.000): kelipatan Rp 8.000 per blok Rp 100.000/pcs (100rb–199rb = Rp 8.000/pcs; 200rb–299rb = Rp 16.000/pcs, dst).
- Total Bayar = Harga Barang + Fee Produk + Ongkir + Uang Tunggu (jika ada) + Fee Kesepakatan (jika ada) + Parkir (jika ada) + Biaya Admin Rp 1.000.

4. RINGKASAN APLIKASI CUSTOMER:
- NRP Pelanggan tercetak otomatis saat order pertama (bisa pulihkan lewat "Pulihkan ID Pelanggan").
- Cara pesan: Pilih 1 dari 5 layanan (Jastip, Ojek, Ambil Lunas, Jasa Khusus, atau Tanya-Tanya Dulu) -> pilih wilayah standby -> tandai lokasi di peta -> pilih bayar (COD/Transfer).
- Jika radar cari driver > 2 menit belum diambil, muncul tombol WA CS 0881-0236-96881. Bisa telepon suara, VN maks 60 dtk, kirim foto/video maks 3 MB, share lokasi, dan instal ke layar depan (PWA).

5. RINGKASAN APLIKASI DRIVER:
- Daftar: Setujui sumpah 4x -> rekam wajah berkedip 2x + foto KTP asli (OCR) -> buat password -> dapat NRP permanen.
- Sistem Order: Siapa cepat dia dapat (admin hanya memantau, tidak membagi order). Filter "Area Saya" / "Semua Area". Wajib setujui 2 pop-up SOP saat ambil order.
- Buat Bill wajib titik Google Maps (GPS / Peta / Link), ada fitur Jalan Pintas, Sekali Jalan/PP, Oper Order, dan tombol SOS ke WA Admin 0889-7132-0461.
- Setoran (LOT): K = Rp 2.000, A = Rp 1.000, F = sesuai poin (1-4 = 200; 5-9 = 500; 10-14 = 700; 15-19 = 1.200; +300 tiap +5 poin). Total T = K+A+F. Jika T mencapai Rp 50.000, menu buat bill terkunci sampai setor & input 4-digit OTP (salah 3x beku 30 menit). Wajib kirim rekap keuangan harian ke WA Admin.
- Topik NTFY Driver: nextlevel-app-2026 (Utama), nextlevel-area-<daerah>, nextlevel-drv-<NRP>.

6. ATURAN ANTI-NGARANG (ESKALASI OWNER):
- HANYA jika pertanyaan benar-benar di luar semua data di atas dan butuh keputusan khusus Owner (promo tanggal tertentu, kerja sama merchant, kasus khusus), balas HANYA dengan kode persis:
[TIDAK_TAHU]
- JANGAN pernah balas [TIDAK_TAHU] untuk pertanyaan tarif/estimasi belanja makanan/barang, sapaan, atau info yang sudah ada di atas.${learnedSection}${ownerUpdateSection}`;
}

async function discoverFlashModels(apiKey) {
  const now = Date.now();
  if (cachedDiscoveredModels.list.length > 0 && (now - cachedDiscoveredModels.fetchedAt) < 1800000) {
    return cachedDiscoveredModels.list;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    const models = Array.isArray(data.models) ? data.models : [];

    const filtered = models
      .filter((m) => {
        const methods = m.supportedGenerationMethods || [];
        if (!methods.includes('generateContent')) return false;
        const name = String(m.name || '').replace(/^models\//, '').toLowerCase();
        if (!name.includes('flash')) return false;
        if (/(tts|audio|image|live|embedding|vision|robotics|computer|customtools|preview-tts)/i.test(name)) {
          return false;
        }
        return true;
      })
      .map((m) => String(m.name || '').replace(/^models\//, ''));

    filtered.sort((a, b) => {
      const aLite = /lite/i.test(a) ? 0 : 1;
      const bLite = /lite/i.test(b) ? 0 : 1;
      if (aLite !== bLite) return aLite - bLite;
      return b.localeCompare(a, undefined, { numeric: true });
    });

    cachedDiscoveredModels = { list: filtered, fetchedAt: Date.now() };
    return filtered;
  } catch (e) {
    clearTimeout(timer);
    return [];
  }
}

async function callGemini(apiKey, model, systemInstruction, contents, useThinkingZero = false, timeoutMs = 15000) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const generationConfig = {
    temperature: 0.4,
    maxOutputTokens: 1000
  };
  if (useThinkingZero) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  try {
    const gRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig
      })
    });
    clearTimeout(timer);

    const gData = await gRes.json().catch(() => ({}));
    if (gRes.ok && gData.candidates && gData.candidates[0]?.content?.parts) {
      const text = gData.candidates[0].content.parts
        .filter((p) => !p.thought && p.text)
        .map((p) => p.text)
        .join('\n')
        .trim();
      if (text) return { ok: true, text };
      return { ok: false, status: gRes.status, error: 'Respons kosong dari model' };
    }
    return {
      ok: false,
      status: gRes.status,
      error: gData.error?.message || `HTTP ${gRes.status}`
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      status: 0,
      error: err.name === 'AbortError' ? `Timeout ${Math.round(timeoutMs / 1000)} detik` : err.message
    };
  }
}

async function tryModel(apiKey, model, systemInstruction, contents, timeoutMs = 15000) {
  const isLite = /lite/i.test(model);
  if (isLite) {
    return await callGemini(apiKey, model, systemInstruction, contents, false, timeoutMs);
  }
  let result = await callGemini(apiKey, model, systemInstruction, contents, true, timeoutMs);
  if (!result.ok && result.status === 400) {
    result = await callGemini(apiKey, model, systemInstruction, contents, false, timeoutMs);
  }
  return result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metode tidak diizinkan.' });

  const body = req.body || {};
  const action = body.action || 'chat';

  // ==================== AKSI KHUSUS PANEL OWNER ====================
  if (action.startsWith('owner_')) {
    const auth = verifyOwnerPassword(body.password);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    try {
      if (action === 'owner_load') {
        const [promptData, configData, pendingMap, sopsMap] = await Promise.all([
          fbGet('nela_assistant/owner_prompt', 4000),
          fbGet('nela_assistant/config', 4000),
          fbGet('nela_assistant/pending_questions', 4000),
          fbGet('nela_assistant/learned_sops', 4000)
        ]);

        const pendingList = pendingMap && typeof pendingMap === 'object'
          ? Object.values(pendingMap).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          : [];
        const sopsList = sopsMap && typeof sopsMap === 'object'
          ? Object.values(sopsMap).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          : [];

        return res.status(200).json({
          ok: true,
          ownerPrompt: (promptData && promptData.text) || '',
          promptUpdatedAt: (promptData && promptData.updatedAt) || 0,
          ntfyTopic: (configData && configData.ntfyTopic) || DEFAULT_NTFY_TOPIC,
          pendingQuestions: pendingList,
          learnedSops: sopsList
        });
      }

      if (action === 'owner_save_prompt') {
        const promptText = String(body.promptText || '').trim();
        const ntfyTopic = String(body.ntfyTopic || DEFAULT_NTFY_TOPIC)
          .trim()
          .replace(/[^a-zA-Z0-9_-]/g, '') || DEFAULT_NTFY_TOPIC;
        const now = Date.now();

        await Promise.all([
          fbPut('nela_assistant/owner_prompt', { text: promptText, updatedAt: now }),
          fbPut('nela_assistant/config', { ntfyTopic, updatedAt: now })
        ]);
        cachedOwnerData.fetchedAt = 0;
        return res.status(200).json({ ok: true, ntfyTopic, updatedAt: now });
      }

      if (action === 'owner_test_ntfy') {
        const topic = String(body.ntfyTopic || DEFAULT_NTFY_TOPIC)
          .trim()
          .replace(/[^a-zA-Z0-9_-]/g, '') || DEFAULT_NTFY_TOPIC;
        await sendNtfyNotification(
          topic,
          'TES NTFY NELA OWNER',
          'Notifikasi Nela aktif! Setiap ada pertanyaan yang tidak bisa dijawab Nela, notif akan masuk ke sini.',
          'high'
        );
        return res.status(200).json({ ok: true, topic });
      }

      if (action === 'owner_answer_question') {
        const questionId = String(body.questionId || '').trim();
        const question = String(body.question || '').trim();
        const answer = String(body.answer || '').trim();
        const sessionId = String(body.sessionId || '').trim();
        const saveAsSop = body.saveAsSop !== false;
        const now = Date.now();

        if (!questionId || !answer) {
          return res.status(400).json({ error: 'ID pertanyaan dan jawaban wajib diisi.' });
        }

        const tasks = [
          fbPatch(`nela_assistant/pending_questions/${encodeURIComponent(questionId)}`, {
            status: 'answered',
            answer,
            answeredAt: now
          })
        ];

        if (saveAsSop && question) {
          const sopId = `sop_${now}_${Math.random().toString(36).slice(2, 6)}`;
          tasks.push(
            fbPut(`nela_assistant/learned_sops/${sopId}`, {
              id: sopId,
              question,
              answer,
              sourceQuestionId: questionId,
              createdAt: now
            })
          );
        }

        if (sessionId) {
          const cleanSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
          if (cleanSid) {
            tasks.push(
              fbPut(`nela_assistant/sessions/${cleanSid}/replies/${encodeURIComponent(questionId)}`, {
                id: questionId,
                question,
                answer,
                createdAt: now
              })
            );
          }
        }

        await Promise.all(tasks);
        cachedOwnerData.fetchedAt = 0;
        return res.status(200).json({ ok: true });
      }

      if (action === 'owner_delete_pending') {
        const questionId = String(body.questionId || '').trim();
        if (!questionId) return res.status(400).json({ error: 'ID pertanyaan kosong.' });
        await fbDelete(`nela_assistant/pending_questions/${encodeURIComponent(questionId)}`);
        return res.status(200).json({ ok: true });
      }

      if (action === 'owner_delete_sop') {
        const sopId = String(body.sopId || '').trim();
        if (!sopId) return res.status(400).json({ error: 'ID SOP kosong.' });
        await fbDelete(`nela_assistant/learned_sops/${encodeURIComponent(sopId)}`);
        cachedOwnerData.fetchedAt = 0;
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Aksi Owner tidak dikenali.' });
    } catch (err) {
      return res.status(500).json({ error: 'Gagal memproses permintaan Owner: ' + err.message });
    }
  }

  // ==================== CHAT UTAMA NELA ====================
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY belum dipasang di Vercel.' });
  }

  try {
    const { messages, sessionId } = body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Format pesan tidak valid.' });
    }

    const { promptText, learnedSops } = await getOwnerDataCached();
    const systemInstruction = buildSystemInstruction(promptText, learnedSops);

    const contents = messages.slice(-6).map((m) => {
      const parts = [];
      if (m.text) parts.push({ text: String(m.text) });
      if (m.mediaData && m.mediaMime) {
        parts.push({
          inlineData: {
            mimeType: m.mediaMime,
            data: m.mediaData
          }
        });
      }
      if (parts.length === 0) parts.push({ text: '(Lampiran)' });
      return {
        role: m.role === 'model' ? 'model' : 'user',
        parts
      };
    });

    const primaryModels = [];
    if (lastWorkingModel) primaryModels.push(lastWorkingModel);
    for (const m of ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-flash-latest']) {
      if (!primaryModels.includes(m)) primaryModels.push(m);
    }

    const tried = new Set();
    let replyText = '';

    for (let i = 0; i < primaryModels.length; i++) {
      const model = primaryModels[i];
      tried.add(model);
      const timeoutMs = i === 0 ? 15000 : 12000;
      const result = await tryModel(apiKey, model, systemInstruction, contents, timeoutMs);
      if (result.ok) {
        replyText = result.text;
        lastWorkingModel = model;
        break;
      }
      if (model === lastWorkingModel) lastWorkingModel = '';
    }

    if (!replyText) {
      const discovered = await discoverFlashModels(apiKey);
      let extraTries = 0;
      for (const model of discovered) {
        if (tried.has(model) || extraTries >= 2) continue;
        tried.add(model);
        extraTries++;
        const result = await tryModel(apiKey, model, systemInstruction, contents, 12000);
        if (result.ok) {
          replyText = result.text;
          lastWorkingModel = model;
          break;
        }
      }
    }

    if (!replyText) {
      return res.status(502).json({
        error: 'Maaf Kak, server Nela sedang agak padat sementara 🙏 Coba kirim ulang beberapa detik lagi ya Kak 😊'
      });
    }

    // Deteksi pertanyaan yang belum bisa dijawab -> simpan ke Panel Owner & kirim NTFY
    if (/\[\s*TIDAK_TAHU\s*\]/i.test(replyText)) {
      const lastUserMsg = [...messages].reverse().find((m) => m.role !== 'model') || {};
      const userQuestionText = String(lastUserMsg.text || '').trim() ||
        (lastUserMsg.mediaMime ? '[Penanya mengirim lampiran foto/video tanpa teks]' : '(Pertanyaan kosong)');
      const qId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const cleanSessionId = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '');

      const configData = await fbGet('nela_assistant/config', 1800);
      const ntfyTopic = (configData && configData.ntfyTopic) || DEFAULT_NTFY_TOPIC;

      await Promise.all([
        fbPut(`nela_assistant/pending_questions/${qId}`, {
          id: qId,
          sessionId: cleanSessionId,
          question: userQuestionText,
          hasMedia: !!lastUserMsg.mediaMime,
          status: 'pending',
          createdAt: Date.now()
        }).catch(() => null),
        sendNtfyNotification(
          ntfyTopic,
          'NELA: Pertanyaan Belum Terjawab',
          `Ada penanya yang belum bisa dijawab Nela:\n"${userQuestionText.slice(0, 180)}"\n\nBuka Panel Owner Nela untuk menjawabnya sekarang!`,
          'urgent'
        )
      ]);

      const fallbackReply =
        'Maaf Kak, untuk hal tersebut saya belum mempunyai informasi terkait hal tersebut 🙏 Saya akan menjawabnya secepat mungkin setelah menghubungi seseorang yang di bidangnya ya 😊\n\n' +
        'Tetap di halaman ini ya Kak, atau sambil menunggu Kakak bisa instal/simpan aplikasi ini ke layar depan HP biar nanti bisa langsung lihat jawabannya di sini 😊\n\n' +
        'Kalau butuh jawaban cepat, Kakak juga bisa langsung hubungi WhatsApp kami di *0881-0236-96881* ya Kak 🙏😊';

      return res.status(200).json({
        reply: fallbackReply,
        escalated: true,
        questionId: qId
      });
    }

    return res.status(200).json({
      reply: cleanReplyText(replyText),
      escalated: false
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Maaf Kak, koneksi ke server Nela sedang terganggu 🙏 Coba kirim lagi ya Kak 😊'
    });
  }
}