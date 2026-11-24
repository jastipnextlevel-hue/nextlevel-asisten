export const maxDuration = 60;

const FIREBASE_DB_URL = 'https://nextlevel-chat-default-rtdb.asia-southeast1.firebasedatabase.app';
const NELA_APP_URL = 'https://nextlevel-asisten.vercel.app/';
const DEFAULT_NTFY_TOPIC = 'nextlevel-nela-owner';
const SIGNAL_SERVER_ERROR =
  'Maaf Kak, sepertinya sinyal sedang kurang bagus atau server agak padat 🙏 Nela susah menjawab dengan maksimal kalau sinyalnya lemah. Pastikan sinyal Kakak kuat, lalu ketuk *Coba Kirim Ulang* atau ketuk titik tiga *(⋮)* di pojok kanan atas → pilih *🔄 Refresh / Segarkan Halaman* ya Kak 😊';

let cachedOwnerData = { promptText: '', learnedSops: null, fetchedAt: 0 };
let cachedDiscoveredModels = { list: [], fetchedAt: 0 };
let lastTextModel = '';
let lastVisionModel = '';
const CACHE_TTL_MS = 30000;

function cleanReplyText(text) {
  let out = String(text || '');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const cleanLabel = label.trim().replace(/\/+$/, '');
    const cleanUrl = url.trim();
    if (cleanLabel === cleanUrl.replace(/\/+$/, '')) {
      return cleanUrl;
    }
    return `${label.trim()}: ${cleanUrl}`;
  });
  out = out.replace(/\((https?:\/\/[^\s)]+)\)/g, '$1');
  out = out.replace(/(https?:\/\/[^\s<>"')]+?)([.,;:!?]+)(?=\s|$)/g, '$1');
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
      learnedSection = '\n\n9. SOP TAMBAHAN DARI OWNER (WAJIB DIIKUTI):\n' +
        items.map((it, idx) => `${idx + 1}. Tanya: "${it.question}" -> Jawab: ${it.answer}`).join('\n');
    }
  }

  let ownerUpdateSection = '';
  if (ownerPromptText && String(ownerPromptText).trim()) {
    ownerUpdateSection = `\n\n10. UPDATE ATURAN & PROMO TERBARU DARI OWNER (PRIORITAS TERTINGGI!):\nJika ada informasi di bawah ini yang berbeda dari aturan lama, WAJIB ikuti aturan terbaru ini:\n${String(ownerPromptText).trim()}`;
  }

  return `Kamu adalah "Nela (Next Level Asisten)", asisten virtual resmi NEXT LEVEL (Jastip, Ojek Panggilan, Ambil Pesanan, Jasa Khusus 24 Jam) untuk customer, driver, dan admin.

GAYA JAWAB WAJIB (TERPERINCI, KONKRET, TERSTRUKTUR, SOPAN & PROAKTIF):
- Jawab dengan JELAS, RINCI, dan langsung bisa dipraktikkan memakai penomoran rapi (1, 2, 3) dan sub-poin yang enak dibaca di layar HP. Jangan pakai garis pemisah "---".
- Gunakan bahasa Indonesia yang santai, ramah, sopan, dan hangat. Sisipkan emoji 😊 dan 🙏 secara natural di setiap balasan.
- ATURAN LINK WAJIB: Tulis link mentah biasa saja (contoh: https://nextlevel-driver.vercel.app/). DILARANG KERAS memakai format Markdown [teks](link) dan DILARANG mengurung link dengan (...) atau menempelkan titik/koma di ujung link.
- ATURAN SINYAL & REFRESH NELA: Jika penanya mengeluh jawaban Nela lambat, terputus, gagal baca gambar, atau kurang maksimal, arahkan dengan ramah untuk memastikan sinyal internet HP kuat (cek lampu indikator di bagian atas: Hijau = sinyal kuat, Oranye = sinyal sedang, Merah = sinyal jelek), lalu sarankan ketuk ikon titik tiga (⋮) di pojok kanan atas -> pilih "Refresh / Segarkan Halaman" agar jawaban Nela kembali akurat dan maksimal.
- ATURAN WAJIB AUDIT SCREENSHOT / FOTO / VIDEO (SUPER TELITI):
  Saat penanya mengirim screenshot aplikasi (Customer, Driver, maupun Admin):
  1) Identifikasi nama halaman/form yang terbuka dan beri apresiasi singkat bagian mana yang SUDAH BENAR diisi agar penanya tenang.
  2) Baca dan SEBUTKAN PERSIS isi teks/angka/koordinat GPS yang terlihat di setiap kolom pada screenshot dari atas ke bawah!
     * Jika koordinat GPS sudah centang hijau, pastikan sudah benar & jangan diubah lagi.
     * Jika ada kolom yang masih tulisan bawaan (misalnya "Warung 1") atau terisi huruf acak/typo, TUNJUK LANGSUNG kolom tersebut, jelaskan kenapa harus diganti, lalu berikan CONTOH PENULISAN NYATA.
  3) Jelaskan juga kolom lanjutan yang berada di bawah layar hingga langkah cek ulang sebelum klik Kirim / Buat Bill.
  4) Jika di bagian atas screenshot ada spanduk peringatan merah (seperti "AMBIL ORDERAN TERKUNCI!!" atau "Sinyal terputus"), BAHAS DI BAGIAN AKHIR dengan format kutipan (diawali tanda "> ") dan langkah klik yang presisi.
  5) Tutup dengan tawaran bantuan aktif.
- Jika customer bertanya soal harga beli/jastip makanan atau barang TANPA menyebutkan harga pasti atau jaraknya, JANGAN bilang tidak tahu! Jelaskan komponen biayanya, perkiraan grup harga & fee produknya, berikan 2-3 contoh hitungan lengkap (harga barang + fee + ongkir + admin Rp 1.000), lalu tanyakan harga pasti, jumlah pcs, dan jaraknya.
- DILARANG menyebut fitur "kalkulator" atau menyuruh customer menghitung sendiri. Hitungkan langsung dengan akurat.
- DILARANG membocorkan rahasia internal owner/admin (PIN login admin, password panel owner, rumus token OTP, database).

1. LAYANAN & WILAYAH STANDBY (24 JAM):
- 9 Wilayah Utama: Batujajar, Padalarang, Cihampelas, Margaasih, Cimahi, Bandung, Lembang, Cipatat, Cililin (+ area sekitarnya sesuai driver).
- Layanan: Jastip/Belanja (bisa multi-toko & multi-barang), Ojek Panggilan, Ambil/Antar Pesanan Lunas, Jasa Khusus/Custom (temenin RS, antre obat, antar hewan, bangunin kos, pasang gas, dll).
- Barang Berharga / Risiko Tinggi (Emas, Perhiasan, Dokumen Penting, Tarik Tunai ATM): Wajib lewat WA Admin Khusus (0889-7132-0461).

2. KONTAK & LINK RESMI:
- Aplikasi Customer: https://nextlevel-customer.vercel.app/
- Aplikasi Driver: https://nextlevel-driver.vercel.app/
- Panduan Customer: https://referensi-customer.vercel.app
- WA Admin Utama / Barang Berharga / Emas / Tarik Tunai / Lapor Bill & Keuangan / SOS Driver: 0889-7132-0461
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

4. PANDUAN RINCI APLIKASI CUSTOMER (https://nextlevel-customer.vercel.app/):
- Halaman Pembuka: Isi Nama Panggilan (opsional) lalu ketuk tombol kuning "PESAN SEKARANG (Pilih Layanan)". ID Pelanggan (NRP) tercetak otomatis saat pesan pertama. Jika ganti HP, ketuk "Pulihkan di sini" untuk memasukkan NRP lama agar riwayat chat kembali.
- Beranda Ala WhatsApp: Menampilkan riwayat chat/pesanan, tombol "+ Pesan Baru", kolom pencarian, tombol Refresh (🔄), dan menu titik tiga (⋮) untuk Edit Profil/NRP, Order Barang Berharga, Bersihkan Riwayat Selesai, Aktifkan Notifikasi, dan Pasang ke Layar Depan HP (PWA).
- 5 Menu Layanan + Barang Berharga:
  1) Jastip / Belanja Apapun: Bisa pesan dari banyak toko sekaligus (+ Tambah Lokasi), tambah barang (+ Tambah Barang), perkiraan harga (opsional).
  2) Ojek Panggilan: Tandai Titik Penjemputan & Titik Tujuan via GPS/Peta + catatan opsional.
  3) Ambil / Antar Pesanan (Lunas): Isi lokasi pengambilan, nama toko/pengirim, keterangan barang/atas nama, dan lokasi antar.
  4) Jasa Khusus / Orderan Gokil: Tulis deskripsi tugas/request, titik awal & tujuan opsional.
  5) Mau Tanya-Tanya Dulu: Pilih area driver standby & tulis pertanyaan awal (opsional) -> langsung terhubung ke driver tanpa isi form panjang.
  6) Barang Berharga / Tarik Tunai: Langsung ke WA Admin Khusus (0889-7132-0461).
- Alur Isi Form: Pilih "Driver Standby Daerah" terdekat (atau klik "Cari Driver Terdekat dari Lokasi Saya (GPS)") -> Tandai lokasi lewat "Pakai GPS Saya" atau "Pilih di Peta" (ada pencarian alamat 🔍 & mode satelit 🛰️) -> Bisa gabung layanan dalam 1 pesanan lewat "+ Tambah Jasa Lain" -> Estimasi jarak & ongkir muncul otomatis (plus info bisa lebih hemat jika lewat jalan pintas motor) -> Pilih pembayaran Tunai (COD) atau Transfer/QRIS -> Lampirkan Foto Referensi (opsional) -> "KIRIM PESANAN KE DRIVER" -> Cek Ringkasan -> "CARI & HUBUNGI DRIVER SEKARANG".
- Layar Radar & Ruang Chat: Setelah kirim, muncul Radar Pencarian Driver. Jika > 2 menit belum diambil, muncul tombol "HUBUNGI ADMIN VIA WHATSAPP (0881-0236-96881)". Pesanan bisa dibatalkan selama belum diambil driver. Di ruang chat bisa kirim foto, video (maks 3 MB), dokumen, shareloc, voice note (maks 60 dtk), dan Telepon Suara (📞) langsung.

5. PANDUAN RINCI APLIKASI DRIVER (https://nextlevel-driver.vercel.app/):
- Daftar: Setujui sumpah 4x -> rekam wajah berkedip 2x + foto KTP asli (OCR) -> buat password -> dapat NRP permanen.
- Sistem Order: Siapa cepat dia dapat (admin hanya memantau, tidak membagi order). Filter "Area Saya" / "Semua Area". Wajib setujui 2 pop-up SOP saat ambil order.
- CARA MENGISI FORM JASTIP / BUAT BILL:
  1) Update Status Cepat ke Konsumen (opsional): OTW Toko, Sedang Antre, atau OTW Antar.
  2) 1. Titik Lokasi Customer (Tujuan Antar) — WAJIB: Kunci GPS Saya, Pilih di Peta, atau tempel link Google Maps customer.
  3) Lokasi 1 — Nama Warung / Toko & GPS Toko: Ganti tulisan default "Warung 1" dengan nama warung aslinya + kunci GPS/Maps toko.
  4) Nama / Deskripsi Produk, Harga Satuan (tanpa titik/Rp) & Jumlah (Qty): 1 item per baris. Tambah item via "+ Tambah Produk", tambah warung via "+ Tambah Lokasi" / "+ Tambah Jasa Lain".
  5) Cek Ulang, Jalan Pintas & Biaya Tambahan -> klik Buat Bill / Kirim -> muncul pop-up pembagian uang (Setoran Wajib K+A+F, Modal Putar, Pendapatan Bersih).
- CARA MEMBUKA "AMBIL ORDERAN TERKUNCI!!":
  1) Klik "KEMBALI" -> buka menu "Keuangan Driver" -> klik "Kirim Laporan Admin" -> otomatis arahkan ke WA Admin Utama (0889-7132-0461) -> klik KIRIM -> kunci Ambil Orderan otomatis terbuka.
- BUKU KAS, SETORAN (LOT) & KUNCI BUAT BILL:
  * K = Rp 2.000, A = Rp 1.000, F (Fee Jasa: 1-4 poin = Rp 200; 5-9 = Rp 500; 10-14 = Rp 700; 15-19 = Rp 1.200; +Rp 300 tiap +5 poin). Total Setoran Wajib T = K + A + F.
  * Jika T mencapai Rp 50.000, 4 menu BUAT BILL terkunci sampai transfer setoran ke Owner lalu masukkan 4-Digit Token OTP di menu Keuangan Driver (salah 3x dibekukan 30 menit).
  * Tersedia juga Oper Order dan tombol 🚨 SOS ke WA Admin 0889-7132-0461.
- Topik NTFY Driver: nextlevel-app-2026 (Utama), nextlevel-area-<daerah>, nextlevel-drv-<NRP>.

6. PANDUAN RINCI APLIKASI ADMIN (KHUSUS ADMIN):
- Login memakai PIN Admin (JANGAN pernah sebutkan angka PIN-nya).
- Tab 1 — Kas & Setoran:
  * Uang di Kantong Admin Sekarang: Menampilkan uang fisik real-time, ada tombol "Laporan WA" ke Owner dan "Edit Saldo Awal" (untuk menyamakan saldo fisik K, A, F, dan Modal).
  * 3 Dompet Terpisah: Kas Perusahaan (K = Rp2.000/LOT), Hak Admin (A = Rp1.000/LOT), dan Fee (F). Masing-masing ada tombol "Tarik" yang otomatis mengurangi dompet & uang di kantong.
  * Belum Disetor vs Sudah Disetor: Kotak K, A, F, T bisa diketuk (drill-down) untuk melihat rincian per driver. Di Daftar Tagihan Driver tersedia tombol "Terima Setoran" (otomatis reset LOT & T driver ke 0, bisa sekaligus salin Token 4-Digit), "Tagih WA", dan "Cek".
  * Suntikan Modal / Pengeluaran & Buku Besar: Catat modal masuk, pengeluaran operasional, dan pantau riwayat mutasi permanen.
- Tab 2 — Pinjaman Driver: Terbagi 2 sub-tab (Pinjaman Modal/Kas & Pinjaman Sehari-hari). Bisa catat pinjaman baru, pantau yang belum lunas (tanda merah jika >= 7 hari), dan catat cicilan atau "Lunasi Penuh Sekarang".
- Tab 3 — Data Driver: Terbagi Driver Aktif & Arsip/Percobaan. Bisa Terima Setor, Cek Akun (NRP, password, rekening, Token 4-Digit), lihat Riwayat Bill & Struk Nota, lihat Berkas KTP, Arsipkan, atau Hapus Permanen (khusus arsip).
- Tab 4 — Grafik & Rekap: Cek Rekap Order Per Tanggal (Hari Ini/Kemarin/Manual) serta Grafik & Rekap Bulanan (driver paling aktif, grafik batang, persentase kontribusi).
- Tab 5 — Token 4-Digit: Pilih driver agar LOT & Tanggal (DDMMYY) terisi otomatis -> "Keluarkan Token 4-Digit" -> Salin untuk reset LOT manual di HP driver.
- Tab 6 — Order: Pantau antrean order & live chat secara real-time, serta bisa ikut membalas sebagai Admin jika diperlukan (Admin hanya memantau, tidak membagi-bagi orderan).

7. ATURAN ANTI-NGARANG (ESKALASI OWNER):
- HANYA jika pertanyaan benar-benar di luar semua data di atas dan butuh keputusan khusus Owner (promo tanggal tertentu, kerja sama merchant, kasus khusus), balas HANYA dengan kode persis:
[TIDAK_TAHU]
- JANGAN pernah balas [TIDAK_TAHU] untuk pertanyaan tarif/estimasi belanja, panduan aplikasi customer/driver/admin, sapaan, atau info yang sudah ada di atas.${learnedSection}${ownerUpdateSection}`;
}

