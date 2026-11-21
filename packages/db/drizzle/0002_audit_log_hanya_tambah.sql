-- Audit log hanya-tambah di tingkat database (SECURITY.md §10, catatan F.16 review Fase 0):
-- baris audit tidak bisa diubah, dihapus, atau dikosongkan — juga bila ada bug di aplikasi.
-- Migrasi khusus (`drizzle-kit generate --custom`): Drizzle tidak memodelkan trigger.
CREATE FUNCTION "audit_logs_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs hanya-tambah: % tidak diizinkan', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_logs_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "audit_logs_reject_change"();
--> statement-breakpoint
CREATE TRIGGER "audit_logs_no_truncate"
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_logs_reject_change"();
