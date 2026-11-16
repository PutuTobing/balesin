import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { apiError, sessionAs } from './mocks';
import type { WebSocketRoute } from '@playwright/test';
import {
  PHOTO_CHAT,
  PHOTO_CONVERSATIONS,
  PHOTO_NEW_MESSAGE,
  growingMessages,
  inboxMocks,
} from './mocks-inbox';
import { quietSecurity } from './mocks-tim';
import type { Screen } from './screens';

const CHAT = `/inbox?chat=${PHOTO_CHAT.id}`;
/** Gambar lampiran contoh: ikon aplikasi (aset merek sendiri). */
const APP_ICON = readFileSync(new URL('../../assets/brand/app-icon.png', import.meta.url));
const EXPIRED = PHOTO_CONVERSATIONS[5]!;

/**
 * Menu aksi pesan pelanggan terakhir: desktop lewat tombol "⋯", HP (sentuh) dengan mengetuk
 * gelembungnya.
 */
async function openLastMessageMenu(page: Page): Promise<void> {
  const chat = page.getByRole('region', { name: 'Ruang chat' });
  if ((page.viewportSize()?.width ?? 1440) <= 640) {
    await chat.getByText('Kak, internet di rumah mati sejak pagi. Lampu LOS merah.').last().click();
  } else {
    await chat
      .getByRole('button', { name: /^Aksi untuk pesan/ })
      .last()
      .click();
  }
  await page.getByRole('menu').waitFor();
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
}

async function search(page: Page, text: string): Promise<void> {
  await page.getByRole('searchbox', { name: 'Cari chat' }).fill(text);
}

/** Tutup menu saring; fokus kembali ke tombolnya (benar), tetapi tooltip-nya jangan ikut terfoto. */
async function closeFilter(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Saring chat/ }).blur();
}

async function openFilter(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Saring chat/ }).click();
  await page.getByRole('menu').waitFor();
}

/** Gulir riwayat pesan ke atas (pesan-pesan lama: iklan, pilihan, lokasi). */
async function scrollHistoryTop(page: Page): Promise<void> {
  await page.getByRole('region', { name: 'Riwayat pesan' }).evaluate((el) => {
    el.scrollTop = 0;
  });
}

/**
 * Fase 2 butir 5: daftar percakapan (tab berhitungan, cari, saring, hitung mundur sesi) dan ruang
 * chat baca-saja. Semua memakai API tiruan + WebSocket tiruan (`mocks-inbox.ts`).
 */