async function discoverFlashModels(apiKey, preferFullFlash = false) {
  const now = Date.now();
  let list = [];
  if (cachedDiscoveredModels.list.length > 0 && (now - cachedDiscoveredModels.fetchedAt) < 1800000) {
    list = [...cachedDiscoveredModels.list];
  } else {
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

      list = models
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

      cachedDiscoveredModels = { list, fetchedAt: Date.now() };
    } catch (e) {
      clearTimeout(timer);
      return [];
    }
  }

  return [...list].sort((a, b) => {
    const aLite = /lite/i.test(a) ? 1 : 0;
    const bLite = /lite/i.test(b) ? 1 : 0;
    if (aLite !== bLite) {
      return preferFullFlash ? aLite - bLite : bLite - aLite;
    }
    return b.localeCompare(a, undefined, { numeric: true });
  });
}

async function openGeminiStream(apiKey, model, systemInstruction, contents, useThinkingZero = false, connectTimeoutMs = 15000) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connectTimeoutMs);

  const generationConfig = {
    temperature: 0.4,
    maxOutputTokens: 2048
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

    if (!gRes.ok || !gRes.body) {
      const errData = await gRes.json().catch(() => ({}));
      return {
        ok: false,
        status: gRes.status,
        error: errData.error?.message || `HTTP ${gRes.status}`
      };
    }

    return { ok: true, response: gRes };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      status: 0,
      error: err.name === 'AbortError' ? 'Timeout koneksi' : err.message
    };
  }
}

