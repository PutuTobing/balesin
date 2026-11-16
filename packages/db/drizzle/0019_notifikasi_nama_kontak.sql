-- Review notifikasi push R1: nama kontak di notifikasi diatur Owner per organisasi, bawaan MATI.
ALTER TABLE "organizations" ADD COLUMN "notification_contact_name" boolean DEFAULT false NOT NULL;