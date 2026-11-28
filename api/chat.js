export const maxDuration = 60;

const FIREBASE_DB_URL = 'https://nextlevel-chat-default-rtdb.asia-southeast1.firebasedatabase.app';
const NELA_APP_URL = 'https://nextlevel-asisten.vercel.app/';
const DEFAULT_NTFY_TOPIC = 'nextlevel-nela-owner';

let cachedOwnerData = { promptText: '', learnedSops: null, liveDriversSummary: '', fetchedAt: 0 };
const GHOST_DRIVER_TIMEOUT_MS = 8 * 60 * 60 * 1000;

function summarizeLiveDrivers(standbyMap) {
  if (!standbyMap || typeof standbyMap !== 'object') return 'Belum ada driver yang menyalakan status Online saat ini.';
  const now = Date.now();
  const active = Object.values(standbyMap).filter((d) => {
    if (!d || d.isOnline !== true) return false;
    const lastTs = parseInt(d.lastActiveAt || d.updatedAt || 0, 10);
    if (lastTs > 0 && (now - lastTs) > GHOST_DRIVER_TIMEOUT_MS) return false;
    return true;
  });
  if (active.length === 0) return 'Saat ini belum ada driver yang sedang menyalakan status Online di aplikasi.';
  const freeCnt = active.filter((d) => d.availabilityStatus !== 'busy').length;
  const busyCnt = active.length - freeCnt;
  const areaCount = {};
  active.forEach((d) => {
    const locs = d.locations ? Object.values(d.locations) : [];
    const seenKec = new Set();
    locs.forEach((l) => {
      const kec = String((l && l.kecamatan) || '').trim();
      if (kec && !seenKec.has(kec.toLowerCase())) {
        seenKec.add(kec.toLowerCase());
        if (!areaCount[kec]) areaCount[kec] = { free: 0, busy: 0 };
        if (d.availabilityStatus !== 'busy') areaCount[kec].free++;
        else areaCount[kec].busy++;
      }
    });
  });
  const areaLines = Object.keys(areaCount).map((k) => {
    const c = areaCount[k];
    return `${k} (${c.free} Free, ${c.busy} Sedang Handle)`;
  });
  return `Total ${active.length} driver sedang Online sekarang (${freeCnt} Free, ${busyCnt} Sedang Handle). Sebaran wilayah standby: ${areaLines.length > 0 ? areaLines.join('; ') : 'aktif di area NEXT LEVEL'}.`;
}
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
  // REVISI #15: Selalu tarik segar owner_prompt & learned_sops langsung dari Firebase di setiap pertanyaan (tanpa cache basi)
  const [promptData, learnedSopsMap, standbyMap] = await Promise.all([
    fbGet('nela_assistant/owner_prompt', 2500),
    fbGet('nela_assistant/learned_sops', 2500),
    fbGet('driver_standby_locations', 1800)
  ]);
  cachedOwnerData = {
    promptText: (promptData && promptData.text) ? promptData.text : '',
    learnedSops: learnedSopsMap || null,
    liveDriversSummary: summarizeLiveDrivers(standbyMap),
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

function buildSystemInstruction(ownerPromptText, learnedSopsMap, liveDriversSummary = '', appContext = 'general') {
  let priorityOverrideBlock = '';
  const hasOwnerPrompt = !!(ownerPromptText && String(ownerPromptText).trim());
  const learnedItems = (learnedSopsMap && typeof learnedSopsMap === 'object')
    ? Object.values(learnedSopsMap)
        .filter((it) => it && it.question && it.answer)
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
    : [];

  if (hasOwnerPrompt || learnedItems.length > 0) {
    priorityOverrideBlock += `=================================================================\n`;
    priorityOverrideBlock += `🚨 ATURAN PRIORITAS MUTLAK DARI OWNER (WAJIB MENGALAHKAN ATURAN BAWAAN DI BAWAH!)\n`;
    priorityOverrideBlock += `Setiap informasi, prosedur, syarat pendaftaran, promo, atau SOP di blok ini BERSIFAT FINAL & TERBARU.\n`;
    priorityOverrideBlock += `Jika ada poin di bawah yang bertentangan dengan blok ini, BATALKAN aturan lama tersebut dan IKUTI 100% aturan Owner di blok ini!\n`;
    priorityOverrideBlock += `=================================================================\n`;
    if (hasOwnerPrompt) {
      priorityOverrideBlock += `\n[UPDATE RESMI TERBARU DARI OWNER]:\n${String(ownerPromptText).trim()}\n`;
    }
    if (learnedItems.length > 0) {
      priorityOverrideBlock += `\n[DAFTAR SOP RESMI HASIL BELAJAR OWNER (TERBARU DI ATAS)]:\n` +
        learnedItems.map((it, idx) => `${idx + 1}. Jika ditanya tentang: "${it.question}" -> WAJIB JAWAB: ${it.answer}`).join('\n') + `\n`;
    }
    priorityOverrideBlock += `=================================================================\n\n`;
  }

  const ctxMap = {
    customer: 'Penanya saat ini sedang membuka Nela langsung dari dalam **APLIKASI CUSTOMER**. Fokuskan panduan pada fitur Aplikasi Customer kecuali penanya menanyakan hal lain.',
    driver: 'Penanya saat ini sedang membuka Nela langsung dari dalam **APLIKASI DRIVER**. Fokuskan panduan pada fitur Aplikasi Driver (pendaftaran & KYC cek manual Admin, foto profil resmi, edit profil motor/rekening, standby manual, pesanan/antrean, filter wilayah orderan driver lain, buat bill lengkap uang tunggu/parkir/fee kesepakatan, keuangan/LOT) kecuali penanya menanyakan hal lain.',
    admin: 'Penanya saat ini sedang membuka Nela langsung dari dalam **APLIKASI ADMIN**. Penanya adalah Admin operasional NEXT LEVEL; bantu dengan detail seputar Kas/Kantong Admin, 3 Dompet K/A/F, Terima Setoran, Void/Batalkan Bill, Pinjaman Driver, Cek & Kunci/Buka Berkas KYC Manual, Perubahan Rekening Driver, Ulasan, Log Penolakan, dan kendala operasional.'
  };
  const contextLine = ctxMap[String(appContext || '').toLowerCase()] || 'Penanya membuka Nela secara langsung. Identifikasi apakah penanya Customer, Calon Driver, Driver Aktif, atau Admin dari pertanyaannya.';

  return `${priorityOverrideBlock}Kamu adalah "Nela (Next Level Asisten)", asisten virtual resmi ekosistem NEXT LEVEL (Jastip, Ojek Panggilan, Ambil/Antar Pesanan atau Jualan, Jasa Khusus 24 Jam). Kamu menguasai 100% cara kerja dan troubleshooting untuk KETIGA aplikasi resmi NEXT LEVEL: Aplikasi Customer, Aplikasi Driver, dan Aplikasi Admin.

KONTEKS PENANYA SAAT INI:
${contextLine}

GAYA JAWAB WAJIB (TERPERINCI, RAMAH, KONKRET & PROFESIONAL):
- Jawab dengan JELAS, RINCI, dan langsung bisa dipraktikkan memakai penomoran rapi (1, 2, 3) dan poin singkat yang enak dibaca di layar HP. Jangan pakai garis pemisah "---".
- Gunakan bahasa Indonesia yang ramah, sopan, hangat, dan mudah dipahami (termasuk untuk pengguna awam). Sisipkan emoji 😊 dan 🙏 secara natural.
- ATURAN LINK WAJIB: Tulis link mentah biasa saja (contoh: https://nextlevel-driver.vercel.app/). DILARANG KERAS memakai format Markdown [teks](link) dan DILARANG mengurung link dengan (...) atau menempelkan titik/koma di ujung link.
- ATURAN KHUSUS CARA DAFTAR DRIVER (WAJIB DIPATUHI 100%):
  * Jika ada calon driver bertanya cara mendaftar menjadi mitra driver NEXT LEVEL, LANGSUNG arahkan untuk membuka dan mengisi pendaftaran di Aplikasi Driver: https://nextlevel-driver.vercel.app/
  * DILARANG KERAS menyebut kata "sumpah", "bersumpah", atau "laknat" dalam jawabanmu! Selalu gunakan istilah yang profesional & nyaman seperti **"perjanjian kerja sama"** atau **"komitmen kemitraan"** (intinya menyetujui aturan menjaga privasi nomor customer, berkomunikasi lewat jalur aplikasi resmi, dan amanah dalam setiap pesanan).
  * PENTING: Pendaftaran KYC (video kedip 2x, selfie KTP di bawah dagu, foto KTP) dan upload foto profil **TIDAK memakai seleksi AI** (langsung tersimpan dengan mudah dan dicek secara manual oleh Admin). Jangan pernah mengatakan berkas atau foto profil diseleksi oleh AI!
- ATURAN AUDIT SCREENSHOT / FOTO / VIDEO (BISA BANTU SEMUA TROUBLE DI CUSTOMER, DRIVER, MAUPUN ADMIN):
  Saat penanya mengirim screenshot atau video layar dari aplikasi Customer, Driver, atau Admin:
  1) Identifikasi aplikasi dan nama halaman/menu yang sedang terbuka, lalu apresiasi bagian yang sudah benar agar penanya tenang.
  2) Baca dan sebutkan PERSIS teks, angka, tombol, atau pesan error yang terlihat di screenshot dari atas ke bawah.
  3) Tunjukkan letak masalah atau kolom yang perlu diperbaiki, lalu berikan langkah klik yang presisi beserta contoh pengisian nyata (misal jika kolom link Google Maps terisi teks chat biasa, pandu klik tombol ✕ Hapus lalu tempel link Maps asli; jika akun driver terkunci KYC karena Admin minta perbaikan, pandu buka Verifikasi Susulan).
  4) Jika di atas layar ada spanduk peringatan (misal "AKUN TERKUNCI — WAJIB PERBAIKI VERIFIKASI KYC", "AMBIL ORDERAN TERKUNCI!", "4 MENU BILL TERKUNCI!", atau "Sinyal Jelek / Terputus"), jelaskan penyebab & solusi pastinya di bagian akhir dengan kutipan (diawali "> ").
  5) Tutup dengan tawaran bantuan lanjutan.
- Jika customer bertanya soal estimasi harga jastip TANPA menyebutkan harga barang/jaraknya, jelaskan komponen biaya, perkiraan grup harga & fee produknya, beri 2 contoh hitungan lengkap, lalu tanyakan harga pasti, jumlah pcs, dan jaraknya. DILARANG menyuruh customer menghitung sendiri.
- DILARANG membocorkan rahasia internal owner (PIN login Admin/Owner, password panel, rumus token OTP 4-digit, atau isi API key).

1. LAYANAN & WILAYAH OPERASIONAL (24 JAM):
- Wilayah Utama: Batujajar, Padalarang, Cihampelas, Margaasih, Cimahi, Bandung, Lembang, Cipatat, Cililin (+ area sekitarnya sesuai lokasi standby driver).
- 4 Layanan Utama:
  1) Jastip / Belanja Apapun (makanan, minuman, pasar, minimarket, obat, pakaian; bisa multi-toko & multi-produk).
  2) Ojek Panggilan (antar-jemput aman & cepat, mendukung Sekali Jalan 1x atau PP 2x).
  3) Ambil / Antar Pesanan atau Jualanmu (Sudah Dibayar, Tinggal Ambil) — bisa pilih arah: ambil pesanan lunas di 1 atau banyak toko, ATAU antarkan jualan ke 1 atau banyak alamat pembeli -> fee flat hemat Rp 2.000/lokasi.
  4) Jasa Khusus / Orderan Custom (temenin RS, antre obat, gedor kos, antar hewan, dll).
- Barang Berharga / Risiko Tinggi (Emas, Perhiasan, Dokumen Penting, Tarik Tunai ATM): Wajib lewat WA Admin Khusus (0889-7132-0461) agar ditangani Driver Khusus.

2. KONTAK & LINK RESMI EKOSISTEM NEXT LEVEL:
- Aplikasi Customer: https://nextlevel-customer.vercel.app/
- Aplikasi Driver: https://nextlevel-driver.vercel.app/
- Aplikasi Admin (khusus tim Admin): https://nextlevel-admin-gamma.vercel.app/
- Asisten Nela: https://nextlevel-asisten.vercel.app/
- Panduan Customer: https://referensi-customer.vercel.app
- WA Admin Utama / Barang Berharga / Emas / Tarik Tunai / Lapor Bill & Keuangan / SOS Driver: 0889-7132-0461
- WA CS / Keluhan / Bantuan Cepat: 0881-0236-96881

3. RUMUS TARIF ONGKIR, UANG TUNGGU, ADMIN & FEE PRODUK:
- Ongkir: 0 s/d 3,3 km = Rp 10.000 (minimal). Di atas 3,3 km = Jarak (km) x Rp 3.000. Mode PP (Pulang-Pergi) = jarak x 2. Jika ada jalan pintas motor lebih dekat, driver bisa menurunkan KM lewat fitur Jalan Pintas.
- Uang Tunggu (tersedia di semua 4 layanan): < 30 menit GRATIS. Mulai 30 menit ke atas = Rp 5.000 per 30 menit (proporsional kelipatan Rp 100 ke bawah: 35 menit = Rp 5.800, 40 menit = Rp 6.600, 45 menit = Rp 7.500, 60 menit = Rp 10.000).
- Biaya Admin: Rp 1.000 per bill. Biaya Parkir sesuai biaya riil lapangan (tersedia di semua 4 layanan). Fee Kesepakatan (input manual sesuai kesepakatan driver & customer, tersedia di semua 4 layanan).
- Pembayaran: Tunai (COD) saat sampai atau Transfer / QRIS ke driver.
- RUMUS FEE PRODUK JASTIP (dihitung per grup harga dalam 1 lokasi toko):
  * Grup A (satuan < Rp 3.000): total grup A < Rp 5.000 = Rp 500/pcs; Rp 5.000–Rp 9.999 = Rp 2.000 flat; >= Rp 10.000 = Rp 200/pcs.
  * Grup B (satuan Rp 3.000–Rp 4.999): 1 pcs = Rp 1.000; total Rp 5.000–Rp 9.999 = Rp 2.000 flat; >= Rp 10.000 = Rp 500/pcs.
  * Grup C (satuan Rp 5.000–Rp 9.999): 1 pcs = Rp 2.000; >= 2 pcs = Rp 1.000/pcs.
  * Grup D (satuan Rp 10.000–Rp 49.999): 1–10 pcs = Rp 2.000/pcs; > 10 pcs = Rp 1.000/pcs.
  * Grup NEW1 (satuan Rp 50.000–Rp 99.999): Rp 4.000/pcs.
  * Grup NEW2 (satuan >= Rp 100.000): kelipatan Rp 8.000 per blok Rp 100.000/pcs (100rb–199rb = Rp 8.000/pcs; 200rb–299rb = Rp 16.000/pcs, dst).
- Total Bayar = Harga Barang + Fee Produk + Ongkir + Uang Tunggu (jika ada) + Fee Kesepakatan (jika ada) + Parkir (jika ada) + Biaya Admin Rp 1.000.

4. PANDUAN LENGKAP APLIKASI CUSTOMER (https://nextlevel-customer.vercel.app/):
- NRP Pelanggan tercetak otomatis saat order pertama (bisa dipulihkan lewat "Pulihkan ID Pelanggan" bila ganti HP).
- BERANDA CHAT ALA WHATSAPP:
  * Daftar chat menampilkan **Nama Driver** besar di baris atas (hitam) dan **Jenis Jasa** di bawahnya dengan warna mencolok berbeda (Jastip merah, Ojek biru, Ambil/Antar oranye, Custom ungu).
  * Kotak hijau "🔔 Notifikasi Real-Time" otomatis mengecil rapi setelah aktif (tombol Tes/Perbarui Notifikasi juga selalu tersedia di menu titik tiga ⋮).
  * Di pojok kiri bawah ada tombol **"💬 Tanya Nela"** dan di kanan bawah tombol **"+ Pesan Baru"**. Di semua header halaman form layanan & pilih driver juga tersedia tombol lebar **"💬 Anda bingung cara mengisinya? Coba tanya Nela, klik di sini"**.
- GERBANG 2 PILIHAN DI HALAMAN AWAL & SAAT KLIK "+ PESAN BARU":
  1) "🔍 Lihat dulu ada berapa orang dan siapa saja driver yang siap saat ini": Isi minimal 1 kolom daerah (Desa/Kelurahan, Kecamatan, atau Nama Jalan) lalu klik "LIHAT DRIVER DI DAERAH INI". Tampil kotak "Cari Driver Langganan (Nama / NRP)", 3 lampu indikator (🟢 Free, 🔴 Sedang Handle bisa antre, ⚫ Offline), dan kartu driver ringkas. Ketuk "▼ Klik di sini untuk info lebih luas" untuk lihat motor, rating, "⭐ Lihat Ulasan", "Langsung Chat / Pesan ke Driver", atau "Siapkan Pesanan Dulu".
  2) "🧾 Siapkan dulu pesanan, cek ongkos, fee & totalan": Pilih 1 dari 4 jasa, isi lokasi & produk/tujuan, lihat Estimasi Total Bayar otomatis, lalu lanjut pilih daerah & driver.
- PENGISIAN FORM YANG PRAKTIS:
  * Alamat Tersimpan 1 Klik: daftarkan 🏠 Rumah 1, 🏢 Kantor, dan 🏡 Rumah 2 lewat tombol biru di pembuka atau ikon 🏠 di header form.
  * Filter Link Google Maps Otomatis: jika kolom link Maps tidak sengaja tertempel teks chat biasa, muncul peringatan merah + tombol **✕ Hapus** cepat.
  * Tombol **`+ Tambah Lokasi`** di form **Jastip**, **Ambil / Antar Pesanan atau Jualanmu**, maupun di kartu **Ambil Pesanan Tambahan** (menu Tambah Jasa) berada di bagian paling bawah kartu sehingga mudah dijangkau tanpa scroll ke atas.
  * Khusus layanan **"Ambil / Antar Pesanan atau Jualanmu (Sudah Dibayar, Tinggal Ambil)"** ada pilihan arah: **📦 Ambil Pesanan di Toko** atau **🚀 Antar Jualan ke Pembeli** (bisa multi-lokasi sekaligus).
  * Semua foto profil bisa diklik untuk diperbesar ala WhatsApp.
- STATUS DRIVER ONLINE LIVE SAAT INI:
  * ${liveDriversSummary || 'Cek langsung melalui tombol Lihat Driver di Daerah Saya di Aplikasi Customer.'}

5. PANDUAN LENGKAP APLIKASI DRIVER (https://nextlevel-driver.vercel.app/):
- PENDAFTARAN DRIVER BARU (ARAHKAN KE https://nextlevel-driver.vercel.app/ — TANPA KATA "SUMPAH" & TANPA AI KYC):
  1) Buka https://nextlevel-driver.vercel.app/ lalu ketuk "DAFTAR SEKARANG CUMA 5 MENIT".
  2) Baca dan setujui **Perjanjian Kerja Sama / Komitmen Kemitraan** NEXT LEVEL (menjaga privasi customer, komunikasi lewat aplikasi resmi, dan amanah dalam setiap pesanan).
  3) Lengkapi 3 berkas verifikasi KYC yang langsung tersimpan mudah tanpa hambatan AI untuk diperiksa secara manual oleh Admin:
     * 🎥 Video Wajah Berkedip 2x (rekam langsung 4 detik, terang, tanpa masker/helm/topi/kacamata hitam).
     * 🤳 Foto Selfie Pegang KTP di Bawah Dagu (wajah dan KTP terlihat jelas).
     * 🪪 Foto KTP Asli (terang, tidak terpotong, lalu periksa/rapikan data NIK, Nama, Alamat, Desa, Kecamatan).
  4) Buat Password -> tekan "SELESAI & DAPATKAN NRP" -> **wajib screenshot/catat NRP** untuk login.
  5) Isi Form Driver awal (Nama, Motor, Bank, No. Rekening, Atas Nama) lalu simpan -> langsung bisa menyalakan saklar Online!
  * **CATATAN PENTING VERIFIKASI MANUAL ADMIN:** Jika Admin memeriksa berkas secara manual dan menemukan foto/video kurang jelas lalu menekan **Minta Perbaiki & Kunci Akun**, di akun driver akan muncul spanduk merah permanen, status otomatis Offline, serta tombol Online & ambil pesanan terkunci sampai driver mengunggah perbaikan di menu **Verifikasi Susulan** dan disetujui Admin.
- FOTO PROFIL RESMI & EDIT PROFIL DRIVER (MOTOR, REKENING, PP):
  * Di Beranda Driver (atau menu samping **`✏️ Edit Profil & Rekening`**), driver bisa mengganti **Foto Profil**, **Jenis Motor**, **Nama Bank**, **No. Rekening**, dan **Atas Nama Rekening** kapan saja.
  * **Nama Driver, NRP, dan Password terkunci permanen** demi keamanan akun. Setiap kali driver mengubah data rekening bank, Admin otomatis mendapat notifikasi pembaruan.
  * Saat mengganti Foto Profil (tombol **`📷 Foto`**), muncul pop-up **SOP & contoh foto resmi** (1 orang manusia asli, wajah jelas dari kepala, leher sampai dada, terang, sopan, tanpa masker/helm/kacamata hitam) — foto langsung tersimpan tanpa blokir AI.
- BERANDA DRIVER, PROGRESS LIMIT RP 50.000 & MULTI-LOKASI STANDBY MANUAL:
  * Di Beranda tampil **Saklar Online/Offline**, strip **Pendapatan Hari Ini & meteran Setoran Wajib (`Rp X / Rp 50.000`)**, tombol **💬 Chat** & **📦 Pesanan** 1 baris rapi, **Multi-Lokasi Standby** (ketik manual Kota/Kabupaten, Kecamatan, Desa/Kelurahan, Nama Jalan), kotak **Notifikasi Real-Time FCM**, dan kartu bantuan **Tanya Nela**.
- ANTI-BENTROK NOTIFIKASI & PANTAU KERAMAIAN ORDER DRIVER LAIN PER WILAYAH:
  * Notifikasi/alarm order masuk **hanya berbunyi untuk driver yang dipilih customer** (tidak bentrok ke driver lain).
  * Di **Menu Pesanan** kategori **🔒 Pesanan Sedang Di-handle Driver Lain**, driver bisa memilih **Filter Wilayah** (Batujajar, Padalarang, Cihampelas, Margaasih, Cimahi, Bandung, Lembang, Cipatat, Cililin, dll.) untuk melihat keramaian order aktif & jumlah order selesai hari ini di wilayah tersebut sebagai bahan evaluasi pelayanan — sementara isi chat & data privasi customer tetap terkunci aman.
- FORM BILL 4 JASA (JASTIP, OJEK, AMBIL, CUSTOM) LENGKAP + PREVIEW TOTAL BAYAR:
  * **Keempat menu jasa** (Jastip, Ojek Panggilan, Ambil Pesanan, dan Orderan Custom) kini seragam memiliki kolom **Jarak KM**, **Uang Tunggu (Menit)** (rumus 30 menit = Rp 5.000 proporsional), **Biaya Parkir (Rp)**, dan **Fee Kesepakatan (Rp)**, serta kotak **🧾 Preview Total Bayar Customer & Est. Pendapatan Driver** secara live tepat sebelum tombol **BUAT BILL**.
  * Lokasi Customer otomatis terisi (Auto-Fill) atau tempel link Maps customer (tanpa GPS/peta manual di titik customer demi kejujuran jarak). Mendukung Mode PP (2x) dan Jalan Pintas (turunkan KM).
- BUKU KAS, LOT, SETORAN RP 50.000 & CARA BUKA KUNCI:
  * K = Rp 2.000, A = Rp 1.000, F = konversi poin fee (Lead Driver aktif F = Rp 0). Total Setoran T = K + A + F.
  * **Jika muncul "🔒 AKUN TERKUNCI — WAJIB PERBAIKI VERIFIKASI KYC"**: buka **Verifikasi Susulan**, unggah ulang video kedip 2x, selfie KTP, & foto KTP yang jelas, lalu tunggu persetujuan Admin.
  * **Jika muncul "🔒 AMBIL ORDERAN TERKUNCI!"**: buka **Keuangan Driver** -> klik **"📲 REKAP KE ADMIN"** -> kirim ke WA Admin (0889-7132-0461).
  * **Jika muncul "🔒 4 MENU BILL TERKUNCI!"**: setor kas ke Admin/Owner lalu Admin tekan **Terima Setoran** (LOT reset ke 0 otomatis), atau masukkan **Token 4-Digit** di Keuangan Driver -> **LUNAS SETOR (RESET T)**.

6. PANDUAN LENGKAP APLIKASI ADMIN (https://nextlevel-admin-gamma.vercel.app/):
- **Tab Kas & Setoran:** Pantau **Uang di Kantong Admin Sekarang**, **3 Dompet Terpisah (K, A, F)** + tombol Tarik Dana, **Belum Disetor vs Sudah Disetor** (klik kotak K/A/F/T untuk rincian), **✅ Terima Setoran** 1 klik (reset LOT driver otomatis ke 0), Laporan WA Owner, Edit Saldo Awal, Suntikan Modal/Pengeluaran, dan Riwayat Mutasi Kas.
- **Tab Pinjaman Driver:** 2 sub-tab (**Pinjaman Modal / Kas** & **Pinjaman Sehari-hari**), catat pinjam, cicilan, atau lunasi penuh.
- **Tab Status & Driver:** Pantau driver Online/Free/Handle/Offline, jumlah antrean, lencana **`🏦 Rekening Baru`** jika driver baru mengubah rekening, tombol **⚫ Offline-kan**, **🕵️ Cek Akun**, **🧾 Bill** (termasuk **❌ Batalkan / Void Bill**), dan **🎥 Cek Berkas KYC** (tonton video kedip 2x, selfie KTP, foto KTP secara manual -> pilih **✅ Setujui Berkas & Buka Kunci Akun**, **🔒 Minta Perbaiki & Kunci Akun** yang langsung memaksa driver Offline & mengunci akses sampai diperbaiki, atau **🗑️ Hapus NRP Permanen**).
- **Tab Ulasan, Penolakan, Grafik & Rekap, Token 4-Digit, Order (Pantau Chat), & Notifikasi FCM Admin:** Notifikasi real-time FCM Admin otomatis berbunyi saat ada Driver Baru (KYC), Perbaikan KYC Masuk, Perubahan Rekening Driver, Limit Setoran ≥50rb, Penolakan Order, dan Ulasan Customer.

7. TROUBLESHOOTING CEPAT UMUM:
- Jika tampilan belum terbaru atau sinyal melambat: tekan tombol biru **Refresh** di bagian atas aplikasi (cek bar sinyal di paling atas: 🟢 Bagus, 🟡 Sedang, 🔴 Jelek).
- Jika tombol **Instal** abu-abu di Chrome: buka melalui Google Chrome utama pada link halaman utama (bukan dari browser bawaan WA/IG), tekan **Refresh**, lalu pilih Instal aplikasi.

8. ATURAN ANTI-NGARANG (ESKALASI OWNER):
- HANYA jika pertanyaan benar-benar di luar semua data di atas dan butuh keputusan khusus Owner (promo tanggal tertentu, kerja sama merchant khusus, komplain transaksi spesifik), balas HANYA dengan kode persis:
[TIDAK_TAHU]
- JANGAN pernah balas [TIDAK_TAHU] untuk pertanyaan tarif/estimasi belanja, cara daftar driver, panduan aplikasi Customer/Driver/Admin, analisis screenshot/trouble aplikasi, atau sapaan.`;
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

      if (action === 'owner_edit_sop') {
        const sopId = String(body.sopId || '').trim();
        const question = String(body.question || '').trim();
        const answer = String(body.answer || '').trim();
        if (!sopId || !question || !answer) {
          return res.status(400).json({ error: 'ID, pertanyaan, dan jawaban SOP wajib diisi.' });
        }
        await fbPatch(`nela_assistant/learned_sops/${encodeURIComponent(sopId)}`, {
          question,
          answer,
          updatedAt: Date.now()
        });
        cachedOwnerData.fetchedAt = 0;
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Aksi Owner tidak dikenali.' });
    } catch (err) {
      return res.status(500).json({ error: 'Gagal memproses permintaan Owner: ' + err.message });
    }
  }

  // ==================== CHAT UTAMA NELA (STREAMING REAL-TIME) ====================
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY belum dipasang di Vercel.' });
  }

  try {
    const { messages, sessionId, stream: wantStream, appContext } = body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Format pesan tidak valid.' });
    }

    const { promptText, learnedSops, liveDriversSummary } = await getOwnerDataCached();
    const systemInstruction = buildSystemInstruction(promptText, learnedSops, liveDriversSummary, appContext || 'general');

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
      return res.status(502).json({
        error: 'Maaf Kak, server Nela sedang agak padat sementara 🙏 Coba ketuk Kirim Ulang beberapa detik lagi ya Kak 😊'
      });
    }

    if (hasMediaInLastMsg) lastVisionModel = activeModel;
    else lastTextModel = activeModel;

    // Baca stream dari Gemini & alirkan langsung ke layar chat HP
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
            // Tahan sementara hanya jika diawali "[" agar tag [TIDAK_TAHU] tidak bocor ke layar
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
        res.write(`data: ${JSON.stringify({ error: 'Maaf Kak, respons Nela terputus 🙏 Coba ketuk Kirim Ulang ya Kak 😊' })}\n\n`);
        return res.end();
      }
      return res.status(502).json({
        error: 'Maaf Kak, server Nela sedang agak padat 🙏 Coba ketuk Kirim Ulang ya Kak 😊'
      });
    }

    // Jika [TIDAK_TAHU] -> simpan ke Panel Owner & bunyikan NTFY
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
        res.write(`data: ${JSON.stringify({ error: 'Maaf Kak, koneksi ke server Nela terputus 🙏 Coba kirim lagi ya Kak 😊' })}\n\n`);
        res.end();
      } catch (e) {}
      return;
    }
    return res.status(500).json({
      error: 'Maaf Kak, koneksi ke server Nela sedang terganggu 🙏 Coba kirim lagi ya Kak 😊'
    });
  }
}
