# VA Benefit Ploting v0.26 - Firebase Realtime Database

Versi ini memakai **Firebase Realtime Database**, bukan Cloud Firestore. Data Master Data dan seluruh jadwal ploting disimpan di path berikut:

```text
vaBenefitPloting/shared/masters
vaBenefitPloting/shared/schedules/{scheduleId}
```

Aplikasi mendengarkan perubahan secara realtime dengan Firebase Realtime Database. Saat Rakha, Adhi, atau Rian membuat, mengubah, menggeser, atau menghapus jadwal, browser anggota tim lain akan menerima pembaruan otomatis.

## 1. Periksa Database URL

Konfigurasi Firebase yang diberikan sebelumnya belum memuat `databaseURL`. File `app.js` saat ini memakai URL default berikut:

```js
databaseURL: "https://benefit-virtual-ads-default-rtdb.firebaseio.com"
```

Buka Firebase Console > Realtime Database > Data lalu salin **Database URL** yang tampil di bagian atas. Jika URL Anda berbeda, terutama bila memakai lokasi regional seperti `*.firebasedatabase.app`, ganti nilai `databaseURL` pada `app.js` dengan URL persis dari console.

## 2. Aktifkan Firebase Authentication

1. Buka Firebase Console pada project `benefit-virtual-ads`.
2. Buka Authentication > Sign-in method.
3. Aktifkan provider **Email/Password**.
4. Buka tab Users, lalu buat tiga akun internal:

| Nama | Email |
|---|---|
| Rakha | `rakha@benefit-virtual-ads.app` |
| Adhi | `adhi@benefit-virtual-ads.app` |
| Rian | `rian@benefit-virtual-ads.app` |

Tentukan password internal untuk setiap akun dari Firebase Console. Password tidak disimpan di source code atau repository.

## 3. Publish Realtime Database Rules

1. Buka Realtime Database > Rules.
2. Salin isi file `database.rules.json`.
3. Klik **Publish**.

Rules tersebut membatasi baca dan tulis hanya kepada tiga email tim.

Alternatif Firebase CLI:

```bash
npm install -g firebase-tools
firebase login
firebase use benefit-virtual-ads
firebase deploy --only database
```

## 4. Authorized domain untuk GitHub Pages

Buka Authentication > Settings > Authorized domains, kemudian pastikan hostname ini terdaftar:

```text
tigadigital.github.io
```

Masukkan hostname saja, tanpa `https://` dan tanpa path `/Benefit-Virtual-Ads/`.

## 5. Deploy ke GitHub Pages

Upload seluruh isi folder ini ke repository `tigadigital/Benefit-Virtual-Ads`, termasuk folder `assets`.

URL aplikasi:

```text
https://tigadigital.github.io/Benefit-Virtual-Ads/
```

## 6. Pengujian realtime

1. Buka URL aplikasi di dua browser atau perangkat.
2. Login menggunakan dua akun tim yang berbeda.
3. Tambah atau ubah ploting pada perangkat pertama.
4. Perubahan akan muncul otomatis pada perangkat kedua tanpa refresh.

## Catatan

- Data Firestore dari versi sebelumnya tidak dipindahkan otomatis ke Realtime Database.
- Data di Realtime Database hanya dibuat setelah akun tim berhasil login dan Anda mulai menambah Master Data atau ploting.
- Jika status sinkronisasi menunjukkan gagal, periksa `databaseURL`, Email/Password Authentication, Realtime Database Rules, dan koneksi internet.
