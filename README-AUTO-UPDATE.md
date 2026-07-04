# Auto-update setelah deploy GitHub Pages

Paket ini sudah memiliki pengecekan versi otomatis.

1. Upload seluruh file ke repository GitHub.
2. Buka **Settings > Pages** pada repository.
3. Pada **Build and deployment**, pilih **GitHub Actions** sebagai sumber deploy.
4. Push ke branch `main`.

Setiap deploy membuat `version.json` baru dan mengganti query versi untuk `app.js`, `style.css`, dan `update-check.js`. Website yang sudah terbuka akan mengecek versi baru setiap 60 detik serta ketika tab kembali aktif.

Halaman tidak akan dipaksa refresh ketika pengguna sedang mengisi field, membuka modal, atau memasukkan password. Pembaruan diterapkan setelah aktivitas tersebut selesai.

Catatan: untuk rollout pertama setelah memasang fitur ini, perangkat yang masih membuka versi lama perlu direfresh sekali secara manual. Setelah versi ini aktif, deploy berikutnya akan terdeteksi otomatis.

Jika branch deploy bukan `main`, ubah bagian `branches: ["main"]` pada `.github/workflows/deploy-pages.yml`.
