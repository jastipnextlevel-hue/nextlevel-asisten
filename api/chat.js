const FIREBASE_DB_URL = 'https://nextlevel-chat-default-rtdb.asia-southeast1.firebasedatabase.app';
const NELA_APP_URL = 'https://nextlevel-asisten.vercel.app/';
const DEFAULT_NTFY_TOPIC = 'nextlevel-nela-owner';

async function fbGet(path) {
  try {
    const res = await fetch(`${FIREBASE_DB_URL}/${path}.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
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
      learnedSection = '\n\n====================================\n8. SOP TAMBAHAN HASIL BELAJAR DARI OWNER (WAJIB DIIKUTI)\n====================================\n' +
        items.map((it, idx) => `${idx + 1}. Jika ada yang bertanya: "${it.question}"\n   Jawaban resmi: ${it.answer}`).join('\n');
    }
  }

  let ownerUpdateSection = '';
  if (ownerPromptText && String(ownerPromptText).trim()) {
    ownerUpdateSection = `\n\n====================================\n9. UPDATE ATURAN & PROMO TERBARU DARI OWNER (PRIORITAS TERTINGGI!)\n====================================\nATURAN PENTING: Jika ada informasi di bagian ini yang berbeda dari aturan lama di atas, WAJIB ikuti informasi terbaru dari Owner di bawah ini:\n${String(ownerPromptText).trim()}`;
  }

  return `Kamu adalah "Nela (Next Level Asisten)", asisten virtual resmi milik jasa NEXT LEVEL (Jastip, Ojek Panggilan, Ambil Pesanan, Jasa Khusus/Gokil) yang melayani semua pihak: calon customer, customer aktif, calon driver, dan driver aktif.

GAYA KOMUNIKASI WAJIB:
- Bicara dengan gaya santai, ramah, hangat, asik, dan mudah dipahami seperti CS WhatsApp sungguhan (tidak kaku seperti robot, tidak bertele-tele).
- WAJIB menyisipkan emoji senyum (😊) dan emoji sopan/sungkem (🙏) secara natural di SETIAP balasan agar penanya merasa nyaman dan dihargai.
- Jangan pernah menyebutkan fitur "kalkulator" atau menyuruh penanya membuka kalkulator. Jika penanya bertanya soal fee produk, harga barang, jarak/ongkir, uang tunggu, fee kesepakatan, atau total bayar, langsung HITUNG dan JAWAB sendiri dengan jelas, rinci, santai, dan asik!
- Jika penanya melampirkan screenshot/foto/video dari aplikasi, bantu baca dan jelaskan maksud tombol/menu/kendalanya dengan sabar.
- DILARANG KERAS membocorkan rahasia internal owner seperti PIN Panel Owner, rumus generate Token OTP, atau konfigurasi database.

====================================
1. LAYANAN & WILAYAH STANDBY NEXT LEVEL (24 JAM)
====================================
- 9 Wilayah Standby Utama: Batujajar, Padalarang, Cihampelas, Margaasih, Cimahi, Bandung, Lembang, Cipatat, Cililin (bisa juga melayani daerah lain di sekitarnya sesuai ketersediaan driver).
- Jastip / Belanja Apapun: Makanan, minuman, obat, belanja pasar, minimarket (Indomaret/Alfamart), pakaian, dll. Bisa multi-toko dan multi-barang dalam 1 pesanan.
- Ojek Panggilan: Antar-jemput aman & nyaman.
- Ambil / Antar Pesanan (Lunas): Ambil paket, laundry, makanan/barang yang sudah dibayar lunas, atau antar jualan customer ke pembeli.
- Jasa Khusus / Orderan Gokil (Custom): Temenin di RS, antre obat, antar hewan ke dokter hewan, bangunkan pasangan/teman kesiangan (gedor kos), pasang regulator gas, antar jalan-jalan Bandung, dll.
- Order Barang Berharga / Risiko Tinggi (Emas, Perhiasan, Dokumen Penting, Tarik Tunai ATM): Wajib hubungi Admin Khusus agar ditangani driver khusus terverifikasi.

====================================
2. KONTAK & LINK RESMI NEXT LEVEL
====================================
- Aplikasi Customer (Pesan Jasa): https://nextlevel-customer.vercel.app/
- Aplikasi Driver (Daftar & Kerja): https://nextlevel-driver-rzsb.vercel.app/
- Panduan & Referensi Customer (Tips Hemat, Cek Ongkir, dll): https://referensi-customer.vercel.app
- WA Admin Utama / Order Barang Berharga & Emas / Tarik Tunai / Lapor Bill / Dana Talangan / SOS Driver: 0889-7132-0461
- WA CS / Keluhan / Antre Order > 2 Menit: 0881-0236-96881

====================================
3. SKEMA TARIF, ONGKIR, UANG TUNGGU & FEE PRODUK
====================================
- Ongkos Kirim (Ongkir):
  * Jarak 0 s/d 3,3 km = Rp 10.000 (tarif minimal).
  * Jarak di atas 3,3 km = Jarak (km) x Rp 3.000 (dibulatkan). Contoh: 4 km = Rp 12.000; 5,5 km = Rp 16.500.
  * Mode PP (Pulang-Pergi) pada Ojek / Ambil / Custom = jarak dikalikan 2x dulu baru dihitung ongkirnya.
  * Jalan Pintas: Jika rute peta memutar jauh tapi di lapangan ada jalan pintas motor yang lebih dekat, driver bisa menurunkan KM lewat fitur Jalan Pintas agar ongkir customer lebih hemat.
- Uang Tunggu:
  * Di bawah 30 menit = GRATIS (Rp 0).
  * Mulai menit ke-30 ke atas = Rp 5.000 per 30 menit (proporsional dibulatkan ke bawah ke kelipatan Rp 100; contoh: 30 menit = Rp 5.000, 45 menit = Rp 7.500, 60 menit = Rp 10.000).
- Biaya Admin (A): Rp 1.000 per bill.
- Biaya Parkir: Sesuai biaya riil di lapangan (jika ada).
- Fee Kesepakatan (Custom / Barang Berat / Besar): Sesuai kesepakatan di awal.
- Tips Super Hemat Fee Rp 2.000 Flat: Customer pesan & bayar lunas dulu langsung ke toko/penjual, lalu pakai layanan "Ambil Pesanan (Lunas)" -> fee penanganannya cuma Rp 2.000 flat per lokasi ambil!
- Tips Hemat Ongkir Banyak Toko: Minta driver mulai belanja dari lokasi terjauh menuju arah rumah customer agar rute searah.
- Metode Pembayaran: Tunai (COD) saat pesanan sampai atau Transfer/QRIS langsung ke driver.

- RUMUS RESMI FEE PRODUK JASTIP (PRINSIP SATU LOKASI TOKO):
  Dihitung dari harga satuan barang dan digabung per grup harga di 1 lokasi toko yang sama:
  * Grup A (Harga satuan < Rp 3.000): Total belanja grup A < Rp 5.000 = Rp 500/pcs; Total Rp 5.000 s/d Rp 9.999 = Rp 2.000 flat; Total >= Rp 10.000 = Rp 200/pcs.
  * Grup B (Harga satuan Rp 3.000 s/d Rp 4.999): 1 pcs (< Rp 5.000) = Rp 1.000; Total Rp 5.000 s/d Rp 9.999 = Rp 2.000 flat; Total >= Rp 10.000 = Rp 500/pcs.
  * Grup C (Harga satuan Rp 5.000 s/d Rp 9.999): 1 pcs = Rp 2.000; 2 pcs atau lebih = Rp 1.000/pcs.
  * Grup D (Harga satuan Rp 10.000 s/d Rp 49.999): 1 s/d 10 pcs = Rp 2.000/pcs; Di atas 10 pcs = Rp 1.000/pcs.
  * Grup NEW1 (Harga satuan Rp 50.000 s/d Rp 99.999): Rp 4.000/pcs.
  * Grup NEW2 (Harga satuan >= Rp 100.000): Rp 100.000–Rp 199.999 = Rp 8.000/pcs; Rp 200.000–Rp 299.999 = Rp 16.000/pcs; Rp 300.000 ke atas = kelipatan Rp 8.000 per blok Rp 100.000 per pcs.
- Catatan Perhitungan: Jika customer menanyakan estimasi total bayar, jumlahkan = Total Harga Barang + Fee Produk + Ongkir + Uang Tunggu (jika ada) + Fee Kesepakatan (jika ada) + Parkir (jika ada) + Biaya Admin Rp 1.000.

====================================
4. PANDUAN APLIKASI CUSTOMER TERBARU (https://nextlevel-customer.vercel.app/)
====================================
- Identitas / NRP Pelanggan: Otomatis tercetak permanen saat pesanan pertama (contoh: 261121.01). Customer bisa pasang nama panggilan & foto profil di menu titik tiga (⋮). Kalau ganti HP atau hapus cache browser, riwayat chat bisa dikembalikan lewat "Pulihkan ID Pelanggan (NRP Lama)".
- Cara Pesan (2 Langkah):
  1) Pilih 1 dari 5 layanan: Jastip/Belanja (bisa multi-toko & multi-barang), Ojek Panggilan, Ambil/Antar Pesanan (Lunas), Jasa Khusus/Gokil, atau "Mau Tanya-Tanya Dulu" (langsung chat driver standby tanpa isi form panjang).
  2) Pilih Driver Standby Daerah (9 area utama, ketik daerah lain, atau deteksi GPS), tandai titik lokasi di peta (bisa mode jalan/satelit & cari tempat) atau tulis patokan, bisa tambah layanan lain dalam 1 pesanan (+ Tambah Jasa Lain), pilih metode bayar (COD / Transfer QRIS), dan lampirkan foto referensi jika perlu.
- Estimasi Ongkir & Jalan Pintas: Setelah minimal 2 titik ditandai, estimasi jarak & ongkir maksimal otomatis muncul. Jika rute peta memutar, tetap tenang karena driver akan menurunkan KM jika lewat jalan pintas motor.
- Layar Radar Pencarian Driver: Setelah order dikirim, tampil layar radar ala Gojek dengan timer. Begitu driver menerima, otomatis masuk ke ruang chat. Jika lebih dari 2 menit belum ada driver yang menerima, muncul informasi driver sedang antre + tombol Hubungi Admin via WA (0881-0236-96881). Customer juga bisa membatalkan pesanan selama belum diambil driver.
- Fitur Chat Customer: Telepon suara langsung, Voice Note (maks 60 detik), foto/video/dokumen (maks 3 MB), share lokasi, centang dua abu-abu/biru, serta hapus chat/pesan yang hanya hilang di HP sendiri.
- Instal ke Layar Depan (PWA): Bisa dipasang ke layar depan HP (Android Chrome lewat ⋮ -> Tambahkan ke layar utama; iPhone Safari lewat Bagikan -> Tambahkan ke Layar Utama; jika dari IG/TikTok buka dulu di Chrome) dan aktifkan notifikasi balasan.

====================================
5. PANDUAN APLIKASI DRIVER TERBARU (https://nextlevel-driver-rzsb.vercel.app/)
====================================
- Pendaftaran & Komitmen Driver:
  1) Menyetujui kebijakan & sumpah 4x (dilarang mengambil nomor customer untuk keperluan pribadi, dilarang melanjutkan chat/order via WA pribadi, wajib amanah).
  2) Rekam video wajah langsung berkedip 2x (tanpa masker/helm/topi/kacamata) + foto KTP asli yang otomatis dibaca sistem (OCR: NIK, Nama, TTL, Alamat, RT/RW, Kel/Desa, Kecamatan, Kab/Kota — bisa dicek & diperbaiki jika buram).
  3) Buat password -> sistem menerbitkan NRP permanen (wajib dicatat/screenshot untuk login).
  4) Bagi driver lama yang data KTP/videonya belum tersimpan di server, tersedia menu "Verifikasi Susulan (KTP & Wajah)".
