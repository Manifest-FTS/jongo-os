-- SSH public keys allowed to log in to an SFTP account.
ALTER TABLE "SftpAccount" ADD COLUMN "publicKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];