export const inboxScreens: Screen[] = [
  // Daftar berisi, belum memilih chat (desktop: "Pilih chat untuk mulai membaca").
  {
    name: 'inbox-daftar',
    path: '/inbox',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Budi Santoso',
    prepare: settle,
  },
  {
    name: 'inbox-daftar-tab-dilayani',
    path: '/inbox?tab=dilayani',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Rahmat Hidayat',
    prepare: settle,
  },
  // Ruang chat baca-saja, beragam jenis pesan (posisi terbaru).
  {
    name: 'inbox-chat',
    path: CHAT,
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Info dari grup RT',
    prepare: settle,
  },
  // Riwayat digulir ke atas: iklan, pilihan daftar, lokasi, pemisah hari.
  {
    name: 'inbox-chat-awal',
    path: CHAT,
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Info dari grup RT',
    prepare: async (page) => {
      await scrollHistoryTop(page);
      await settle(page);
    },
  },
  // ── Butir 6: composer, aksi pesan, media ──
  // Menu aksi pesan (reaksi cepat + Balas) pada pesan pelanggan terakhir.
  {
    name: 'inbox-chat-menu-pesan',
    path: CHAT,
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Info dari grup RT',
    prepare: openLastMessageMenu,
  },
  // Balas-kutip: kutipan di atas composer + teks yang sedang diketik.
  {
    name: 'inbox-chat-balas',
    path: CHAT,
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Info dari grup RT',
    prepare: async (page) => {
      const chat = page.getByRole('region', { name: 'Ruang chat' });
      await openLastMessageMenu(page);
      await page.getByRole('menuitem', { name: 'Balas' }).click();
      await chat
        .getByRole('textbox', { name: 'Tulis balasan' })
        .fill('Baik kak, kami cek dari sini dulu ya. Mohon modemnya jangan dicabut.');
      await settle(page);
    },
  },
  // Lampiran dipilih: pratinjau + keterangan.
  {
    name: 'inbox-chat-lampiran',
    path: CHAT,
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Info dari grup RT',
    prepare: async (page) => {
      const chat = page.getByRole('region', { name: 'Ruang chat' });
      await chat.getByTestId('composer-file').setInputFiles({
        name: 'panduan-reset-modem.png',
        mimeType: 'image/png',
        buffer: APP_ICON,
      });
      await chat.getByRole('textbox', { name: 'Tulis balasan' }).fill('Ikuti langkah ini ya kak');
      await settle(page);
    },
  },
  // Terkirim (optimistis → pending) setelah Enter.
  {
    name: 'inbox-chat-terkirim',
    path: CHAT,
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Info dari grup RT',
    prepare: async (page) => {
      const chat = page.getByRole('region', { name: 'Ruang chat' });
      const box = chat.getByRole('textbox', { name: 'Tulis balasan' });
      await box.fill('Teknisi kami meluncur sekitar jam 2 siang ya kak.');
      // Tombol kirim (di HP Enter = baris baru).
      await chat.getByRole('button', { name: 'Kirim', exact: true }).click();
      await chat.getByRole('listitem').filter({ hasText: 'Teknisi kami meluncur' }).waitFor();
      await settle(page);
    },
  },
  // 429: pesan server + tombol kirim terkunci dengan hitung mundur; item "Belum terkirim".
  {
    name: 'inbox-chat-dibatasi',
    path: CHAT,
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page, {
        send: (route) =>
          apiError(
            route,
            429,
            'RATE_LIMITED',
            'Batas 20 pesan per menit untuk percakapan ini tercapai. Tunggu sebentar, lalu kirim lagi.',
            { 'retry-after': '42' },
          ),
      });
    },
    waitFor: 'text=Info dari grup RT',
    prepare: async (page) => {
      const chat = page.getByRole('region', { name: 'Ruang chat' });
      const box = chat.getByRole('textbox', { name: 'Tulis balasan' });
      await box.fill('Sudah kami jadwalkan ya kak.');
      await chat.getByRole('button', { name: 'Kirim', exact: true }).click();
      await chat.getByText('Pengiriman dibatasi sementara').waitFor();
      await box.blur();
      await settle(page);
    },
  },
  // Rem darurat ditarik (Owner melihatnya dari pengaturan batas kirim).
  {
    name: 'inbox-chat-rem-darurat',
    path: CHAT,
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page, { paused: true });
    },
    waitFor: 'text=Pengiriman sedang dihentikan',
    prepare: settle,
  },
  // ── Butir 7: penanganan percakapan ──
  {
    name: 'inbox-chat-tindakan',
    path: CHAT,
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Info dari grup RT',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Tindakan chat' }).click();
      await page.getByRole('menu').waitFor();
    },
  },
  {
    name: 'inbox-chat-alihkan',
    path: CHAT,
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Info dari grup RT',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Tindakan chat' }).click();
      await page.getByRole('menuitem', { name: /Tugaskan ke agen|Alihkan/ }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('radio', { name: /Citra/ }).click();
    },
  },
  // Chat milik agen lain: strip "Ditangani … · Ambil alih" di atas composer.
  {
    name: 'inbox-chat-agen-lain',
    path: `/inbox?chat=${PHOTO_CONVERSATIONS[2]!.id}`,
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Ditangani Agus',
    prepare: settle,
  },
  // Chat selesai: catatan + "Buka lagi".
  {
    name: 'inbox-chat-selesai',
    path: `/inbox?chat=${PHOTO_CONVERSATIONS[6]!.id}`,
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Chat ini sudah selesai',
    prepare: settle,
  },
  // ── Butir 9: template "/" di composer ──
  {
    name: 'inbox-chat-template',
    path: CHAT,
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Info dari grup RT',
    prepare: async (page) => {
      const chat = page.getByRole('region', { name: 'Ruang chat' });
      await chat.getByRole('textbox', { name: 'Tulis balasan' }).fill('/');
      await chat.getByRole('listbox').waitFor();
      await chat.getByRole('textbox', { name: 'Tulis balasan' }).press('ArrowDown');
    },
  },
  {
    name: 'pengaturan-template-percakapan',
    path: '/pengaturan/template-percakapan',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=/salam',
  },
  {
    name: 'pengaturan-template-percakapan-kosong',
    path: '/pengaturan/template-percakapan',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page, { quickReplies: [] });
    },
    waitFor: 'text=Belum ada template percakapan',
  },
  {
    name: 'pengaturan-template-percakapan-form',
    path: '/pengaturan/template-percakapan',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=/salam',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Ubah /gangguan' }).click();
      await page.getByRole('dialog').waitFor();
    },
  },
  // Riwayat digulir ke atas, lalu pesan masuk baru lewat WebSocket → tombol "Ada pesan baru".
  (() => {
    let socket: WebSocketRoute | undefined;
    const history = growingMessages();
    return {
      name: 'inbox-pesan-baru',
      path: CHAT,
      before: async (page: Page) => {
        await quietSecurity(page);
        await inboxMocks(page, {
          messages: history.handler,
          onSocket: (ws) => {
            socket = ws;
          },
        });
      },
      waitFor: 'text=Info dari grup RT',
      prepare: async (page: Page) => {
        await scrollHistoryTop(page);
        history.add(PHOTO_NEW_MESSAGE);
        socket?.send(
          JSON.stringify({
            type: 'message.created',
            conversationId: PHOTO_CHAT.id,
            messageId: PHOTO_NEW_MESSAGE.id,
            direction: 'inbound',
            createdAt: PHOTO_NEW_MESSAGE.createdAt,
          }),
        );
        await page.getByRole('button', { name: 'Ada pesan baru' }).waitFor();
        await settle(page);
      },
    } satisfies Screen;
  })(),
  // Desktop: panel detail disembunyikan → kolom pesan di tengah.
  {
    name: 'inbox-chat-detail-tertutup',
    path: CHAT,
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Info dari grup RT',
    prepare: async (page) => {
      const hide = page.getByRole('button', { name: 'Sembunyikan detail' });
      if (await hide.isVisible()) {
        await hide.click();
        await page.getByRole('button', { name: 'Tampilkan detail' }).waitFor();
        await page.getByRole('button', { name: 'Tampilkan detail' }).blur();
      }
      await settle(page);
    },
  },
  // HP: detail sebagai layar bertumpuk (`&detail=1`); desktop sama dengan inbox-chat.
  {
    name: 'inbox-chat-detail-hp',
    path: `${CHAT}&detail=1`,
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Nama profil WhatsApp',
    prepare: settle,
  },
  // Sesi habis + nomor tanpa nama, panel detail kontak bernama tim.
  {
    name: 'inbox-chat-sesi-habis',
    path: `/inbox?chat=${EXPIRED.id}`,
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: '[aria-label="Ruang chat"] [data-tone="expired"]',
    prepare: settle,
  },
  {
    name: 'inbox-chat-memuat',
    path: CHAT,
    waitUntil: 'domcontentloaded',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page, { messages: () => new Promise(() => undefined) });
    },
    waitFor: '[aria-busy="true"]',
  },
  {
    name: 'inbox-chat-tidak-ditemukan',
    path: '/inbox?chat=c1a2b3c4-0000-4000-8000-000000000099',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Chat tidak ditemukan',
  },
  // Inbox benar-benar kosong (beda dengan "belum memilih chat").
  {
    name: 'inbox-kosong-total',
    path: '/inbox',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page, {
        conversations: [],
        counts: { counts: { all: 0, bot: 0, unserved: 0, served: 0, resolved: 0 }, unreadOpen: 0 },
      });
    },
    waitFor: 'text=/Belum ada chat|Inbox masih kosong/',
  },
  // Agen (CS): tanpa tombol sambungkan nomor; kosong.
  {
    name: 'inbox-kosong-cs',
    path: '/inbox',
    before: async (page) => {
      await sessionAs(page, 'cs');
      await inboxMocks(page, {
        conversations: [],
        counts: { counts: { all: 0, bot: 0, unserved: 0, served: 0, resolved: 0 }, unreadOpen: 0 },
      });
    },
    waitFor: 'text=/Belum ada chat|Inbox masih kosong/',
  },
  {
    name: 'inbox-cari-hasil',
    path: '/inbox',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Budi Santoso',
    prepare: async (page) => {
      await search(page, 'dewi');
      await page.getByText('Dewi Lestari').first().waitFor();
      await page.getByText('Budi Santoso').waitFor({ state: 'detached' });
    },
  },
  {
    name: 'inbox-cari-satu-huruf',
    path: '/inbox',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Budi Santoso',
    prepare: async (page) => {
      await search(page, 'b');
      await page.getByText('Ketik minimal 2 huruf').waitFor();
    },
  },
  {
    name: 'inbox-cari-dibatasi',
    path: '/inbox',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page, {
        search: (route) =>
          apiError(
            route,
            429,
            'RATE_LIMITED',
            'Terlalu banyak pencarian dalam waktu singkat. Tunggu sebentar, lalu coba lagi.',
            { 'retry-after': '42' },
          ),
      });
    },
    waitFor: 'text=Budi Santoso',
    prepare: async (page) => {
      await search(page, 'budi');
      await page.getByText('Pencarian dibatasi sementara').waitFor();
    },
  },
  {
    name: 'inbox-cari-terlalu-lama',
    path: '/inbox',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page, {
        search: (route) =>
          apiError(
            route,
            503,
            'SERVICE_UNAVAILABLE',
            'Pencarian terlalu lama. Persempit kata kuncinya lalu coba lagi.',
          ),
      });
    },
    waitFor: 'text=Budi Santoso',
    prepare: async (page) => {
      await search(page, '08');
      await page.getByText('Pencarian terlalu lama', { exact: true }).waitFor();
    },
  },
  // Menu saring terbuka.
  {
    name: 'inbox-saring-menu',
    path: '/inbox',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Budi Santoso',
    prepare: openFilter,
  },
  // Saringan "Hampir habis" aktif (label yang bisa dihapus + daftar tersaring).
  {
    name: 'inbox-saring-hampir-habis',
    path: '/inbox',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Budi Santoso',
    prepare: async (page) => {
      await openFilter(page);
      await page.getByRole('menuitemradio', { name: 'Hampir habis' }).click();
      await closeFilter(page);
      await page.getByRole('list', { name: 'Saringan aktif' }).waitFor();
      await page.getByText('Budi Santoso').waitFor({ state: 'detached' });
      await settle(page);
    },
  },
  {
    name: 'inbox-saring-tanpa-hasil',
    path: '/inbox?tab=bot',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
    },
    waitFor: 'text=Kopi Senja',
    prepare: async (page) => {
      await openFilter(page);
      await page.getByRole('menuitemradio', { name: 'Kedaluwarsa' }).click();
      await closeFilter(page);
      await page.getByText('Tidak ada chat yang cocok').waitFor();
      await settle(page);
    },
  },
  {
    name: 'inbox-daftar-gagal',
    path: '/inbox',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page, {
        list: (route) =>
          apiError(
            route,
            500,
            'INTERNAL_ERROR',
            'Terjadi kesalahan di server. Coba lagi beberapa saat lagi.',
          ),
      });
    },
    waitFor: 'text=Daftar chat belum bisa dimuat',
  },
  {
    name: 'inbox-daftar-memuat',
    path: '/inbox',
    waitUntil: 'domcontentloaded',
    before: async (page) => {
      await quietSecurity(page);
      await inboxMocks(page);
      await page.route(/\/api\/v1\/conversations\?/, () => undefined);
    },
    waitFor: '[aria-busy="true"]',
  },
];