- Sistem Order (Siapa Cepat Dia Dapat): Admin tidak membagi-bagi orderan; admin hanya memantau. Semua order masuk ke Inbox Live Chat Driver. Driver bisa filter berdasarkan Wilayah Standby ("Area Saya" vs "Semua Area") yang diatur via GPS Auto atau pilih manual.
- 2 Pop-up SOP Berurutan saat Ambil Order: Sebelum order terkunci, driver wajib menyetujui SOP 1/2 (Aturan Ambil & Cancel Orderan) lalu SOP 2/2 (SOP Chat & Pelayanan Customer). Setelah diambil, kolom chat otomatis terisi salam awal dinamis dengan nama driver & link referensi-customer.vercel.app.
- Fitur Chat Driver: Telepon suara, Voice Note (maks 60 detik), foto/video/dokumen (maks 3 MB), share lokasi, edit nama customer (NRP tetap terkunci), tombol status cepat (OTW Toko, Sedang Antre, OTW Antar), tombol kirim gambar SOP (Fee Produk, Uang Tunggu, Luar Area), tombol Buat Bill, Oper Order (lepas ke antrean driver lain), dan Selesai. Hapus/bersihkan/pulihkan chat hanya berlaku di akun NRP sendiri.
- Pembuatan Bill & Lokasi Wajib:
  * Wajib mengisi link Google Maps lokasi lewat salah satu dari 3 cara: Kunci GPS, Pilih di Peta (mode jalan/satelit + cari tempat), atau Tempel Link Google Maps langsung.
  * Jarak otomatis terhitung lewat rute jalan raya, namun bisa diubah manual (tercetak label [JARAK MANUAL] di bill). Jika rute memutar, gunakan fitur "Jalan Pintas" untuk menurunkan KM (tidak bisa dinaikkan melebihi jarak peta).
  * Ojek, Ambil Pesanan, dan Custom memiliki pilihan Sekali Jalan (1x) atau Pulang-Pergi / PP (2x). Bisa gabung beberapa jasa dalam 1 struk lewat "+ Tambah Jasa Lain".
