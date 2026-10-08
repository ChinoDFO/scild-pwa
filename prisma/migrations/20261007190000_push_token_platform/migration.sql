-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('WEB', 'ANDROID');

-- AlterTable
ALTER TABLE "PushToken" ADD COLUMN     "platform" "PushPlatform" NOT NULL DEFAULT 'WEB';
