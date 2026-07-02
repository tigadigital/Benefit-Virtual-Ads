# VA Benefit Ploting v0.28 - Firebase Realtime Database

Aplikasi memakai **Firebase Realtime Database** untuk Master Data dan seluruh jadwal ploting. Semua perubahan akan tersinkron antar perangkat setelah login.

## Path data

```text
vaBenefitPloting/shared/masters
vaBenefitPloting/shared/schedules/{scheduleId}
```

## Perubahan v0.28

- Tanggal operasional otomatis memakai tanggal hari ini setiap aplikasi dibuka.
- Master Ploting memakai filter **Tahun** dan **Bulan** terpisah.
- Kalender Full memakai filter **Tahun** dan **Bulan** terpisah.
- Timeline Brand memakai filter **Tahun** dan **Bulan** terpisah.
- Report PIC memakai filter **Tahun** dan **Kuartal**: Q1, Q2, Q3, atau Q4.
- Penghapusan Master Data diperbaiki. Item yang tidak dipakai jadwal dapat dihapus dan tidak akan muncul kembali saat sinkronisasi. Item yang sudah dipakai tetap terkunci untuk menjaga histori.

## Database URL

```js
databaseURL: "https://benefit-virtual-ads-default-rtdb.asia-southeast1.firebasedatabase.app"
```

Jangan mengganti URL ini. Instance Realtime Database berada pada region `asia-southeast1`.

## Login tim

Aktifkan provider **Email/Password** pada Firebase Authentication dan buat akun berikut:

| Nama | Email login |
|---|---|
| Rakha | `rakha@benefit-virtual-ads.app` |
| Adhi | `adhi@benefit-virtual-ads.app` |
| Rian | `rian@benefit-virtual-ads.app` |

Password tidak disimpan pada source code atau repository.

## Publish Rules

1. Buka **Realtime Database > Rules** pada Firebase Console.
2. Salin isi `database.rules.json`.
3. Klik **Publish**.

Rules membatasi akses baca dan tulis hanya untuk tiga akun tim.

## Deploy GitHub Pages

Upload seluruh isi folder ini ke repository `tigadigital/Benefit-Virtual-Ads`, termasuk folder `assets`.

```text
https://tigadigital.github.io/Benefit-Virtual-Ads/
```

File `index.html` memanggil `app.js?v=28` untuk menghindari cache JavaScript lama. Setelah deploy, lakukan hard refresh dengan `Ctrl + Shift + R`.

## Pengujian realtime

1. Buka aplikasi pada dua browser atau perangkat.
2. Login memakai dua akun berbeda.
3. Tambah, ubah, atau hapus jadwal di perangkat pertama.
4. Perubahan harus tampil otomatis di perangkat kedua tanpa refresh.
