# Prompt Gambar untuk ChatGPT — Balesin & Kak Sky

Cara pakai:
1. Buka ChatGPT, mulai chat baru khusus "Branding Balesin" (supaya karakter konsisten).
2. Tempel **Prompt 0 (gaya dasar)** dulu, lalu prompt lain satu per satu di chat yang sama.
3. Kalau Kak Sky versi lama sudah ada, **lampirkan gambarnya** di Prompt 1 dan tambahkan
   kalimat: *"Use the attached image as the exact character reference."*
4. Unduh PNG, simpan ke `assets/brand/` dengan nama file yang tertulis di tiap prompt.
5. Agent `frontend` akan mengubah logo menjadi SVG bersih dan memakai ilustrasi di layar
   yang sesuai; `kritikus-desain` menyesuaikan warna token dengan logo final.

Palet (sama dengan `DESIGN.md`): Biru Langit `#1167D8`, Senja `#FF7A59`,
Tinta `#14202E`, Kertas `#F6F4EF`, Hijau `#1F9D6B`.

---

## Prompt 0 — Gaya dasar (tempel pertama)
```
We are creating a consistent illustration set for "Balesin", a customer-service chat app
made by an Indonesian internet provider. Style for ALL images in this chat:
- clean modern flat vector illustration with subtle soft shading (2.5D), smooth rounded
  shapes, confident outlines in dark navy #14202E (2px feel), no gradients except very soft
- limited palette: sky blue #1167D8, sunset coral #FF7A59, navy #14202E, warm paper white
  #F6F4EF, leaf green #1F9D6B, plus skin and hair tones
- friendly, warm, slightly playful Gen Z vibe, but professional enough for a business app
- no text, no letters, no watermark unless I ask
- transparent background (PNG) unless I ask otherwise
Reply "OK" and wait for my next prompt.
```

## Prompt 1 — Lembar karakter Kak Sky → `kak-sky-sheet.png`
```
Create a character reference sheet of "Kak Sky", the mascot of Balesin.
Kak Sky is a cheerful young Indonesian customer-service hero in their early twenties,
warm brown skin, short tousled dark hair with a small cloud-shaped hair clip,
bright friendly eyes, big genuine smile.
Outfit: oversized sky-blue (#1167D8) hoodie with a tiny white cloud logo on the chest
(no text), coral (#FF7A59) inner t-shirt collar, navy pants, white sneakers with coral
details, a slim modern headset with a mic.
Show: front view, three-quarter view, side view, and back view standing in a row,
plus 6 small head expressions underneath: happy, laughing, thinking, surprised,
apologetic, proud. Same proportions in every view (about 3 heads tall, chibi-leaning
but not baby-like). Transparent background, 1536x1024.
```
> Mau versi cewek/cowok yang lebih jelas? Tambahkan "female" atau "male" setelah
> "customer-service hero".

## Prompt 2 — Pose untuk layar aplikasi (satu per gambar, 1024x1024, transparan)
Tempel satu per satu, ganti bagian `[POSE]`:
```
Kak Sky, exactly the same character and style as the reference sheet, full body,
[POSE]. Transparent background, 1024x1024, centered with generous padding.
```
| File | [POSE] | Dipakai di |
|---|---|---|
| `kak-sky-wave.png` | waving hello with one hand, other hand on headset | Wizard setup, login |
| `kak-sky-inbox-empty.png` | relaxing on a small floating cloud with a cup of coffee, phone resting beside, calm and content | Inbox kosong |
| `kak-sky-sleep.png` | sleeping peacefully on a cloud under a small crescent moon | Di luar jam kerja |
| `kak-sky-success.png` | jumping with a fist in the air, small confetti in coral and blue | Broadcast/koneksi berhasil |
| `kak-sky-search.png` | holding a big magnifying glass, curious face | Hasil cari kosong, 404 |
| `kak-sky-fix.png` | kneeling and fixing a glowing network cable with a small wrench, focused | Error koneksi / gangguan |
| `kak-sky-broadcast.png` | holding a megaphone, small chat bubbles flying out | Halaman broadcast kosong |
| `kak-sky-shield.png` | holding a round shield with a check mark, confident | 2FA, keamanan |
| `kak-sky-team.png` | three teammates around Kak Sky (one in office shirt, one technician with a helmet and tool belt), all smiling | Undang anggota tim |

## Prompt 3 — Logo Balesin → `logo-symbol.png`, `logo-full.png`
```
Design a logo for "Balesin", an Indonesian customer-service chat app (the name means
"reply to it" in casual Indonesian). Symbol: a rounded chat bubble whose tail curls
into a small reply arrow, forming a subtle lowercase "b" shape; sky blue #1167D8 with
one small coral #FF7A59 accent dot. Flat vector, no gradients, no shadows, geometric,
works at 16px. Show the symbol alone on a transparent background, and next to it a
version with the wordmark "balesin" in a friendly rounded geometric sans-serif,
lowercase, navy #14202E. Generous whitespace, 1536x1024.
```
> Logo dari ChatGPT berupa gambar raster. Nanti dibuat ulang sebagai SVG oleh agent
> `frontend`. Sebelum dipakai resmi/dijual, cek merek di PDKI.

## Prompt 4 — Ikon aplikasi → `app-icon.png`
```
App icon for Balesin: the same chat-bubble "b" symbol in white, centered on a solid
sky blue #1167D8 rounded-square background, small coral #FF7A59 dot accent.
Flat, no text, no gradients, 1024x1024, fills the square edge to edge
(the rounded corners will be applied by the operating system).
```

## Prompt 5 — Ilustrasi login → `login-hero.png`
```
Wide illustration for a login screen: Kak Sky sitting on a large soft cloud above a
small Indonesian town at dusk (rice fields, a few houses, a fiber-optic pole with a
cable), floating chat bubbles connecting the houses to the cloud like a network.
Palette limited to the brand colors, calm and spacious, lots of empty sky at the
top-left for text overlay. No text. 1536x1024, NOT transparent (paper white sky
#F6F4EF fading to soft coral near the horizon).
```

## Prompt 6 — Versi mode gelap (opsional) → `login-hero-dark.png`
```
Same login illustration, night version: navy sky #0F1620 with soft stars,
glowing sky-blue network lines between houses, Kak Sky holding a small lantern-like
phone. No text. 1536x1024.
```