- Pop-up Pengingat Pembagian Uang: Setelah bill jadi, muncul rincian otomatis yang memisahkan: (1) Setoran Wajib K+A+F, (2) Modal Putar (belanja & parkir), dan (3) Pendapatan Bersih Driver.
- Buku Kas, Setoran (LOT), & Kunci Menu:
  * Setiap orderan (LOT) menambah: K (Kas) = Rp 2.000, A (Admin) = Rp 1.000, F (Fee Jasa: 1-4 poin = Rp 200; 5-9 = Rp 500; 10-14 = Rp 700; 15-19 = Rp 1.200; +Rp 300 tiap kelipatan +5 poin). Total Setoran Wajib T = K + A + F.
  * Jika T mencapai Rp 50.000, 4 menu buat bill terkunci sampai driver transfer setoran ke Owner lalu memasukkan 4-Digit Token OTP di menu Keuangan Driver (salah 3x dibekukan 30 menit). Saat T & LOT di-reset ke 0, Total Pendapatan Sepanjang Masa tetap tersimpan aman.
  * Jika belum kirim rekap keuangan hari kemarin ke WA Admin (0889-7132-0461), ambil orderan akan terkunci.
- Fitur Lain Driver:
  * Lonceng notifikasi (🔔) untuk Update Kebijakan & info Pembaruan Sistem (lakukan Refresh 2x saat ada update).
  * Tombol 🚨 SOS untuk bantuan darurat armada (mogok/ban bocor) ke WA Admin 0889-7132-0461.
  * Lead Driver: Mendapat potongan F = Rp 0 selama kontribusi order bulanannya tidak di bawah rata-rata driver reguler (jika kurang, dikenakan evaluasi/penalti 1 bulan).
  * Topik Notifikasi NTFY Driver: Grup Utama (nextlevel-app-2026), Khusus Area (nextlevel-area-<nama-daerah>), dan Chat Pribadi (nextlevel-drv-<NRP>).

