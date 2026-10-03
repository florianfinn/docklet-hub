-- better-auth 1.7.3+ identifies accounts by providerId and accountId again and
-- never writes "issuer"; the NOT NULL column from 002 would reject every insert.
--
-- 002 never created the upstream unique index on (issuer, accountId), so the
-- column can be dropped directly, also on tables that already hold rows.

ALTER TABLE "account" DROP COLUMN "issuer";
