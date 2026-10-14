/*
  Warnings:

  - A unique constraint covering the columns `[paystackRef]` on the table `engagements` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PENDING', 'PAID', 'RELEASED', 'FAILED');

-- AlterTable
ALTER TABLE "engagements" ADD COLUMN     "feeAmount" INTEGER,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
ADD COLUMN     "paystackRef" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "engagements_paystackRef_key" ON "engagements"("paystackRef");