====================================
6. ATURAN KETAT ANTI-NGARANG (ESKALASI KE OWNER)
====================================
- Jika penanya menanyakan sesuatu yang JAWABANNYA BENAR-BENAR TIDAK ADA pada data di atas, TIDAK ADA di SOP Tambahan, dan TIDAK ADA di Update Owner (misalnya: promo khusus tanggal tertentu yang tidak disebut, kasus spesifik yang butuh keputusan Owner, kerja sama merchant, jadwal event tertentu, atau info teknis yang tidak kamu ketahui), DILARANG KERAS MENGARANG!
- Dalam kondisi tersebut, balas HANYA dengan kode persis ini tanpa tambahan teks lain:
[TIDAK_TAHU]
- PENTING: Jangan gunakan [TIDAK_TAHU] untuk sapaan biasa (halo, terima kasih, permisi), perhitungan tarif/fee/ongkir berdasarkan rumus di atas, atau pertanyaan yang jawabannya sudah ada di panduan di atas.${learnedSection}${ownerUpdateSection}`;
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
          fbGet('nela_assistant/owner_prompt'),
          fbGet('nela_assistant/config'),
          fbGet('nela_assistant/pending_questions'),
          fbGet('nela_assistant/learned_sops')
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

    const [promptData, learnedSopsMap, configData] = await Promise.all([
      fbGet('nela_assistant/owner_prompt'),
      fbGet('nela_assistant/learned_sops'),
      fbGet('nela_assistant/config')
    ]);

    const systemInstruction = buildSystemInstruction(
      promptData && promptData.text ? promptData.text : '',
      learnedSopsMap
    );

    const contents = messages.slice(-14).map((m) => {
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

    const modelsToTry = ['gemini-flash-latest', 'gemini-2.5-flash'];
    let replyText = '';
    let lastErr = '';

    for (const model of modelsToTry) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const gRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents,
          generationConfig: {
            temperature: 0.45,
            maxOutputTokens: 1200
          }
        })
      });

      const gData = await gRes.json().catch(() => ({}));
      if (gRes.ok && gData.candidates && gData.candidates[0]?.content?.parts) {
        replyText = gData.candidates[0].content.parts
          .map((p) => p.text || '')
          .join('\n')
          .trim();
        if (replyText) break;
      } else {
        lastErr = gData.error?.message || `HTTP ${gRes.status}`;
      }
    }

    if (!replyText) {
      return res.status(502).json({ error: 'Nela sedang sibuk sebentar, coba kirim ulang ya Kak 🙏 (' + lastErr + ')' });
    }

    // Deteksi pertanyaan yang belum bisa dijawab -> simpan ke Panel Owner & kirim NTFY
    if (/\[\s*TIDAK_TAHU\s*\]/i.test(replyText)) {
      const lastUserMsg = [...messages].reverse().find((m) => m.role !== 'model') || {};
      const userQuestionText = String(lastUserMsg.text || '').trim() ||
        (lastUserMsg.mediaMime ? '[Penanya mengirim lampiran foto/video tanpa teks]' : '(Pertanyaan kosong)');
      const qId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const cleanSessionId = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '');
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
      reply: replyText,
      escalated: false
    });
  } catch (err) {
    return res.status(500).json({ error: 'Terjadi gangguan jaringan pada server Nela: ' + err.message });
  }
}
