# VA Benefit Ploting v0.25 - Firebase Realtime dengan Login Tim

Versi ini memakai **Cloud Firestore** untuk data realtime dan **Firebase Authentication Email/Password** untuk akses tiga anggota tim. Tidak ada pendaftaran akun dari website.

## Akun tim yang dipakai aplikasi

Buat akun ini di Firebase Authentication sebelum membuka website:

| Nama | Email login |
|---|---|
| Rakha | `rakha@benefit-virtual-ads.app` |
| Adhi | `adhi@benefit-virtual-ads.app` |
| Rian | `rian@benefit-virtual-ads.app` |

Password **tidak disimpan di source code atau repository**. Tentukan dan bagikan password melalui jalur internal saja.

## Setup wajib di Firebase Console

1. Buka project Firebase `benefit-virtual-ads`.
2. Masuk ke **Authentication** lalu aktifkan provider **Email/Password** pada menu **Sign-in method**.
3. Pada menu **Users**, buat tiga akun dengan email pada tabel di atas. Tetapkan password untuk masing-masing akun.
4. Buka **Firestore Database** > **Rules**, lalu tempel isi file `firestore.rules` dan klik **Publish**.
5. Pastikan Cloud Firestore sudah aktif dalam mode Production.
6. Buka **Authentication** > **Settings** > **Authorized domains**, lalu pastikan hostname berikut tersedia:

   `tigadigital.github.io`

   Masukkan hostname saja. Jangan memasukkan `https://` atau path `/Benefit-Virtual-Ads/`.

## Deploy Rules melalui Firebase CLI

Jalankan dari folder proyek ini:

```bash
npm install -g firebase-tools
firebase login
firebase use benefit-virtual-ads
firebase deploy --only firestore:rules
```

Alternatifnya, salin isi `firestore.rules` langsung ke Firebase Console lalu klik **Publish**.

## Deploy GitHub Pages

Upload seluruh isi folder ini ke repository `tigadigital/Benefit-Virtual-Ads`, termasuk folder `assets`. Pastikan GitHub Pages memuat `index.html` dari branch yang dipilih.

Website akan tersedia di:

```text
https://tigadigital.github.io/Benefit-Virtual-Ads/
```

## Pengujian realtime

1. Buka website pada dua browser atau perangkat.
2. Masuk memakai dua akun tim yang berbeda.
3. Tambah atau ubah ploting di perangkat pertama.
4. Perangkat kedua akan menerima pembaruan Firestore tanpa refresh halaman.

## Catatan operasional

- Akun yang tidak ada pada daftar Firestore Rules tidak bisa membaca atau menulis data.
- Status sinkronisasi Firebase tampil di kanan atas setelah login.
- Tanggal operasional adalah preferensi tampilan per browser. Ploting dan Master Data disimpan bersama di Cloud Firestore.
