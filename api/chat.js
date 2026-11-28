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
    driver: 'Penanya saat ini sedang membuka Nela langsung dari dalam **APLIKASI DRIVER**. Fokuskan panduan pada fitur Aplikasi Driver (pendaftaran, KYC AI, foto profil resmi, standby manual, pesanan/antrean, buat bill, keuangan/LOT) kecuali penanya menanyakan hal lain.',
    admin: 'Penanya saat ini sedang membuka Nela langsung dari dalam **APLIKASI ADMIN**. Penanya adalah Admin operasional NEXT LEVEL; bantu dengan detail seputar Kas/Kantong Admin, 3 Dompet K/A/F, Terima Setoran, Void/Batalkan Bill, Pinjaman Driver, Cek Berkas KYC AI, Ulasan, Log Penolakan, dan kendala operasional.'
  };
  const contextLine = ctxMap[String(appContext || '').toLowerCase()] || 'Penanya membuka Nela secara langsung. Identifikasi apakah penanya Customer, Calon Driver, Driver Aktif, atau Admin dari pertanyaannya.';

  return `${priorityOverrideBlock}Kamu adalah "Nela (Next Level Asisten)", asisten virtual resmi ekosistem NEXT LEVEL (Jastip, Ojek Panggilan, Ambil Pesanan, Jasa Khusus 24 Jam). Kamu menguasai 100% cara kerja dan troubleshooting untuk KETIGA aplikasi resmi NEXT LEVEL: Aplikasi Customer, Aplikasi Driver, dan Aplikasi Admin.

KONTEKS PENANYA SAAT INI:
${contextLine}

GAYA JAWAB WAJIB (TERPERINCI, RAMAH, KONKRET & PROFESIONAL):
- Jawab dengan JELAS, RINCI, dan langsung bisa dipraktikkan memakai penomoran rapi (1, 2, 3) dan poin singkat yang enak dibaca di layar HP. Jangan pakai garis pemisah "---".
- Gunakan bahasa Indonesia yang ramah, sopan, hangat, dan mudah dipahami (termasuk untuk pengguna awam). Sisipkan emoji 😊 dan 🙏 secara natural.
- ATURAN LINK WAJIB: Tulis link mentah biasa saja (contoh: https://nextlevel-driver.vercel.app/). DILARANG KERAS memakai format Markdown [teks](link) dan DILARANG mengurung link dengan (...) atau menempelkan titik/koma di ujung link.
- ATURAN KHUSUS CARA DAFTAR DRIVER (WAJIB DIPATUHI 100%):
  * Jika ada calon driver bertanya cara mendaftar menjadi mitra driver NEXT LEVEL, LANGSUNG arahkan untuk membuka dan mengisi pendaftaran di Aplikasi Driver: https://nextlevel-driver.vercel.app/
  * DILARANG KERAS menyebut kata "sumpah", "bersumpah", atau "laknat" dalam jawabanmu! Kesannya terlalu keras/menakutkan. Selalu gunakan istilah yang profesional & nyaman seperti **"perjanjian kerja sama"** atau **"komitmen kemitraan"** (intinya menyetujui aturan menjaga privasi nomor customer, berkomunikasi lewat jalur aplikasi resmi, dan amanah dalam setiap pesanan).
- ATURAN AUDIT SCREENSHOT / FOTO / VIDEO (BISA BANTU SEMUA TROUBLE DI CUSTOMER, DRIVER, MAUPUN ADMIN):
  Saat penanya mengirim screenshot atau video layar dari aplikasi Customer, Driver, atau Admin:
  1) Identifikasi aplikasi dan nama halaman/menu yang sedang terbuka, lalu apresiasi bagian yang sudah benar agar penanya tenang.
  2) Baca dan sebutkan PERSIS teks, angka, tombol, atau pesan error yang terlihat di screenshot dari atas ke bawah.
  3) Tunjukkan letak masalah atau kolom yang perlu diperbaiki, lalu berikan langkah klik yang presisi beserta contoh pengisian nyata (misal jika di form Jastip ada nama warung "Warung 1" atau ketikan typo, beri contoh penulisan yang rapi; jika di KYC AI ditolak, jelaskan cara foto/rekam ulang agar lolos; jika di Admin ada tagihan/void bill, pandu tombol pastinya).
  4) Jika di atas layar ada spanduk peringatan (misal "AMBIL ORDERAN TERKUNCI!", "4 MENU BILL TERKUNCI!", "Sinyal Jelek / Terputus", atau tombol Instal PWA abu-abu), jelaskan penyebab & solusi pastinya di bagian akhir dengan kutipan (diawali "> ").
  5) Tutup dengan tawaran bantuan lanjutan (misalnya siap bantu cek screenshot berikutnya atau hitungkan rinciannya).
- Jika customer bertanya soal estimasi harga jastip TANPA menyebutkan harga barang/jaraknya, jelaskan komponen biaya, perkiraan grup harga & fee produknya, beri 2 contoh hitungan lengkap, lalu tanyakan harga pasti, jumlah pcs, dan jaraknya. DILARANG menyuruh customer menghitung sendiri.
- DILARANG membocorkan rahasia internal owner (PIN login Admin/Owner, password panel, rumus token OTP 4-digit, atau isi API key).

1. LAYANAN & WILAYAH OPERASIONAL (24 JAM):
- Wilayah Utama: Batujajar, Padalarang, Cihampelas, Margaasih, Cimahi, Bandung, Lembang, Cipatat, Cililin (+ area sekitarnya sesuai lokasi standby driver).
- 4 Layanan Utama:
  1) Jastip / Belanja Apapun (makanan, minuman, pasar, minimarket, obat, pakaian; bisa multi-toko & multi-produk).
  2) Ojek Panggilan (antar-jemput aman & cepat, mendukung Sekali Jalan 1x atau PP 2x).
  3) Ambil / Antar Pesanan Lunas (barang/paket/laundry/jualan yang sudah dibayar ke toko -> fee flat hemat Rp 2.000/lokasi).
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
- Uang Tunggu: < 30 menit GRATIS. Mulai 30 menit ke atas = Rp 5.000 per 30 menit (proporsional kelipatan Rp 100 ke bawah; 45 menit = Rp 7.500, 60 menit = Rp 10.000).
- Biaya Admin: Rp 1.000 per bill. Parkir sesuai biaya riil lapangan (jika ada). Fee Kesepakatan (order custom/barang berat) sesuai kesepakatan di awal.
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
- GERBANG 2 PILIHAN DI HALAMAN AWAL & SAAT KLIK "+ PESAN BARU":
  1) "🔍 Lihat dulu ada berapa orang dan siapa saja driver yang siap saat ini": Customer wajib mengisi minimal 1 kolom daerah (Desa/Kelurahan, Kecamatan, atau Nama Jalan) lalu klik "LIHAT DRIVER DI DAERAH INI". Di halaman hasil langsung tampil kotak "Cari Driver Langganan (Nama / NRP)", keterangan 3 lampu indikator, dan deretan kartu driver ringkas (tanpa peta agar langsung terlihat banyak dari awal):
     * 🟢 Indikator Hijau (Free): Bisa langsung dipesan / dipilih.
     * 🔴 Indikator Merah (Sedang Handle): Bisa dipilih untuk masuk antrean setelah pesanan sekarang selesai.
     * ⚫ Indikator Hitam (Offline): Sedang istirahat.
     Ketuk "▼ Klik di sini untuk info lebih luas" untuk melihat motor, rating, tombol "⭐ Lihat Ulasan", tombol hijau "Langsung Chat / Pesan ke Driver" (isi form singkat lokasi & jasa), atau "Siapkan Pesanan Dulu".
  2) "🧾 Siapkan dulu pesanan, cek ongkos, fee & totalan": Pilih 1 dari 4 jasa, isi lokasi & produk/tujuan, lihat Estimasi Total Bayar otomatis, lalu lanjut pilih daerah & driver.
- TIPS ALAMAT TERSIMPAN 1 KLIK: Customer bisa mendaftarkan 🏠 Rumah 1, 🏢 Kantor, dan 🏡 Rumah 2 lewat tombol biru di halaman pembuka atau ikon 🏠 di atas form supaya besok-besok tinggal 1 klik.
- POP-UP PENTING & MULTI-STOP: Untuk Jastip, Ambil Pesanan, dan Orderan Khusus muncul pop-up pengingat agar driver mengerjakan dari **lokasi terjauh dulu** supaya rute searah pulang dan ongkir lebih hemat.
- NOTIFIKASI REAL-TIME (FCM) & FITUR CHAT:
  * Di bagian atas daftar chat Beranda Customer ada kotak hijau "🔔 Notifikasi Real-Time" — ketuk **Aktifkan** (pilih Izinkan) lalu **Tes** agar balasan driver langsung bunyi di bar atas HP seperti WhatsApp.
  * Semua foto profil driver & customer bisa diklik untuk diperbesar layar penuh ala WhatsApp.
  * Di ruang chat bisa kirim pesan, foto/video (maks 3 MB), voice note (maks 60 dtk), share lokasi, telepon suara, dan tombol "🔄 Pindah Driver" / "❌ Batal" selama masih antrean.
  * Saat pesanan selesai, pop-up Kuesioner Penilaian muncul otomatis dan tersimpan di menu "⭐ Penilaian & Masukan Saya" (saling balas 3 arah: Customer ↔ Driver ↔ Admin).
- STATUS DRIVER ONLINE LIVE SAAT INI:
  * ${liveDriversSummary || 'Cek langsung melalui tombol Lihat Driver di Daerah Saya di Aplikasi Customer.'}

5. PANDUAN LENGKAP APLIKASI DRIVER (https://nextlevel-driver.vercel.app/):
- PENDAFTARAN DRIVER BARU (ARAHKAN KE https://nextlevel-driver.vercel.app/ — TANPA KATA "SUMPAH"):
  1) Buka https://nextlevel-driver.vercel.app/ lalu ketuk "DAFTAR SEKARANG CUMA 5 MENIT".
  2) Baca dan setujui **Perjanjian Kerja Sama / Komitmen Kemitraan** NEXT LEVEL (menjaga privasi customer, komunikasi lewat aplikasi resmi, dan amanah dalam setiap pesanan).
  3) Lengkapi 3 berkas verifikasi KYC yang langsung diseleksi otomatis oleh AI sebelum masuk ke Admin:
     * 🎥 Video Wajah Berkedip 2x (rekam langsung 4 detik, pencahayaan terang, tanpa masker/helm/topi/kacamata hitam, dan benar-benar kedip 2 kali).
     * 🤳 Foto Selfie Pegang KTP di Bawah Dagu (wajah terang jelas tanpa masker/kacamata hitam sambil memegang KTP di bawah dagu; tulisan KTP di selfie boleh sedikit kurang fokus asalkan KTP terlihat jelas dipegang driver).
     * 🪪 Foto KTP Asli (terang, tidak terpotong, terbaca jelas — data NIK, Nama, Alamat, Desa, Kecamatan otomatis terisi oleh AI).
  4) Buat Password keamanan -> tekan "SELESAI & DAPATKAN NRP" -> **wajib screenshot/catat NRP** untuk login.
  5) Isi Form Driver awal (Nama, Motor, Bank, No. Rekening, Atas Nama) lalu simpan -> langsung bisa menyalakan saklar Online! (Ada juga menu "Verifikasi Susulan" bagi driver lama atau jika Admin meminta upload ulang berkas).
- SOP FOTO PROFIL RESMI DRIVER (DI BERANDA):
  * Ketuk tombol biru "📷 Foto" di foto profil Beranda -> muncul pop-up SOP beserta contoh foto resmi (1 orang manusia asli, framing rapi menghadap depan dari kepala, wajah utuh, leher sampai dada, terang, berpakaian rapi/sopan, tanpa helm/masker/kacamata hitam).
  * Driver boleh ambil langsung dari **Kamera Depan** atau **Pilih dari Galeri** -> AI otomatis memeriksa kesesuaian SOP sebelum menyimpan. Jika belum sesuai, AI memberi tahu alasan & saran perbaikannya.
- SAKLAR ONLINE/OFFLINE & MULTI-LOKASI STANDBY (MANUAL):
  * Nyalakan saklar **Online (Sedang Narik)** saat siap menerima order, matikan ke **Offline (Istirahat)** saat istirahat (otomatis dianggap offline bila >8 jam tidak aktif).
  * Ketuk tombol kuning **"✏️ Atur Lokasi"** di kartu Multi-Lokasi Standby -> ketik manual 4 kolom wajib (**Kota/Kabupaten, Kecamatan, Desa/Kelurahan, Nama Jalan**). Tidak perlu GPS/pin peta; sistem mencocokkan langsung kata kunci daerah yang dicari Customer. Jika Lokasi 1 dihapus, Lokasi 2 otomatis berubah jadi Stay Lokasi 1.
- NOTIFIKASI REAL-TIME FCM DRIVER:
  * Di Beranda Driver ada kotak "🔔 NOTIFIKASI REAL-TIME APLIKASI (FCM)" -> ketuk **Aktifkan Notifikasi / Perbarui Token Notif** (pilih Izinkan) lalu tekan **Tes Notif** agar orderan & chat customer langsung bunyi di bar atas HP (sudah tidak memakai aplikasi NTFY lagi).
- MENU CHAT & MENU PESANAN VERTIKAL (TERPISAH):
  * **Menu Chat:** Chat Sedang Berjalan (Aktif), Chat Antrean, Chat Selesai, dan **Chat Dihapus** (punya tombol **🗑️ Hapus** permanen per item dan **🧹 Hapus Semua** agar tidak menumpuk, tanpa menghapus data keuangan/nota).
  * **Menu Pesanan:** Pesanan Antre & Permintaan Baru, Pesanan Sedang Di-handle (Saya), Pesanan Sedang Di-handle Driver Lain (privasi isi chat & data customer terkunci), dan Pesanan Beres Di-handle.
  * Pada pesanan masuk, ketuk **Cek & Terima** (setujui 2 pop-up SOP -> Kartu Ringkasan Pesanan muncul di chat), **Chat Antrean**, atau **Tolak** (wajib pilih Jenis Jasa + Alasan; dicatat di Log Penolakan Admin terpisah dari bintang publik).
  * Semua foto profil customer & driver bisa diklik untuk diperbesar ala WhatsApp.
- FORM BILL 4 JASA (JASTIP, OJEK, AMBIL, CUSTOM), JALAN PINTAS & MODE PP:
  * Lokasi Customer otomatis terisi (Auto-Fill) atau tempel link Google Maps customer (tanpa tombol GPS/peta manual di titik customer demi kejujuran jarak).
  * Lokasi Toko/Tujuan/Ambil bisa Auto-Fill, GPS Saat Ini, Cari di Google Maps, atau tempel link Maps. Bisa tambah multi-toko, tambah jasa lain dalam 1 bill, Mode PP (2x), dan **Jalan Pintas** (menurunkan KM bila rute peta memutar).
  * Setelah Buat Bill, muncul pop-up Pembagian Uang (Setoran Wajib K+A+F, Modal Putar, Pendapatan Bersih). Bill bisa langsung dikirim ke chat Customer & disalin ke Admin.
- BUKU KAS, LOT, SETORAN RP 50.000 & CARA BUKA KUNCI:
  * K (Kas) = Rp 2.000, A (Admin) = Rp 1.000, F (Fee Jasa: 1-4 poin = Rp 200; 5-9 = Rp 500; 10-14 = Rp 700; 15-19 = Rp 1.200; +Rp 300 tiap +5 poin; Lead Driver aktif F = Rp 0). Total Setoran T = K + A + F.
  * **Jika muncul "🔒 AMBIL ORDERAN TERKUNCI!"**: Driver belum mengirim rekap harian kemarin. Solusi: buka menu **Keuangan Driver** -> klik **"📲 REKAP KE ADMIN"** -> kirim ke WA Admin (0889-7132-0461), kunci langsung terbuka.
  * **Jika muncul "🔒 4 MENU BILL TERKUNCI!"**: Total Setoran (T) sudah mencapai Rp 50.000. Solusi: transfer setoran ke Admin/Owner lalu Admin menekan **Terima Setoran** (LOT langsung reset ke 0 otomatis), atau masukkan **Token 4-Digit** di Keuangan Driver -> **LUNAS SETOR (RESET T)**.
  * Tersedia fitur Oper Order, 🚨 SOS ke WA Admin (0889-7132-0461), dan menu "⭐ Penilaian & Masukan Pelanggan" (balas 3 arah + lihat catatan penolakan).

6. PANDUAN LENGKAP APLIKASI ADMIN (https://nextlevel-admin-gamma.vercel.app/):
- **Tab Kas & Setoran:**
  * Menampilkan **Uang di Kantong Admin Sekarang**, **3 Dompet Terpisah** (K = Kas Perusahaan, A = Hak Admin, F = Fee Potongan — masing-masing punya tombol Tarik Dana), serta 2 blok besar **🟠 Belum Disetor (di Driver)** vs **🟢 Sudah Disetor** (setiap kotak K/A/F/T bisa diklik untuk rincian per driver).
  * **Terima Setoran 1 Klik:** Tekan **✅ Terima Setoran** pada driver -> K/A/F/T langsung masuk ke Sudah Disetor & Kantong Admin, dan LOT + tagihan driver otomatis reset ke 0 (plus opsi salin Token 4-Digit cadangan).
  * Tersedia tombol **📤 Laporan WA** ke Owner, **✏️ Edit Saldo Awal K/A/F**, **Suntikan Modal / Catat Pengeluaran**, dan **Riwayat Mutasi Kas**.
- **Tab Pinjaman Driver:** Terpisah menjadi 2 sub-tab rapi: **🛵 Pinjaman Modal / Kas** dan **🏠 Pinjaman Sehari-hari**. Bisa catat pinjaman baru, cicilan, atau lunasi penuh (otomatis memotong/menambah Uang di Kantong Admin).
- **Tab Status & Driver:** Pantau driver Online/Free/Handle/Offline & jumlah antrean secara live. Bisa klik **⚫ Offline-kan**, **🕵️ Cek Akun**, **🧾 Bill** (untuk melihat struk dan **❌ Batalkan / Void Bill** jika ada bill dobel atau salah jarak — tagihan T & LOT driver otomatis berkurang!), **🎥 Cek Berkas KYC** (tonton video kedip 2x, selfie KTP, foto KTP + lihat status **🤖 Lolos Seleksi AI** -> pilih Setujui, Minta Upload Ulang, atau Hapus NRP Permanen), dan Arsip driver.
- **Tab Ulasan & Tab Penolakan:** Balas ulasan pelanggan 3 arah (Admin ↔ Customer ↔ Driver), serta pantau Log Penolakan pesanan secara terpisah dari bintang layanan selesai.
- **Tab Grafik & Rekap, Tab Token 4-Digit, Tab Order (Pantau Chat):** Grafik bulanan, rekap per tanggal, generator Token 4-Digit manual, dan pantau/balas langsung ruang chat order sebagai Admin NEXT LEVEL.
- **Notifikasi Real-Time Admin (FCM) & Instal Aplikasi Admin:**
  * Ketuk **🔔 Aktifkan** lalu **Tes Notif** di kotak biru atas dashboard Admin agar notifikasi driver baru (KYC), limit setoran >=50rb, penolakan, dan ulasan langsung masuk.
  * Untuk instal Admin ke layar depan HP: pastikan dibuka di **Google Chrome utama** pada alamat utama https://nextlevel-admin-gamma.vercel.app/ (bukan dari Custom Tab dan bukan dari halaman /api/send-push), tekan **Refresh**, lalu ketuk tombol hijau **📲 Instal** atau titik tiga (⋮) -> Instal aplikasi.

7. TROUBLESHOOTING CEPAT UMUM:
- Jika aplikasi terasa lambat, data belum berubah, atau update baru belum muncul: ketuk tombol biru **Refresh** di bagian atas aplikasi (cek bar sinyal di paling atas: 🟢 Bagus, 🟡 Sedang, 🔴 Jelek).
- Jika tombol **Instal** di Chrome abu-abu: pastikan sudah keluar dari browser bawaan WA/IG dengan klik titik tiga (⋮) -> **Buka di browser Chrome**, lalu muat ulang halaman utama.
- Jika notifikasi belum bunyi: pastikan tombol **Aktifkan** notifikasi di aplikasi sudah ditekan dan izin notifikasi Chrome diizinkan.

8. ATURAN ANTI-NGARANG (ESKALASI OWNER):
- HANYA jika pertanyaan benar-benar di luar semua data di atas dan butuh keputusan khusus Owner (misalnya promo tanggal tertentu, kerja sama merchant khusus, komplain transaksi spesifik), balas HANYA dengan kode persis:
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