async function tryOpenStream(apiKey, model, systemInstruction, contents, connectTimeoutMs = 15000) {
  const isLite = /lite/i.test(model);
  if (isLite) {
    return await openGeminiStream(apiKey, model, systemInstruction, contents, false, connectTimeoutMs);
  }
  let resObj = await openGeminiStream(apiKey, model, systemInstruction, contents, true, connectTimeoutMs);
  if (!resObj.ok && resObj.status === 400) {
    resObj = await openGeminiStream(apiKey, model, systemInstruction, contents, false, connectTimeoutMs);
  }
  return resObj;
}

async function handleEscalation(messages, sessionId) {
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

  return { fallbackReply, qId };
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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY belum dipasang di Vercel.' });
  }

  try {
    const { messages, sessionId, stream: wantStream } = body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Format pesan tidak valid.' });
    }

    const { promptText, learnedSops } = await getOwnerDataCached();
    const systemInstruction = buildSystemInstruction(promptText, learnedSops);

    const recentMessages = messages.slice(-6);
    const lastIdx = recentMessages.length - 1;
    const lastMsg = recentMessages[lastIdx] || {};
    const hasMediaInLastMsg = !!(lastMsg.mediaData && lastMsg.mediaMime);

    const contents = recentMessages.map((m, idx) => {
      const parts = [];
      if (m.text) parts.push({ text: String(m.text) });
      if (idx === lastIdx && m.mediaData && m.mediaMime) {
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

    const defaultOrder = hasMediaInLastMsg
      ? ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite']
      : ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];

    const primaryModels = [];
    const remembered = hasMediaInLastMsg ? lastVisionModel : lastTextModel;
    if (remembered) primaryModels.push(remembered);
    for (const m of defaultOrder) {
      if (!primaryModels.includes(m)) primaryModels.push(m);
    }

    const tried = new Set();
    let streamRes = null;
    let activeModel = '';

    for (let i = 0; i < primaryModels.length; i++) {
      const model = primaryModels[i];
      tried.add(model);
      const timeoutMs = hasMediaInLastMsg ? (i === 0 ? 18000 : 14000) : (i === 0 ? 12000 : 10000);
      const attempt = await tryOpenStream(apiKey, model, systemInstruction, contents, timeoutMs);
      if (attempt.ok) {
        streamRes = attempt.response;
        activeModel = model;
        break;
      }
      if (hasMediaInLastMsg && model === lastVisionModel) lastVisionModel = '';
      if (!hasMediaInLastMsg && model === lastTextModel) lastTextModel = '';
    }

    if (!streamRes) {
      const discovered = await discoverFlashModels(apiKey, hasMediaInLastMsg);
      let extraTries = 0;
      for (const model of discovered) {
        if (tried.has(model) || extraTries >= 2) continue;
        tried.add(model);
        extraTries++;
        const attempt = await tryOpenStream(apiKey, model, systemInstruction, contents, 12000);
        if (attempt.ok) {
          streamRes = attempt.response;
          activeModel = model;
          break;
        }
      }
    }

    if (!streamRes) {
      return res.status(502).json({ error: SIGNAL_SERVER_ERROR });
    }

    if (hasMediaInLastMsg) lastVisionModel = activeModel;
    else lastTextModel = activeModel;

    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let sseBuf = '';
    let fullText = '';
    let pendingBuffer = '';
    let streamStarted = false;

    const startClientSse = () => {
      if (streamStarted) return;
      streamStarted = true;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
      const lines = sseBuf.split('\n');
      sseBuf = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        let parsed;
        try { parsed = JSON.parse(jsonStr); } catch (e) { continue; }
        const parts = parsed?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) continue;

        const piece = parts
          .filter((p) => !p.thought && p.text)
          .map((p) => p.text)
          .join('');
        if (!piece) continue;

        fullText += piece;

        if (wantStream) {
          if (!streamStarted) {
            pendingBuffer += piece;
            const trimmed = pendingBuffer.trimStart();
            const mightBeUnknownTag = trimmed.length === 0 || (trimmed.startsWith('[') && trimmed.length < 18);
            if (!mightBeUnknownTag) {
              startClientSse();
              res.write(`data: ${JSON.stringify({ delta: pendingBuffer })}\n\n`);
              pendingBuffer = '';
            }
          } else {
            res.write(`data: ${JSON.stringify({ delta: piece })}\n\n`);
          }
        }
      }
    }

    if (!fullText.trim()) {
      if (streamStarted) {
        res.write(`data: ${JSON.stringify({ error: SIGNAL_SERVER_ERROR })}\n\n`);
        return res.end();
      }
      return res.status(502).json({ error: SIGNAL_SERVER_ERROR });
    }

    if (/\[\s*TIDAK_TAHU\s*\]/i.test(fullText)) {
      const { fallbackReply, qId } = await handleEscalation(messages, sessionId);
      if (streamStarted) {
        res.write(`data: ${JSON.stringify({ done: true, reply: fallbackReply, escalated: true, questionId: qId })}\n\n`);
        return res.end();
      }
      return res.status(200).json({
        reply: fallbackReply,
        escalated: true,
        questionId: qId
      });
    }

    const finalClean = cleanReplyText(fullText);

    if (wantStream && streamStarted) {
      res.write(`data: ${JSON.stringify({ done: true, reply: finalClean, escalated: false })}\n\n`);
      return res.end();
    }

    return res.status(200).json({
      reply: finalClean,
      escalated: false
    });
  } catch (err) {
    if (res.headersSent) {
      try {
        res.write(`data: ${JSON.stringify({ error: SIGNAL_SERVER_ERROR })}\n\n`);
        res.end();
      } catch (e) {}
      return;
    }
    return res.status(500).json({ error: SIGNAL_SERVER_ERROR });
  }
}